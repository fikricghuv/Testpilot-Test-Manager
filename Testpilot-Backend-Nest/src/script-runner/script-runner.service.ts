import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { DatabaseService } from "../database/database.service";
import { LegacyService, isUuid } from "../legacy/legacy.service";
import { StorageService } from "../storage/storage.service";
import {
  MAX_SCRIPT_CONTENT_LENGTH,
  MAX_SCRIPT_OUTPUT_LENGTH,
  SCRIPT_EXECUTION_TIMEOUT_MS,
  SCRIPT_FRAMEWORKS,
  SCRIPT_RUNNER_JOB,
  SCRIPT_RUNNER_QUEUE,
  SCRIPT_SOURCES,
  SCRIPT_STATUSES
} from "./script-runner.constants";
import type {
  ScriptFramework,
  ScriptRunnerJobPayload,
  ScriptSource,
  ScriptStatus,
  TestScriptRecord,
  TestScriptRunRecord,
  TestScriptStateResponse,
  TestScriptVersionRecord,
  TriggerScriptRunInput,
  UpsertTestScriptInput
} from "./script-runner.types";

const execFileAsync = promisify(execFile);

function truncateOutput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_SCRIPT_OUTPUT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SCRIPT_OUTPUT_LENGTH)}\n...[truncated]`;
}

function validateTargetUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new BadRequestException({ error: "targetUrl must be a string." });
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException({ error: "targetUrl must be a valid http or https URL." });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException({ error: "targetUrl must use http or https." });
  }
  return parsed.toString();
}

function mapScriptRow(row: Record<string, any>): TestScriptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    testcaseId: row.testcase_id,
    framework: row.framework,
    targetUrl: row.target_url ?? null,
    status: row.status,
    activeVersionId: row.active_version_id ?? null,
    activeVersion: row.active_version ?? null,
    scriptContent: row.script_content ?? null,
    source: row.source ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function mapVersionRow(row: Record<string, any>): TestScriptVersionRecord {
  return {
    id: row.id,
    scriptId: row.script_id,
    version: Number(row.version),
    scriptContent: row.script_content,
    source: row.source,
    notes: row.notes ?? null,
    verifiedLocators: (row.verified_locators && typeof row.verified_locators === "object") ? row.verified_locators : {},
    createdBy: row.created_by ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function mapRunRow(row: Record<string, any>): TestScriptRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    testcaseId: row.testcase_id,
    scriptId: row.script_id,
    versionId: row.version_id ?? null,
    cycleId: row.cycle_id ?? null,
    executionId: row.execution_id ?? null,
    status: row.status,
    targetUrl: row.target_url ?? null,
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    stdout: row.stdout ?? null,
    stderr: row.stderr ?? null,
    errorMessage: row.error_message ?? null,
    triggeredBy: row.triggered_by ?? null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ?? null,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

@Injectable()
export class ScriptRunnerService {
  private readonly logger = new Logger(ScriptRunnerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly legacy: LegacyService,
    private readonly storage: StorageService,
    @InjectQueue(SCRIPT_RUNNER_QUEUE) private readonly queue: Queue<ScriptRunnerJobPayload>
  ) {}

  private async assertTestCaseInProject(projectId: string, testcaseId: string): Promise<{ id: string; title: string; externalId: string | null }> {
    if (!isUuid(projectId) || !isUuid(testcaseId)) {
      throw new BadRequestException({ error: "Invalid projectId or testcaseId." });
    }
    const res = await this.db.query<{ id: string; title: string; external_id: string | null }>(
      `SELECT id, title, external_id FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [testcaseId, projectId]
    );
    const tc = res.rows[0];
    if (!tc) {
      throw new NotFoundException({ error: "Test case not found in this project." });
    }
    return { id: tc.id, title: tc.title, externalId: tc.external_id };
  }

  private async readState(projectId: string, testcaseId: string): Promise<TestScriptStateResponse> {
    const scriptRes = await this.db.query(
      `SELECT s.*, v.version AS active_version, v.script_content, v.source
       FROM test_scripts s
       LEFT JOIN test_script_versions v ON v.id = s.active_version_id
       WHERE s.project_id = $1 AND s.testcase_id = $2 AND s.framework = 'playwright-ts'
       LIMIT 1`,
      [projectId, testcaseId]
    );
    const scriptRow = scriptRes.rows[0];
    if (!scriptRow) {
      return { script: null, versions: [], recentRuns: [] };
    }

    const [versionsRes, runsRes] = await Promise.all([
      this.db.query(
        `SELECT * FROM test_script_versions WHERE script_id = $1 ORDER BY version DESC LIMIT 20`,
        [scriptRow.id]
      ),
      this.db.query(
        `SELECT * FROM test_script_runs WHERE script_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [scriptRow.id]
      )
    ]);

    return {
      script: mapScriptRow(scriptRow),
      versions: versionsRes.rows.map(mapVersionRow),
      recentRuns: runsRes.rows.map(mapRunRow)
    };
  }

  async getScript(userId: string | null | undefined, projectId: string, testcaseId: string): Promise<TestScriptStateResponse> {
    await this.legacy.requireProjectAccess(userId, projectId);
    await this.assertTestCaseInProject(projectId, testcaseId);
    return this.readState(projectId, testcaseId);
  }

  async upsertScript(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    input: UpsertTestScriptInput
  ): Promise<TestScriptStateResponse> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const tc = await this.assertTestCaseInProject(projectId, testcaseId);

    const scriptContent = typeof input.scriptContent === "string" ? input.scriptContent : "";
    if (!scriptContent.trim()) {
      throw new BadRequestException({ error: "scriptContent cannot be empty." });
    }
    if (scriptContent.length > MAX_SCRIPT_CONTENT_LENGTH) {
      throw new BadRequestException({ error: `scriptContent exceeds ${MAX_SCRIPT_CONTENT_LENGTH} characters.` });
    }

    const framework: ScriptFramework = input.framework ?? "playwright-ts";
    if (!SCRIPT_FRAMEWORKS.includes(framework)) {
      throw new BadRequestException({ error: `Unsupported framework: ${String(framework)}` });
    }

    const status: ScriptStatus = input.status ?? "draft";
    if (!SCRIPT_STATUSES.includes(status)) {
      throw new BadRequestException({ error: `Unsupported status: ${String(status)}` });
    }

    const source: ScriptSource = input.source ?? "manual";
    if (!SCRIPT_SOURCES.includes(source)) {
      throw new BadRequestException({ error: `Unsupported source: ${String(source)}` });
    }

    const targetUrl = validateTargetUrl(input.targetUrl);
    const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 500) : null;

    await this.db.transaction(async (client) => {
      const existingRes = await client.query<{ id: string }>(
        `SELECT id FROM test_scripts WHERE testcase_id = $1 AND framework = $2 FOR UPDATE`,
        [testcaseId, framework]
      );

      let scriptId = existingRes.rows[0]?.id;
      if (!scriptId) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO test_scripts (project_id, testcase_id, framework, target_url, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING id`,
          [projectId, testcaseId, framework, targetUrl, status, uid]
        );
        scriptId = inserted.rows[0].id;
      }

      const maxVerRes = await client.query<{ max_ver: number }>(
        `SELECT COALESCE(MAX(version), 0)::int AS max_ver FROM test_script_versions WHERE script_id = $1`,
        [scriptId]
      );
      const nextVersion = (maxVerRes.rows[0]?.max_ver ?? 0) + 1;

      const verRes = await client.query<{ id: string }>(
        `INSERT INTO test_script_versions (script_id, version, script_content, source, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [scriptId, nextVersion, scriptContent, source, notes, uid]
      );
      const versionId = verRes.rows[0].id;

      await client.query(
        `UPDATE test_scripts
         SET active_version_id = $2,
             target_url = $3,
             status = $4,
             updated_by = $5,
             updated_at = now()
         WHERE id = $1`,
        [scriptId, versionId, targetUrl, status, uid]
      );
    });

    await this.legacy.logProjectActivity(
      projectId,
      uid,
      "updated_automation_script",
      "testcase",
      testcaseId,
      tc.title,
      { framework, status, source }
    );

    return this.readState(projectId, testcaseId);
  }

  async activateVersion(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    versionId: string
  ): Promise<TestScriptStateResponse> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    await this.assertTestCaseInProject(projectId, testcaseId);
    if (!isUuid(versionId)) {
      throw new BadRequestException({ error: "Invalid versionId." });
    }

    const res = await this.db.query<{ script_id: string }>(
      `SELECT v.script_id
       FROM test_script_versions v
       JOIN test_scripts s ON s.id = v.script_id
       WHERE v.id = $1 AND s.project_id = $2 AND s.testcase_id = $3
       LIMIT 1`,
      [versionId, projectId, testcaseId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({ error: "Script version not found." });
    }

    await this.db.query(
      `UPDATE test_scripts SET active_version_id = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
      [row.script_id, versionId, uid]
    );

    return this.readState(projectId, testcaseId);
  }

  async deleteVersion(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    versionId: string
  ): Promise<TestScriptStateResponse> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    await this.assertTestCaseInProject(projectId, testcaseId);
    if (!isUuid(versionId)) {
      throw new BadRequestException({ error: "Invalid versionId." });
    }

    await this.db.transaction(async (client) => {
      const targetRes = await client.query<{ script_id: string; active_version_id: string | null }>(
        `SELECT s.id AS script_id, s.active_version_id
         FROM test_script_versions v
         JOIN test_scripts s ON s.id = v.script_id
         WHERE v.id = $1 AND s.project_id = $2 AND s.testcase_id = $3
         FOR UPDATE OF s`,
        [versionId, projectId, testcaseId]
      );
      const target = targetRes.rows[0];
      if (!target) {
        throw new NotFoundException({ error: "Script version not found." });
      }

      await client.query(`DELETE FROM test_script_versions WHERE id = $1`, [versionId]);

      const remainingRes = await client.query<{ id: string }>(
        `SELECT id FROM test_script_versions WHERE script_id = $1 ORDER BY version DESC LIMIT 1`,
        [target.script_id]
      );
      const nextActive = remainingRes.rows[0]?.id ?? null;

      if (!nextActive) {
        await client.query(`DELETE FROM test_scripts WHERE id = $1`, [target.script_id]);
      } else if (target.active_version_id === versionId) {
        await client.query(
          `UPDATE test_scripts SET active_version_id = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
          [target.script_id, nextActive, uid]
        );
      }
    });

    return this.readState(projectId, testcaseId);
  }

  async deleteScript(userId: string | null | undefined, projectId: string, testcaseId: string): Promise<{ deleted: boolean }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    await this.assertTestCaseInProject(projectId, testcaseId);

    const res = await this.db.query(
      `DELETE FROM test_scripts WHERE project_id = $1 AND testcase_id = $2`,
      [projectId, testcaseId]
    );
    return { deleted: (res.rowCount ?? 0) > 0 };
  }

  async triggerRun(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    input: TriggerScriptRunInput = {}
  ): Promise<{ run: TestScriptRunRecord }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const tc = await this.assertTestCaseInProject(projectId, testcaseId);

    const scriptRes = await this.db.query<{ id: string; active_version_id: string | null; target_url: string | null }>(
      `SELECT id, active_version_id, target_url
       FROM test_scripts
       WHERE project_id = $1 AND testcase_id = $2 AND framework = 'playwright-ts'
       LIMIT 1`,
      [projectId, testcaseId]
    );
    const script = scriptRes.rows[0];
    if (!script || !script.active_version_id) {
      throw new BadRequestException({ error: "Save a Playwright script before running it." });
    }

    const overrideUrl = validateTargetUrl(input.targetUrl);
    const effectiveTargetUrl = overrideUrl ?? script.target_url ?? null;

    const runRow = await this.db.transaction(async (client) => {
      const cycleName = `Script Run: ${tc.externalId || tc.title}`.slice(0, 255);
      const cycleRes = await client.query<{ id: string }>(
        `INSERT INTO cycles (project_id, name, owner_id, status, started_at, source, triggered_by)
         VALUES ($1, $2, $3, 'In Progress', now(), 'automation', 'local')
         RETURNING id`,
        [projectId, cycleName, uid]
      );
      const cycleId = cycleRes.rows[0].id;

      const cycleItemRes = await client.query<{ id: string }>(
        `INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title, position) VALUES ($1, $2, $3, 1) RETURNING id`,
        [cycleId, testcaseId, tc.title]
      );
      const cycleItemId = cycleItemRes.rows[0].id;

      const execRes = await client.query<{ id: string }>(
        `INSERT INTO executions (cycle_item_id, status, reported_by, executed_by)
         VALUES ($1, 'Untested', 'automation', $2)
         RETURNING id`,
        [cycleItemId, uid]
      );
      const executionId = execRes.rows[0].id;

      const insertedRun = await client.query(
        `INSERT INTO test_script_runs (
           project_id, testcase_id, script_id, version_id, cycle_id, execution_id,
           status, target_url, triggered_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
         RETURNING *`,
        [projectId, testcaseId, script.id, script.active_version_id, cycleId, executionId, effectiveTargetUrl, uid]
      );
      return insertedRun.rows[0];
    });

    await this.queue.add(
      SCRIPT_RUNNER_JOB,
      { runId: runRow.id },
      { removeOnComplete: 50, removeOnFail: 50 }
    );

    return { run: mapRunRow(runRow) };
  }

  async getRun(userId: string | null | undefined, projectId: string, testcaseId: string, runId: string): Promise<{ run: TestScriptRunRecord }> {
    await this.legacy.requireProjectAccess(userId, projectId);
    await this.assertTestCaseInProject(projectId, testcaseId);
    if (!isUuid(runId)) {
      throw new BadRequestException({ error: "Invalid runId." });
    }

    const res = await this.db.query(
      `SELECT * FROM test_script_runs WHERE id = $1 AND project_id = $2 AND testcase_id = $3 LIMIT 1`,
      [runId, projectId, testcaseId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({ error: "Script run not found." });
    }
    return { run: mapRunRow(row) };
  }

  /**
   * Executes a queued Playwright script in an isolated temporary directory and persists
   * the verdict back into test_script_runs, executions, and cycles.
   */
  async executeRunJob(runId: string): Promise<void> {
    const runRes = await this.db.query<{
      id: string;
      project_id: string;
      cycle_id: string | null;
      execution_id: string | null;
      target_url: string | null;
      triggered_by: string | null;
      script_content: string | null;
    }>(
      `SELECT r.id, r.project_id, r.cycle_id, r.execution_id, r.target_url, r.triggered_by, v.script_content
       FROM test_script_runs r
       LEFT JOIN test_script_versions v ON v.id = r.version_id
       WHERE r.id = $1
       LIMIT 1`,
      [runId]
    );
    const jobData = runRes.rows[0];
    if (!jobData) {
      this.logger.warn(`Script run ${runId} not found, skipping.`);
      return;
    }

    await this.db.query(
      `UPDATE test_script_runs SET status = 'running', started_at = now() WHERE id = $1`,
      [runId]
    );

    if (!jobData.script_content?.trim()) {
      await this.finalizeRun(runId, jobData.cycle_id, jobData.execution_id, {
        status: "error",
        durationMs: 0,
        stdout: null,
        stderr: null,
        errorMessage: "No script content found for this version."
      });
      return;
    }

    const startedAt = Date.now();
    let tempDir: string | null = null;
    let resultsDir: string | null = null;

    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "testpilot-pw-"));
      resultsDir = path.join(tempDir, "test-results");
      const specPath = path.join(tempDir, "test.spec.ts");
      const configPath = path.join(tempDir, "playwright.config.ts");

      const baseUrlLine = jobData.target_url ? `baseURL: ${JSON.stringify(jobData.target_url)},` : "";
      const configContent = [
        `import { defineConfig } from "@playwright/test";`,
        `export default defineConfig({`,
        `  testDir: ".",`,
        `  outputDir: ${JSON.stringify(resultsDir)},`,
        `  timeout: ${SCRIPT_EXECUTION_TIMEOUT_MS},`,
        `  reporter: [["list"]],`,
        `  use: { headless: true, ${baseUrlLine} screenshot: "on", trace: "on" }`,
        `});`
      ].join("\n");

      await fs.writeFile(configPath, configContent, "utf8");
      await fs.writeFile(specPath, jobData.script_content, "utf8");

      const playwrightBin = path.join(process.cwd(), "node_modules", ".bin", "playwright");
      const nodeModulesDir = path.join(process.cwd(), "node_modules");
      const { stdout, stderr } = await execFileAsync(
        playwrightBin,
        ["test", "test.spec.ts", "--config", "playwright.config.ts"],
        {
          cwd: tempDir,
          timeout: SCRIPT_EXECUTION_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024,
          env: {
            ...process.env,
            NODE_PATH: process.env.NODE_PATH ? `${nodeModulesDir}${path.delimiter}${process.env.NODE_PATH}` : nodeModulesDir
          }
        }
      );

      await this.collectAndStoreEvidence(resultsDir, jobData.project_id, jobData.execution_id, jobData.triggered_by);

      await this.finalizeRun(runId, jobData.cycle_id, jobData.execution_id, {
        status: "passed",
        durationMs: Date.now() - startedAt,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        errorMessage: null
      });
    } catch (err) {
      const execErr = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const isTestFailure = typeof execErr.code === "number" && execErr.code === 1;
      const status = isTestFailure ? "failed" : "error";
      const errorMessage =
        truncateOutput(execErr.stderr) ||
        truncateOutput(execErr.message) ||
        "Playwright execution failed.";

      if (resultsDir) {
        await this.collectAndStoreEvidence(resultsDir, jobData.project_id, jobData.execution_id, jobData.triggered_by);
      }

      await this.finalizeRun(runId, jobData.cycle_id, jobData.execution_id, {
        status,
        durationMs: Date.now() - startedAt,
        stdout: truncateOutput(execErr.stdout),
        stderr: truncateOutput(execErr.stderr),
        errorMessage
      });
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async findFilesByExt(dir: string, ext: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.findFilesByExt(fullPath, ext)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private extractZipEntries(zipBuffer: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    // Locate End of Central Directory (EOCD) signature 0x06054b50 from the tail
    let eocdOffset = -1;
    const minOffset = Math.max(0, zipBuffer.length - 65557);
    for (let i = zipBuffer.length - 22; i >= minOffset; i--) {
      if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return files;

    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    let offset = zipBuffer.readUInt32LE(eocdOffset + 16);

    for (let idx = 0; idx < totalEntries && offset + 46 <= zipBuffer.length; idx++) {
      if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break;
      const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
      const compressedSize = zipBuffer.readUInt32LE(offset + 20);
      const nameLen = zipBuffer.readUInt16LE(offset + 28);
      const extraLen = zipBuffer.readUInt16LE(offset + 30);
      const commentLen = zipBuffer.readUInt16LE(offset + 32);
      const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
      const fileName = zipBuffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
      offset += 46 + nameLen + extraLen + commentLen;

      if (localHeaderOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        continue;
      }
      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        files.set(fileName, compressed);
      } else if (compressionMethod === 8) {
        files.set(fileName, zlib.inflateRawSync(compressed));
      }
    }
    return files;
  }

  extractApiResponseEvidence(zipBuffer: Buffer): {
    calls: Array<{
      method: string;
      url: string;
      status: number | null;
      statusText: string | null;
      durationMs: number | null;
      request: { headers: Array<[string, string]>; body: string | null };
      response: { headers: Array<[string, string]>; body: string | null };
    }>;
  } | null {
    const entriesMap = this.extractZipEntries(zipBuffer);
    const calls: Array<{
      method: string;
      url: string;
      status: number | null;
      statusText: string | null;
      durationMs: number | null;
      request: { headers: Array<[string, string]>; body: string | null };
      response: { headers: Array<[string, string]>; body: string | null };
    }> = [];

    for (const [name, buf] of entriesMap.entries()) {
      if (!name.endsWith(".network")) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type !== "resource-snapshot" || !parsed.snapshot) continue;
          const snap = parsed.snapshot;
          const resFile = snap.response?.content?._file;
          let responseBody: string | null =
            typeof snap.response?.content?.text === "string" ? snap.response.content.text : null;
          if (typeof resFile === "string" && entriesMap.has(resFile)) {
            responseBody = entriesMap.get(resFile)!.toString("utf8");
          }
          if (responseBody && responseBody.length > MAX_SCRIPT_OUTPUT_LENGTH) {
            responseBody = `${responseBody.slice(0, MAX_SCRIPT_OUTPUT_LENGTH)}\n...[truncated]`;
          }

          calls.push({
            method: String(snap.request?.method || "GET"),
            url: String(snap.request?.url || ""),
            status: typeof snap.response?.status === "number" ? snap.response.status : null,
            statusText: typeof snap.response?.statusText === "string" ? snap.response.statusText : null,
            durationMs: typeof snap.time === "number" ? Math.round(snap.time) : null,
            request: { headers: [], body: null },
            response: { headers: [], body: responseBody }
          });
        } catch {
          // Ignore malformed trace line
        }
      }
    }

    return calls.length > 0 ? { calls } : null;
  }

  private async storeAttachment(
    projectId: string,
    executionId: string,
    uploadedBy: string | null,
    fileName: string,
    ext: string,
    contentType: string,
    evidenceKind: "screenshot" | "api" | "trace",
    buffer: Buffer
  ): Promise<void> {
    const storageKey = `executions/${projectId}/${executionId}/${randomUUID()}.${ext}`;
    await this.storage.put(storageKey, buffer, contentType);
    await this.db.query(
      `INSERT INTO attachments
         (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by, evidence_kind)
       VALUES ($1, 'execution', $2, $3, $4, $5, $6, $7, $8)`,
      [projectId, executionId, fileName, contentType, buffer.length, storageKey, uploadedBy, evidenceKind]
    );
  }

  private async collectAndStoreEvidence(
    resultsDir: string,
    projectId: string,
    executionId: string | null,
    uploadedBy: string | null
  ): Promise<void> {
    if (!executionId) return;
    try {
      const pngPaths = await this.findFilesByExt(resultsDir, ".png");
      if (pngPaths.length > 0) {
        // Web UI runs already have screenshots — keep evidence focused on those.
        for (let i = 0; i < pngPaths.length; i++) {
          const buffer = await fs.readFile(pngPaths[i]);
          const fileName = pngPaths.length === 1 ? "screenshot.png" : `screenshot-${i + 1}.png`;
          await this.storeAttachment(projectId, executionId, uploadedBy, fileName, "png", "image/png", "screenshot", buffer);
        }
        return;
      }

      // API-only runs (no browser screenshots): store compact response-only JSON evidence.
      const tracePaths = await this.findFilesByExt(resultsDir, ".zip");
      for (let i = 0; i < tracePaths.length; i++) {
        const zipBuffer = await fs.readFile(tracePaths[i]);
        const apiEvidence = this.extractApiResponseEvidence(zipBuffer);
        if (apiEvidence) {
          const apiFileName = tracePaths.length === 1 ? "api-response.json" : `api-response-${i + 1}.json`;
          await this.storeAttachment(
            projectId,
            executionId,
            uploadedBy,
            apiFileName,
            "json",
            "application/json",
            "api",
            Buffer.from(JSON.stringify(apiEvidence), "utf8")
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to store evidence for execution ${executionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async finalizeRun(
    runId: string,
    cycleId: string | null,
    executionId: string | null,
    outcome: {
      status: "passed" | "failed" | "error";
      durationMs: number;
      stdout: string | null;
      stderr: string | null;
      errorMessage: string | null;
    }
  ): Promise<void> {
    const executionStatus = outcome.status === "passed" ? "Passed" : "Failed";

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE test_script_runs
         SET status = $2,
             duration_ms = $3,
             stdout = $4,
             stderr = $5,
             error_message = $6,
             finished_at = now()
         WHERE id = $1`,
        [runId, outcome.status, outcome.durationMs, outcome.stdout, outcome.stderr, outcome.errorMessage]
      );

      if (executionId) {
        await client.query(
          `UPDATE executions
           SET status = $2,
               duration_ms = $3,
               error_message = $4,
               executed_at = now()
           WHERE id = $1`,
          [executionId, executionStatus, outcome.durationMs, outcome.errorMessage]
        );
      }

      if (cycleId) {
        await client.query(
          `UPDATE cycles
           SET status = 'Completed',
               closed_at = now(),
               close_status = 'completed',
               last_result_at = now()
           WHERE id = $1`,
          [cycleId]
        );
      }
    });
  }
}
