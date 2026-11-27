import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { chromium } from "playwright";
import { ApiTokenService } from "../auth/api-token.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService, isUuid } from "../legacy/legacy.service";
import { StorageService } from "../storage/storage.service";
import {
  MAX_SCRIPT_CONTENT_LENGTH,
  MAX_SCRIPT_OUTPUT_LENGTH,
  SCRIPT_BROWSERS,
  SCRIPT_EXECUTION_TIMEOUT_MS,
  SCRIPT_FRAMEWORKS,
  SCRIPT_RUNNER_JOB,
  SCRIPT_RUNNER_QUEUE,
  SCRIPT_SOURCES,
  SCRIPT_STATUSES
} from "./script-runner.constants";
import type {
  RecordHeadedRunInput,
  RecorderSessionResponse,
  ScriptBrowser,
  ScriptFramework,
  ScriptRunnerJobPayload,
  ScriptSource,
  ScriptStatus,
  SuiteRunResponse,
  TestScriptRecord,
  TestScriptRunRecord,
  TestScriptStateResponse,
  TestScriptVersionRecord,
  TriggerScriptRunInput,
  TriggerSuiteRunInput,
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

function normalizeBrowser(raw: unknown): ScriptBrowser {
  if (raw === undefined || raw === null || raw === "") return "chromium";
  const val = String(raw).trim().toLowerCase() as ScriptBrowser;
  if (!SCRIPT_BROWSERS.includes(val)) {
    throw new BadRequestException({ error: `Unsupported browser: ${String(raw)}. Use chromium, firefox, webkit, or all.` });
  }
  return val;
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
    @InjectQueue(SCRIPT_RUNNER_QUEUE) private readonly queue: Queue<ScriptRunnerJobPayload>,
    @Optional() private readonly apiTokens?: ApiTokenService
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
    const verifiedLocators: Record<string, string> = {};
    if (input.verifiedLocators && typeof input.verifiedLocators === "object" && !Array.isArray(input.verifiedLocators)) {
      let count = 0;
      for (const [key, val] of Object.entries(input.verifiedLocators)) {
        if (count >= 200) break;
        if (typeof key === "string" && typeof val === "string" && key.trim() && val.trim()) {
          verifiedLocators[key.trim().slice(0, 200)] = val.trim().slice(0, 500);
          count += 1;
        }
      }
    }

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
        `INSERT INTO test_script_versions (script_id, version, script_content, source, notes, verified_locators, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [scriptId, nextVersion, scriptContent, source, notes, JSON.stringify(verifiedLocators), uid]
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

  async issueRecorderSession(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string
  ): Promise<RecorderSessionResponse> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const tc = await this.assertTestCaseInProject(projectId, testcaseId);

    if (!this.apiTokens) {
      throw new ServiceUnavailableException({ error: "Recorder token service is unavailable." });
    }

    // Reclaim any prior recorder tokens for this user+project so repeated sessions never exhaust the project cap.
    await this.db.query(
      `DELETE FROM api_tokens WHERE project_id = $1::uuid AND user_id = $2::uuid AND name LIKE 'recorder:%'`,
      [projectId, uid]
    );

    const tokenLabel = `recorder:${tc.externalId || testcaseId.slice(0, 8)}`;
    const issued = await this.apiTokens.issueToken(uid, projectId, tokenLabel, ["read", "write"], 1);

    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      projectId,
      testcaseId,
      testcaseTitle: tc.title,
      testcaseExternalId: tc.externalId
    };
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
    const browser = normalizeBrowser(input.browser);

    const runRow = await this.db.transaction(async (client) => {
      const browserTag = browser !== "chromium" ? ` [${browser}]` : "";
      const cycleName = `Script Run: ${tc.externalId || tc.title}${browserTag}`.slice(0, 255);
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
      { runId: runRow.id, browser },
      { removeOnComplete: 50, removeOnFail: 50 }
    );

    return { run: mapRunRow(runRow) };
  }

  /**
   * Records the result of a headed Chrome Extension run so it produces a Test Run (cycle),
   * execution record, optional screenshot evidence, and downloadable report just like headless runs.
   */
  async recordHeadedRun(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    input: RecordHeadedRunInput
  ): Promise<{ run: TestScriptRunRecord | null; cycleId: string; executionId: string }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const tc = await this.assertTestCaseInProject(projectId, testcaseId);

    const status = input.status === "passed" || input.status === "failed" || input.status === "error"
      ? input.status
      : "failed";
    const execStatus = status === "passed" ? "Pass" : "Fail";
    const effectiveTargetUrl = validateTargetUrl(input.targetUrl) ?? null;
    const durationMs =
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? Math.round(input.durationMs)
        : null;
    const stdout = typeof input.stdout === "string" ? input.stdout.slice(0, 16_000) : null;
    const stderr = typeof input.stderr === "string" ? input.stderr.slice(0, 16_000) : null;
    const errorMessage = typeof input.errorMessage === "string" ? input.errorMessage.slice(0, 8_000) : null;

    const scriptRes = await this.db.query<{ id: string; active_version_id: string | null }>(
      `SELECT id, active_version_id
       FROM test_scripts
       WHERE project_id = $1 AND testcase_id = $2 AND framework = 'playwright-ts'
       LIMIT 1`,
      [projectId, testcaseId]
    );
    const script = scriptRes.rows[0] || null;

    const result = await this.db.transaction(async (client) => {
      const cycleName = `Headed Run: ${tc.externalId || tc.title}`.slice(0, 255);
      const cycleRes = await client.query<{ id: string }>(
        `INSERT INTO cycles (project_id, name, owner_id, status, started_at, completed_at, source, triggered_by)
         VALUES ($1, $2, $3, 'Completed', now(), now(), 'automation', 'local')
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
        `INSERT INTO executions (cycle_item_id, status, reported_by, executed_by, duration_ms, error_message)
         VALUES ($1, $2, 'automation', $3, $4, $5)
         RETURNING id`,
        [cycleItemId, execStatus, uid, durationMs, errorMessage]
      );
      const executionId = execRes.rows[0].id;

      let runRow: Record<string, any> | null = null;
      if (script) {
        const insertedRun = await client.query(
          `INSERT INTO test_script_runs (
             project_id, testcase_id, script_id, version_id, cycle_id, execution_id,
             status, target_url, duration_ms, stdout, stderr, error_message,
             triggered_by, started_at, finished_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
           RETURNING *`,
          [
            projectId,
            testcaseId,
            script.id,
            script.active_version_id,
            cycleId,
            executionId,
            status,
            effectiveTargetUrl,
            durationMs,
            stdout,
            stderr,
            errorMessage,
            uid
          ]
        );
        runRow = insertedRun.rows[0];
      }

      return { cycleId, executionId, runRow };
    });

    if (typeof input.screenshotDataUrl === "string") {
      const match = input.screenshotDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/);
      if (match) {
        const ext = match[1] === "png" ? "png" : "jpg";
        const contentType = ext === "png" ? "image/png" : "image/jpeg";
        const buffer = Buffer.from(match[2], "base64");
        if (buffer.length > 0 && buffer.length <= 5 * 1024 * 1024) {
          await this.storeAttachment(
            projectId,
            result.executionId,
            uid,
            `headed-screenshot.${ext}`,
            ext,
            contentType,
            "screenshot",
            buffer
          ).catch((err) => {
            this.logger.warn(`Failed to store headed screenshot: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    }

    return {
      run: result.runRow ? mapRunRow(result.runRow) : null,
      cycleId: result.cycleId,
      executionId: result.executionId
    };
  }

  async triggerSuiteRun(
    userId: string | null | undefined,
    projectId: string,
    suiteId: string,
    input: TriggerSuiteRunInput = {}
  ): Promise<SuiteRunResponse> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    if (!isUuid(projectId) || !isUuid(suiteId)) {
      throw new BadRequestException({ error: "Invalid projectId or suiteId." });
    }

    const suiteRes = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM suites WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [suiteId, projectId]
    );
    const suite = suiteRes.rows[0];
    if (!suite) {
      throw new NotFoundException({ error: "Suite not found in this project." });
    }

    const overrideUrl = validateTargetUrl(input.targetUrl);
    const onlyVerified = Boolean(input.onlyVerified);
    const browser = normalizeBrowser(input.browser);

    const casesRes = await this.db.query<{
      testcase_id: string;
      title: string;
      script_id: string;
      active_version_id: string;
      target_url: string | null;
    }>(
      `WITH RECURSIVE suite_tree AS (
         SELECT id FROM suites WHERE id = $1 AND project_id = $2
         UNION ALL
         SELECT s.id FROM suites s JOIN suite_tree st ON s.parent_id = st.id WHERE s.project_id = $2
       )
       SELECT tc.id AS testcase_id, tc.title, sc.id AS script_id, sc.active_version_id, sc.target_url
       FROM testcases tc
       JOIN suite_tree st ON tc.suite_id = st.id
       JOIN test_scripts sc ON sc.testcase_id = tc.id AND sc.project_id = tc.project_id AND sc.framework = 'playwright-ts'
       WHERE tc.project_id = $2
         AND tc.deleted_at IS NULL
         AND sc.active_version_id IS NOT NULL
         AND ($3::boolean = false OR sc.status = 'verified')
       ORDER BY tc.created_at ASC`,
      [suiteId, projectId, onlyVerified]
    );

    if (casesRes.rows.length === 0) {
      throw new BadRequestException({
        error: onlyVerified
          ? "No verified Playwright scripts found in this suite."
          : "No runnable Playwright scripts found in this suite."
      });
    }

    const { cycleId, runs } = await this.db.transaction(async (client) => {
      const browserTag = browser !== "chromium" ? ` [${browser}]` : "";
      const cycleName = `Suite Run: ${suite.name}${browserTag}`.slice(0, 255);
      const cycleRes = await client.query<{ id: string }>(
        `INSERT INTO cycles (project_id, name, owner_id, status, started_at, source, triggered_by)
         VALUES ($1, $2, $3, 'In Progress', now(), 'automation', 'local')
         RETURNING id`,
        [projectId, cycleName, uid]
      );
      const createdCycleId = cycleRes.rows[0].id;
      const insertedRuns: TestScriptRunRecord[] = [];

      for (let i = 0; i < casesRes.rows.length; i++) {
        const item = casesRes.rows[i];
        const cycleItemRes = await client.query<{ id: string }>(
          `INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title, position) VALUES ($1, $2, $3, $4) RETURNING id`,
          [createdCycleId, item.testcase_id, item.title, i + 1]
        );
        const execRes = await client.query<{ id: string }>(
          `INSERT INTO executions (cycle_item_id, status, reported_by, executed_by)
           VALUES ($1, 'Untested', 'automation', $2)
           RETURNING id`,
          [cycleItemRes.rows[0].id, uid]
        );
        const runInsert = await client.query(
          `INSERT INTO test_script_runs (
             project_id, testcase_id, script_id, version_id, cycle_id, execution_id,
             status, target_url, triggered_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
           RETURNING *`,
          [
            projectId,
            item.testcase_id,
            item.script_id,
            item.active_version_id,
            createdCycleId,
            execRes.rows[0].id,
            overrideUrl ?? item.target_url ?? null,
            uid
          ]
        );
        insertedRuns.push(mapRunRow(runInsert.rows[0]));
      }

      return { cycleId: createdCycleId, runs: insertedRuns };
    });

    for (const run of runs) {
      await this.queue.add(SCRIPT_RUNNER_JOB, { runId: run.id, browser }, { removeOnComplete: 50, removeOnFail: 50 });
    }

    await this.legacy.logProjectActivity(projectId, uid, "triggered_suite_automation_run", "suite", suiteId, suite.name, {
      cycleId,
      queuedCount: runs.length
    });

    return {
      cycleId,
      suiteId,
      suiteName: suite.name,
      queuedCount: runs.length,
      runs
    };
  }

  async getCycleScriptRuns(
    userId: string | null | undefined,
    projectId: string,
    cycleId: string
  ): Promise<{ runs: TestScriptRunRecord[] }> {
    await this.legacy.requireProjectAccess(userId, projectId);
    if (!isUuid(cycleId)) {
      throw new BadRequestException({ error: "Invalid cycleId." });
    }
    const res = await this.db.query(
      `SELECT * FROM test_script_runs WHERE project_id = $1 AND cycle_id = $2 ORDER BY created_at ASC`,
      [projectId, cycleId]
    );
    return { runs: res.rows.map(mapRunRow) };
  }

  async exportCycleReport(
    userId: string | null | undefined,
    projectId: string,
    cycleId: string,
    rawFormat?: string
  ): Promise<{ content: string | Buffer; contentType: string; fileName: string }> {
    await this.legacy.requireProjectAccess(userId, projectId);
    if (!isUuid(projectId) || !isUuid(cycleId)) {
      throw new BadRequestException({ error: "Invalid projectId or cycleId." });
    }

    const format = (rawFormat || "html").toLowerCase();
    if (!["html", "json", "junit", "pdf"].includes(format)) {
      throw new BadRequestException({ error: "Unsupported report format. Use html, json, junit, or pdf." });
    }

    const cycleRes = await this.db.query<{
      id: string;
      name: string;
      status: string;
      started_at: Date | string | null;
      closed_at: Date | string | null;
      project_name?: string | null;
    }>(
      `SELECT c.id, c.name, c.status, c.started_at, c.closed_at, p.name AS project_name
       FROM cycles c
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1 AND c.project_id = $2
       LIMIT 1`,
      [cycleId, projectId]
    );
    const cycle = cycleRes.rows[0];
    if (!cycle) {
      throw new NotFoundException({ error: "Test run cycle not found." });
    }

    const rowsRes = await this.db.query<{
      execution_id: string | null;
      testcase_id: string;
      external_id: string | null;
      title: string;
      exec_status: string;
      duration_ms: number | null;
      error_message: string | null;
      executed_at: Date | string | null;
      stdout: string | null;
      stderr: string | null;
      target_url: string | null;
    }>(
      `SELECT e.id AS execution_id,
              ci.testcase_id,
              tc.external_id,
              COALESCE(tc.title, ci.snapshot_title) AS title,
              COALESCE(e.status, 'Untested') AS exec_status,
              COALESCE(sr.duration_ms, e.duration_ms) AS duration_ms,
              COALESCE(sr.error_message, e.error_message) AS error_message,
              e.executed_at,
              sr.stdout,
              sr.stderr,
              sr.target_url
       FROM cycle_items ci
       LEFT JOIN testcases tc ON tc.id = ci.testcase_id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN test_script_runs sr ON sr.execution_id = e.id
       WHERE ci.cycle_id = $1
       ORDER BY ci.position ASC, ci.created_at ASC`,
      [cycleId]
    );

    const cases = rowsRes.rows;
    const total = cases.length;
    const passed = cases.filter((c) => c.exec_status === "Passed").length;
    const failed = cases.filter((c) => c.exec_status === "Failed").length;
    const skipped = total - passed - failed;
    const totalDurationMs = cases.reduce((sum, c) => sum + (Number(c.duration_ms) || 0), 0);
    const slug = cycle.name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "suite-report";

    const escXml = (s: unknown) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    if (format === "json") {
      const payload = {
        config: { reporter: "testpilot-playwright-json" },
        stats: {
          startTime: cycle.started_at ? new Date(cycle.started_at).toISOString() : null,
          duration: totalDurationMs,
          expected: passed,
          unexpected: failed,
          skipped,
          total
        },
        suites: [
          {
            title: cycle.name,
            specs: cases.map((c) => ({
              title: c.external_id ? `[${c.external_id}] ${c.title}` : c.title,
              ok: c.exec_status === "Passed",
              tests: [
                {
                  status: c.exec_status === "Passed" ? "expected" : c.exec_status === "Failed" ? "unexpected" : "skipped",
                  results: [
                    {
                      status: c.exec_status.toLowerCase(),
                      duration: Number(c.duration_ms) || 0,
                      error: c.error_message ? { message: c.error_message } : undefined,
                      stdout: c.stdout ? [{ text: c.stdout }] : []
                    }
                  ]
                }
              ]
            }))
          }
        ]
      };
      return {
        content: JSON.stringify(payload, null, 2),
        contentType: "application/json; charset=utf-8",
        fileName: `${slug}.json`
      };
    }

    if (format === "junit") {
      const testcasesXml = cases
        .map((c) => {
          const name = escXml(c.external_id ? `[${c.external_id}] ${c.title}` : c.title);
          const timeSec = ((Number(c.duration_ms) || 0) / 1000).toFixed(3);
          if (c.exec_status === "Failed") {
            return `    <testcase name="${name}" classname="${escXml(cycle.name)}" time="${timeSec}">\n      <failure message="${escXml(c.error_message || "Test failed")}">${escXml(c.stderr || c.error_message || "")}</failure>\n    </testcase>`;
          }
          if (c.exec_status !== "Passed") {
            return `    <testcase name="${name}" classname="${escXml(cycle.name)}" time="${timeSec}">\n      <skipped />\n    </testcase>`;
          }
          return `    <testcase name="${name}" classname="${escXml(cycle.name)}" time="${timeSec}" />`;
        })
        .join("\n");

      const xml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuites tests="${total}" failures="${failed}" skipped="${skipped}" time="${(totalDurationMs / 1000).toFixed(3)}">`,
        `  <testsuite name="${escXml(cycle.name)}" tests="${total}" failures="${failed}" skipped="${skipped}" time="${(totalDurationMs / 1000).toFixed(3)}">`,
        testcasesXml,
        `  </testsuite>`,
        `</testsuites>`
      ].join("\n");

      return {
        content: xml,
        contentType: "application/xml; charset=utf-8",
        fileName: `${slug}.xml`
      };
    }

    if (format === "pdf") {
      const execIds = cases.map((c) => c.execution_id).filter((id): id is string => Boolean(id));
      const attachmentsByExec = new Map<
        string,
        {
          screenshots: Array<{ fileName: string; dataUrl: string }>;
          files: Array<{ fileName: string; kind: string; sizeLabel: string }>;
          apiCalls: Array<{ method: string; url: string; status: number | null; durationMs: number | null }>;
        }
      >();

      if (execIds.length > 0) {
        const attRes = await this.db.query<{
          entity_id: string;
          file_name: string;
          content_type: string;
          file_size: number | null;
          storage_path: string | null;
          evidence_kind: string | null;
        }>(
          `SELECT entity_id, file_name, content_type, file_size, storage_path, evidence_kind
           FROM attachments
           WHERE entity_type = 'execution' AND entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
           ORDER BY created_at ASC`,
          [execIds]
        );

        for (const att of attRes.rows) {
          let bucket = attachmentsByExec.get(att.entity_id);
          if (!bucket) {
            bucket = { screenshots: [], files: [], apiCalls: [] };
            attachmentsByExec.set(att.entity_id, bucket);
          }

          const sizeKb = att.file_size != null ? `${Math.max(1, Math.round(att.file_size / 1024))} KB` : "";
          const isImage = att.evidence_kind === "screenshot" || String(att.content_type || "").startsWith("image/");

          if (isImage && att.storage_path && bucket.screenshots.length < 3) {
            try {
              const buf = await (this.storage as unknown as { getBuffer?: (k: string) => Promise<Buffer> }).getBuffer?.(
                att.storage_path
              );
              if (buf && buf.length > 0 && buf.length <= 3 * 1024 * 1024) {
                bucket.screenshots.push({
                  fileName: att.file_name,
                  dataUrl: `data:${att.content_type || "image/png"};base64,${buf.toString("base64")}`
                });
              }
            } catch {
              // Skip unreadable image
            }
          } else if (att.evidence_kind === "api" && att.storage_path) {
            try {
              const buf = await (this.storage as unknown as { getBuffer?: (k: string) => Promise<Buffer> }).getBuffer?.(
                att.storage_path
              );
              if (buf) {
                const parsed = JSON.parse(buf.toString("utf8")) as { calls?: Array<Record<string, any>> };
                if (Array.isArray(parsed?.calls)) {
                  for (const call of parsed.calls.slice(0, 10)) {
                    bucket.apiCalls.push({
                      method: String(call.method || "GET"),
                      url: String(call.url || ""),
                      status: typeof call.status === "number" ? call.status : null,
                      durationMs: typeof call.durationMs === "number" ? call.durationMs : null
                    });
                  }
                }
              }
            } catch {
              // Skip unreadable api JSON
            }
          } else {
            bucket.files.push({
              fileName: att.file_name,
              kind: att.evidence_kind || "attachment",
              sizeLabel: sizeKb
            });
          }
        }
      }

      const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
      const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

      const summaryRows = cases
        .map((c, idx) => {
          const statusCls =
            c.exec_status === "Passed" ? "pill-pass" : c.exec_status === "Failed" ? "pill-fail" : "pill-skip";
          const label = escXml(c.external_id ? `[${c.external_id}] ${c.title}` : c.title);
          const dur = c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(2)}s` : "—";
          return `<tr>
            <td class="mono muted">${idx + 1}</td>
            <td>${label}</td>
            <td><span class="pill ${statusCls}">${escXml(c.exec_status)}</span></td>
            <td class="mono right">${dur}</td>
          </tr>`;
        })
        .join("");

      const detailSections = cases
        .map((c, idx) => {
          const statusCls =
            c.exec_status === "Passed" ? "pill-pass" : c.exec_status === "Failed" ? "pill-fail" : "pill-skip";
          const label = escXml(c.external_id ? `[${c.external_id}] ${c.title}` : c.title);
          const dur = c.duration_ms != null ? `${c.duration_ms} ms` : "—";
          const ev = c.execution_id ? attachmentsByExec.get(c.execution_id) : undefined;
          const logsText = c.error_message || c.stderr || c.stdout;

          const screenshotsHtml =
            ev && ev.screenshots.length > 0
              ? `<div class="ev-block">
                  <div class="ev-title">Visual Evidence (Screenshots)</div>
                  <div class="shot-grid">
                    ${ev.screenshots
                      .map(
                        (s) => `<div class="shot-card">
                        <img src="${s.dataUrl}" alt="${escXml(s.fileName)}" />
                        <div class="shot-cap">${escXml(s.fileName)}</div>
                      </div>`
                      )
                      .join("")}
                  </div>
                </div>`
              : "";

          const apiHtml =
            ev && ev.apiCalls.length > 0
              ? `<div class="ev-block">
                  <div class="ev-title">API Evidence</div>
                  <table class="mini-table">
                    <thead><tr><th>Method</th><th>Status</th><th>Endpoint</th><th>Time</th></tr></thead>
                    <tbody>
                      ${ev.apiCalls
                        .map(
                          (a) => `<tr>
                          <td class="mono">${escXml(a.method)}</td>
                          <td class="mono">${a.status ?? "—"}</td>
                          <td class="mono break">${escXml(a.url)}</td>
                          <td class="mono right">${a.durationMs != null ? `${a.durationMs}ms` : "—"}</td>
                        </tr>`
                        )
                        .join("")}
                    </tbody>
                  </table>
                </div>`
              : "";

          const filesHtml =
            ev && ev.files.length > 0
              ? `<div class="ev-files">Artifacts captured: ${ev.files
                  .map((f) => `<span>${escXml(f.fileName)}${f.sizeLabel ? ` (${f.sizeLabel})` : ""}</span>`)
                  .join(" · ")}</div>`
              : "";

          return `
          <div class="case-card">
            <div class="case-head">
              <div>
                <span class="case-num">#${idx + 1}</span>
                <span class="case-title">${label}</span>
              </div>
              <div class="case-meta">
                <span class="mono muted">${dur}</span>
                <span class="pill ${statusCls}">${escXml(c.exec_status)}</span>
              </div>
            </div>
            ${c.target_url ? `<div class="case-url">Target URL: <code>${escXml(c.target_url)}</code></div>` : ""}
            ${logsText ? `<pre class="log-box ${c.exec_status === "Failed" ? "log-fail" : ""}">${escXml(logsText.slice(0, 2500))}</pre>` : ""}
            ${screenshotsHtml}
            ${apiHtml}
            ${filesHtml}
          </div>`;
        })
        .join("");

      const pdfHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; font-size: 11px; line-height: 1.45; }
    .header { border-bottom: 2px solid #4f46e5; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; }
    .brand { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #4f46e5; margin-bottom: 4px; }
    h1 { margin: 0; font-size: 19px; font-weight: 700; color: #0f172a; }
    .sub { color: #64748b; font-size: 10.5px; margin-top: 3px; }
    .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; }
    .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; background: #f8fafc; }
    .kpi-val { font-size: 17px; font-weight: 700; font-family: ui-monospace, monospace; }
    .kpi-lbl { font-size: 9.5px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
    .bar { height: 7px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin-bottom: 18px; display: flex; }
    .bar-pass { background: #10b981; height: 100%; }
    .bar-fail { background: #ef4444; height: 100%; }
    h2 { font-size: 13px; font-weight: 700; margin: 16px 0 8px; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
    th { font-size: 9.5px; text-transform: uppercase; color: #64748b; background: #f8fafc; }
    .right { text-align: right; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted { color: #64748b; }
    .break { word-break: break-all; }
    .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; }
    .pill-pass { background: #d1fae5; color: #065f46; }
    .pill-fail { background: #fee2e2; color: #991b1b; }
    .pill-skip { background: #f1f5f9; color: #475569; }
    .case-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid; background: #ffffff; }
    .case-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .case-num { font-family: ui-monospace, monospace; color: #64748b; margin-right: 6px; font-weight: 600; }
    .case-title { font-size: 12px; font-weight: 600; color: #0f172a; }
    .case-meta { display: flex; align-items: center; gap: 8px; shrink: 0; }
    .case-url { margin-top: 5px; font-size: 10px; color: #475569; }
    code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, monospace; }
    .log-box { margin: 8px 0 0; padding: 8px; border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0; font-family: ui-monospace, monospace; font-size: 9.5px; white-space: pre-wrap; word-break: break-word; }
    .log-fail { background: #fef2f2; border-color: #fecaca; color: #7f1d1d; }
    .ev-block { margin-top: 8px; }
    .ev-title { font-size: 10px; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 5px; }
    .shot-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .shot-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 4px; background: #f8fafc; }
    .shot-card img { width: 100%; max-height: 220px; object-fit: contain; display: block; border-radius: 4px; }
    .shot-cap { font-size: 9px; color: #64748b; text-align: center; margin-top: 3px; font-family: ui-monospace, monospace; }
    .mini-table th, .mini-table td { padding: 4px 6px; font-size: 9.5px; }
    .ev-files { margin-top: 6px; font-size: 9.5px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">TestPilot · Automated Execution Report</div>
      <h1>${escXml(cycle.name)}</h1>
      <div class="sub">${cycle.project_name ? `Project: ${escXml(cycle.project_name)} · ` : ""}Status: ${escXml(cycle.status)} · Generated: ${escXml(generatedAt)}</div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-val">${total}</div><div class="kpi-lbl">Total Cases</div></div>
    <div class="kpi"><div class="kpi-val" style="color:#059669;">${passed}</div><div class="kpi-lbl">Passed</div></div>
    <div class="kpi"><div class="kpi-val" style="color:#dc2626;">${failed}</div><div class="kpi-lbl">Failed</div></div>
    <div class="kpi"><div class="kpi-val">${passRate}%</div><div class="kpi-lbl">Pass Rate</div></div>
    <div class="kpi"><div class="kpi-val">${(totalDurationMs / 1000).toFixed(2)}s</div><div class="kpi-lbl">Duration</div></div>
  </div>

  <div class="bar">
    <div class="bar-pass" style="width:${total > 0 ? (passed / total) * 100 : 0}%"></div>
    <div class="bar-fail" style="width:${total > 0 ? (failed / total) * 100 : 0}%"></div>
  </div>

  <h2>Execution Summary</h2>
  <table>
    <thead><tr><th style="width:36px;">#</th><th>Test Case</th><th style="width:90px;">Status</th><th class="right" style="width:80px;">Duration</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>

  <h2>Detailed Results &amp; Evidence</h2>
  ${detailSections}
</body>
</html>`;

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(pdfHtml, { waitUntil: "load" });
        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: `<div></div>`,
          footerTemplate: `<div style="width:100%;font-size:9px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between;"><span>TestPilot Automation Report</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
          margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" }
        });
        return {
          content: Buffer.from(pdfBuffer),
          contentType: "application/pdf",
          fileName: `${slug}.pdf`
        };
      } finally {
        await browser.close().catch(() => undefined);
      }
    }

    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const rowsHtml = cases
      .map((c, idx) => {
        const badgeColor =
          c.exec_status === "Passed"
            ? "#10b981"
            : c.exec_status === "Failed"
              ? "#ef4444"
              : "#9ca3af";
        const label = escXml(c.external_id ? `[${c.external_id}] ${c.title}` : c.title);
        const dur = c.duration_ms != null ? `${c.duration_ms} ms` : "—";
        const details = c.error_message || c.stdout || c.stderr;
        return `
        <details class="case" ${c.exec_status === "Failed" ? "open" : ""}>
          <summary>
            <div class="left">
              <span class="idx">#${idx + 1}</span>
              <span class="badge" style="border-color:${badgeColor};color:${badgeColor};">${escXml(c.exec_status)}</span>
              <span class="title">${label}</span>
            </div>
            <span class="dur">${dur}</span>
          </summary>
          <div class="meta">
            ${c.target_url ? `<div><strong>Target URL:</strong> <code>${escXml(c.target_url)}</code></div>` : ""}
            ${details ? `<pre>${escXml(details)}</pre>` : `<div class="muted">No additional output captured.</div>`}
          </div>
        </details>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escXml(cycle.name)} — TestPilot Execution Report</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#0f172a; color:#f8fafc; padding:32px 20px; }
    .wrap { max-width:960px; margin:0 auto; }
    h1 { font-size:22px; margin:0 0 6px; }
    .sub { color:#94a3b8; font-size:13px; margin-bottom:24px; }
    .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:24px; }
    .stat { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:14px; }
    .stat .val { font-size:22px; font-weight:700; font-family: ui-monospace, monospace; }
    .stat .lbl { font-size:12px; color:#94a3b8; margin-top:4px; }
    .case { background:#1e293b; border:1px solid #334155; border-radius:10px; margin-bottom:10px; overflow:hidden; }
    summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; cursor:pointer; list-style:none; }
    summary::-webkit-details-marker { display:none; }
    .left { display:flex; align-items:center; gap:10px; min-width:0; }
    .idx { color:#64748b; font-family:ui-monospace, monospace; font-size:12px; }
    .badge { border:1px solid; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:600; }
    .title { font-size:14px; font-weight:500; }
    .dur { color:#94a3b8; font-family:ui-monospace, monospace; font-size:12px; shrink:0; }
    .meta { border-top:1px solid #334155; padding:12px 16px; background:#0b1120; font-size:12px; }
    pre { margin:8px 0 0; padding:10px; background:#111827; border:1px solid #1f2937; border-radius:6px; overflow-x:auto; white-space:pre-wrap; font-family:ui-monospace, monospace; color:#e2e8f0; }
    .muted { color:#64748b; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${escXml(cycle.name)}</h1>
    <div class="sub">Status: ${escXml(cycle.status)} · Generated by TestPilot Automation Reporter</div>
    <div class="stats">
      <div class="stat"><div class="val">${total}</div><div class="lbl">Total Tests</div></div>
      <div class="stat"><div class="val" style="color:#10b981;">${passed}</div><div class="lbl">Passed</div></div>
      <div class="stat"><div class="val" style="color:#ef4444;">${failed}</div><div class="lbl">Failed</div></div>
      <div class="stat"><div class="val">${passRate}%</div><div class="lbl">Pass Rate</div></div>
      <div class="stat"><div class="val">${(totalDurationMs / 1000).toFixed(2)}s</div><div class="lbl">Total Duration</div></div>
    </div>
    ${rowsHtml}
  </div>
</body>
</html>`;

    return {
      content: html,
      contentType: "text/html; charset=utf-8",
      fileName: `${slug}.html`
    };
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
  async executeRunJob(runId: string, rawBrowser?: ScriptBrowser): Promise<void> {
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

      const browser = normalizeBrowser(rawBrowser);
      const selectedProjects: string[] = [];
      if (browser === "chromium" || browser === "all") {
        selectedProjects.push(`{ name: "chromium", use: { ...devices["Desktop Chrome"] } }`);
      }
      if (browser === "firefox" || browser === "all") {
        selectedProjects.push(`{ name: "firefox", use: { ...devices["Desktop Firefox"] } }`);
      }
      if (browser === "webkit" || browser === "all") {
        selectedProjects.push(`{ name: "webkit", use: { ...devices["Desktop Safari"] } }`);
      }

      const baseUrlLine = jobData.target_url ? `baseURL: ${JSON.stringify(jobData.target_url)},` : "";
      const configContent = [
        `import { defineConfig, devices } from "@playwright/test";`,
        `export default defineConfig({`,
        `  testDir: ".",`,
        `  outputDir: ${JSON.stringify(resultsDir)},`,
        `  timeout: ${SCRIPT_EXECUTION_TIMEOUT_MS},`,
        `  reporter: [["list"]],`,
        `  use: { headless: true, ignoreHTTPSErrors: true, ${baseUrlLine} screenshot: "on", trace: "on", video: "on" },`,
        `  projects: [${selectedProjects.join(", ")}]`,
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
            HOME: tempDir,
            MOZ_DISABLE_CONTENT_SANDBOX: "1",
            MOZ_DISABLE_GMP_SANDBOX: "1",
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
    evidenceKind: "screenshot" | "video" | "api" | "trace",
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
      for (let i = 0; i < pngPaths.length; i++) {
        const buffer = await fs.readFile(pngPaths[i]);
        const fileName = pngPaths.length === 1 ? "screenshot.png" : `screenshot-${i + 1}.png`;
        await this.storeAttachment(projectId, executionId, uploadedBy, fileName, "png", "image/png", "screenshot", buffer);
      }

      const videoPaths = await this.findFilesByExt(resultsDir, ".webm");
      for (let i = 0; i < videoPaths.length; i++) {
        const buffer = await fs.readFile(videoPaths[i]);
        const fileName = videoPaths.length === 1 ? "video.webm" : `video-${i + 1}.webm`;
        await this.storeAttachment(projectId, executionId, uploadedBy, fileName, "webm", "video/webm", "video", buffer);
      }

      const tracePaths = await this.findFilesByExt(resultsDir, ".zip");
      for (let i = 0; i < tracePaths.length; i++) {
        const zipBuffer = await fs.readFile(tracePaths[i]);
        const traceFileName = tracePaths.length === 1 ? "trace.zip" : `trace-${i + 1}.zip`;
        await this.storeAttachment(
          projectId,
          executionId,
          uploadedBy,
          traceFileName,
          "zip",
          "application/zip",
          "trace",
          zipBuffer
        );

        // API-only runs (no browser screenshots): also store compact response-only JSON evidence.
        if (pngPaths.length === 0) {
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
           WHERE id = $1
             AND NOT EXISTS (
               SELECT 1 FROM test_script_runs
               WHERE cycle_id = $1 AND status IN ('queued', 'running')
             )`,
          [cycleId]
        );
      }
    });
  }
}
