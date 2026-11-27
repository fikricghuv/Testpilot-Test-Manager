import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { decryptSecret, encryptSecret } from "../common/crypto.util";
import { DatabaseService } from "../database/database.service";
import { isUuid, LegacyService } from "../legacy/legacy.service";
import { ScriptRunnerService } from "../script-runner/script-runner.service";
import {
  AUTOMATION_AGENTS_JOB,
  AUTOMATION_AGENTS_QUEUE,
  DEFAULT_MAX_HEAL_ATTEMPTS
} from "./automation-agents.constants";
import type {
  AgentJobMode,
  AgentJobStage,
  AgentLogEntry,
  AutomationAuthConfigSummary,
  DecryptedAutomationAuth,
  DiscoveredScenario,
  PageSnapshot,
  TestAgentJobRecord
} from "./automation-agents.types";
import { PageInspectorService } from "./page-inspector.service";

const execFileAsync = promisify(execFile);

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:typescript|ts|javascript|js|json)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

function validateUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new BadRequestException({ error: "targetUrl is required." });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BadRequestException({ error: "targetUrl must be a valid http or https URL." });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException({ error: "targetUrl must use http or https." });
  }
  return parsed.toString();
}

function mapJobRow(row: Record<string, any>): TestAgentJobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    testcaseId: row.testcase_id ?? null,
    mode: row.mode,
    stage: row.stage,
    targetUrl: row.target_url,
    instructions: row.instructions ?? null,
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || DEFAULT_MAX_HEAL_ATTEMPTS),
    planJson: row.plan_json && typeof row.plan_json === "object" ? row.plan_json : {},
    logs: Array.isArray(row.logs_json) ? row.logs_json : [],
    discoveredScenarios: Array.isArray(row.discovered_scenarios_json) ? row.discovered_scenarios_json : [],
    resultScriptId: row.result_script_id ?? null,
    resultVersionId: row.result_version_id ?? null,
    resultRunId: row.result_run_id ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

@Injectable()
export class AutomationAgentsService {
  private readonly logger = new Logger(AutomationAgentsService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => LegacyService)) private readonly legacy: LegacyService,
    private readonly inspector: PageInspectorService,
    @Inject(forwardRef(() => ScriptRunnerService)) private readonly scriptRunner: ScriptRunnerService,
    @InjectQueue(AUTOMATION_AGENTS_QUEUE) private readonly queue: Queue<{ jobId: string }>
  ) {}

  async getAuthConfig(userId: string | null | undefined, projectId: string): Promise<AutomationAuthConfigSummary> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const res = await this.db.query(
      `SELECT login_url, username, encrypted_password, encrypted_storage_state, updated_at
       FROM project_automation_auth WHERE project_id = $1 LIMIT 1`,
      [projectId]
    );
    const row = res.rows[0];
    if (!row) {
      return { loginUrl: null, username: null, hasPassword: false, hasStorageState: false, updatedAt: null };
    }
    return {
      loginUrl: row.login_url ?? null,
      username: row.username ?? null,
      hasPassword: Boolean(row.encrypted_password),
      hasStorageState: Boolean(row.encrypted_storage_state),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
    };
  }

  async upsertAuthConfig(
    userId: string | null | undefined,
    projectId: string,
    input: { loginUrl?: string | null; username?: string | null; password?: string | null; storageStateJson?: string | null }
  ): Promise<AutomationAuthConfigSummary> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);

    const loginUrl = input.loginUrl?.trim() ? validateUrl(input.loginUrl) : null;
    const username = input.username?.trim() || null;

    if (input.storageStateJson?.trim()) {
      try {
        JSON.parse(input.storageStateJson.trim());
      } catch {
        throw new BadRequestException({ error: "storageStateJson must be valid JSON." });
      }
    }

    const existing = await this.db.query(
      `SELECT encrypted_password, encrypted_storage_state FROM project_automation_auth WHERE project_id = $1 LIMIT 1`,
      [projectId]
    );
    const cur = existing.rows[0];

    const encryptedPassword =
      input.password === ""
        ? null
        : input.password
          ? encryptSecret(input.password)
          : cur?.encrypted_password ?? null;

    const encryptedStorageState =
      input.storageStateJson === ""
        ? null
        : input.storageStateJson?.trim()
          ? encryptSecret(input.storageStateJson.trim())
          : cur?.encrypted_storage_state ?? null;

    await this.db.query(
      `INSERT INTO project_automation_auth (project_id, login_url, username, encrypted_password, encrypted_storage_state, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id) DO UPDATE SET
         login_url = EXCLUDED.login_url,
         username = EXCLUDED.username,
         encrypted_password = EXCLUDED.encrypted_password,
         encrypted_storage_state = EXCLUDED.encrypted_storage_state,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [projectId, loginUrl, username, encryptedPassword, encryptedStorageState, uid]
    );

    return this.getAuthConfig(uid, projectId);
  }

  private async getDecryptedAuth(projectId: string): Promise<DecryptedAutomationAuth | null> {
    const res = await this.db.query(
      `SELECT login_url, username, encrypted_password, encrypted_storage_state
       FROM project_automation_auth WHERE project_id = $1 LIMIT 1`,
      [projectId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      loginUrl: row.login_url ?? null,
      username: row.username ?? null,
      password: row.encrypted_password ? decryptSecret(row.encrypted_password) : null,
      storageStateJson: row.encrypted_storage_state ? decryptSecret(row.encrypted_storage_state) : null
    };
  }

  async startSingleGenerate(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    input: { targetUrl: string; instructions?: string | null; zyraSessionId?: string | null }
  ): Promise<{ job: TestAgentJobRecord }> {
    return this.enqueueJob(userId, projectId, testcaseId, "single", input);
  }

  async startHeal(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    input: { targetUrl?: string | null; instructions?: string | null; zyraSessionId?: string | null }
  ): Promise<{ job: TestAgentJobRecord }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const scriptState = await this.scriptRunner.getScript(uid, projectId, testcaseId);
    if (!scriptState.script?.scriptContent) {
      throw new BadRequestException({ error: "Save or generate a Playwright script before healing." });
    }
    const resolvedUrl = input.targetUrl?.trim() || scriptState.script.targetUrl;
    if (!resolvedUrl) {
      throw new BadRequestException({ error: "Target URL is required to heal this script." });
    }
    return this.enqueueJob(uid, projectId, testcaseId, "heal", {
      targetUrl: resolvedUrl,
      instructions: input.instructions,
      zyraSessionId: input.zyraSessionId
    });
  }

  async startExplore(
    userId: string | null | undefined,
    projectId: string,
    input: { targetUrl: string; instructions?: string | null }
  ): Promise<{ job: TestAgentJobRecord }> {
    return this.enqueueJob(userId, projectId, null, "explore", input);
  }

  private async enqueueJob(
    userId: string | null | undefined,
    projectId: string,
    testcaseId: string | null,
    mode: AgentJobMode,
    input: { targetUrl: string; instructions?: string | null; zyraSessionId?: string | null }
  ): Promise<{ job: TestAgentJobRecord }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const targetUrl = validateUrl(input.targetUrl);
    const instructions = input.instructions?.trim().slice(0, 1000) || null;

    if (testcaseId) {
      if (!isUuid(testcaseId)) throw new BadRequestException({ error: "Invalid testcaseId." });
      const tcRes = await this.db.query(
        `SELECT id FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [testcaseId, projectId]
      );
      if (!tcRes.rows[0]) throw new NotFoundException({ error: "Test case not found in this project." });
    }

    const initialLog: AgentLogEntry = {
      at: new Date().toISOString(),
      stage: "queued",
      message: `Queued 3-Agent (${mode}) job for ${targetUrl}`
    };

    const initialPlanJson =
      input.zyraSessionId && isUuid(input.zyraSessionId) ? { zyraSessionId: input.zyraSessionId } : {};

    const res = await this.db.query(
      `INSERT INTO test_agent_jobs (project_id, testcase_id, mode, stage, target_url, instructions, max_attempts, plan_json, logs_json, created_by)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING *`,
      [projectId, testcaseId, mode, targetUrl, instructions, DEFAULT_MAX_HEAL_ATTEMPTS, JSON.stringify(initialPlanJson), JSON.stringify([initialLog]), uid]
    );
    const job = mapJobRow(res.rows[0]);
    await this.queue.add(AUTOMATION_AGENTS_JOB, { jobId: job.id }, { removeOnComplete: 50, removeOnFail: 50 });
    return { job };
  }

  async getJob(userId: string | null | undefined, projectId: string, jobId: string): Promise<{ job: TestAgentJobRecord }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    if (!isUuid(jobId)) throw new NotFoundException({ error: "Job not found." });
    const res = await this.db.query(
      `SELECT * FROM test_agent_jobs WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [jobId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Agent job not found." });
    return { job: mapJobRow(res.rows[0]) };
  }

  async listJobs(userId: string | null | undefined, projectId: string, testcaseId?: string): Promise<{ list: TestAgentJobRecord[] }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const res = testcaseId && isUuid(testcaseId)
      ? await this.db.query(
          `SELECT * FROM test_agent_jobs WHERE project_id = $1 AND testcase_id = $2 ORDER BY created_at DESC LIMIT 20`,
          [projectId, testcaseId]
        )
      : await this.db.query(
          `SELECT * FROM test_agent_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [projectId]
        );
    return { list: res.rows.map(mapJobRow) };
  }

  async createTestCasesFromExplore(
    userId: string | null | undefined,
    projectId: string,
    jobId: string,
    indices: number[]
  ): Promise<{ created: Array<{ testcaseId: string; title: string; jobId: string }> }> {
    const uid = this.legacy.requireSession(userId);
    await this.legacy.requireProjectAccess(uid, projectId);
    const { job } = await this.getJob(uid, projectId, jobId);
    if (job.mode !== "explore" || job.discoveredScenarios.length === 0) {
      throw new BadRequestException({ error: "No discovered scenarios found for this explore job." });
    }

    const picked = indices
      .filter((i) => Number.isInteger(i) && i >= 0 && i < job.discoveredScenarios.length)
      .map((i) => job.discoveredScenarios[i]);

    if (picked.length === 0) {
      throw new BadRequestException({ error: "Select at least one scenario." });
    }

    const created: Array<{ testcaseId: string; title: string; jobId: string }> = [];
    for (const sc of picked) {
      const stepsText = (sc.steps || []).map((s, idx) => `${idx + 1}. ${s}`).join("\n");
      const tc = await this.legacy.createTestCase(projectId, uid, {
        title: sc.title,
        description: sc.description,
        steps: stepsText,
        expectedResult: sc.expectedResult,
        priority: sc.priority || "medium",
        type: "e2e"
      });
      const tcId = String((tc as Record<string, any>).id);
      const child = await this.startSingleGenerate(uid, projectId, tcId, { targetUrl: job.targetUrl });
      created.push({ testcaseId: tcId, title: sc.title, jobId: child.job.id });
    }
    return { created };
  }

  private async appendJobUpdate(
    jobId: string,
    patch: {
      stage?: AgentJobStage;
      attempt?: number;
      planJson?: Record<string, unknown>;
      discoveredScenarios?: DiscoveredScenario[];
      resultScriptId?: string | null;
      resultVersionId?: string | null;
      resultRunId?: string | null;
      errorMessage?: string | null;
      logMessage?: string;
    }
  ): Promise<void> {
    const curRes = await this.db.query(`SELECT stage, logs_json FROM test_agent_jobs WHERE id = $1`, [jobId]);
    const cur = curRes.rows[0];
    if (!cur) return;
    const logs: AgentLogEntry[] = Array.isArray(cur.logs_json) ? cur.logs_json : [];
    const nextStage = patch.stage ?? cur.stage;
    if (patch.logMessage) {
      logs.push({ at: new Date().toISOString(), stage: nextStage, message: patch.logMessage });
    }

    await this.db.query(
      `UPDATE test_agent_jobs
       SET stage = COALESCE($2, stage),
           attempt = COALESCE($3, attempt),
           plan_json = COALESCE($4::jsonb, plan_json),
           discovered_scenarios_json = COALESCE($5::jsonb, discovered_scenarios_json),
           result_script_id = COALESCE($6, result_script_id),
           result_version_id = COALESCE($7, result_version_id),
           result_run_id = COALESCE($8, result_run_id),
           error_message = $9,
           logs_json = $10::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        patch.stage ?? null,
        patch.attempt ?? null,
        patch.planJson ? JSON.stringify(patch.planJson) : null,
        patch.discoveredScenarios ? JSON.stringify(patch.discoveredScenarios) : null,
        patch.resultScriptId ?? null,
        patch.resultVersionId ?? null,
        patch.resultRunId ?? null,
        patch.errorMessage !== undefined ? patch.errorMessage : null,
        JSON.stringify(logs.slice(-40))
      ]
    );
  }

  async executeJob(jobId: string): Promise<void> {
    const res = await this.db.query(`SELECT * FROM test_agent_jobs WHERE id = $1 LIMIT 1`, [jobId]);
    const row = res.rows[0];
    if (!row) return;
    const job = mapJobRow(row);
    const uid = row.created_by as string;
    const auth = await this.getDecryptedAuth(job.projectId);

    try {
      if (job.mode === "explore") {
        await this.runExplorePipeline(job, auth);
        return;
      }

      if (!job.testcaseId) {
        throw new Error("testcaseId is required for single/heal mode.");
      }

      const tcRes = await this.db.query(
        `SELECT id, external_id, title, description, preconditions, postconditions, steps FROM testcases WHERE id = $1 AND project_id = $2 LIMIT 1`,
        [job.testcaseId, job.projectId]
      );
      const tc = tcRes.rows[0];
      if (!tc) throw new Error("Test case not found.");

      let currentScript = "";
      let snapshot: PageSnapshot;

      if (job.mode === "single") {
        await this.appendJobUpdate(job.id, {
          stage: "planning",
          logMessage: `Planner: Inspecting ${job.targetUrl} with headless Chromium...`
        });
        snapshot = await this.inspector.inspectPage(job.targetUrl, auth);

        const plan = await this.runPlannerAgent(job.projectId, tc, snapshot, job.instructions);
        await this.appendJobUpdate(job.id, {
          stage: "generating",
          planJson: plan,
          logMessage: `Planner found ${snapshot.interactiveElements.length} live interactive elements. Generator: Writing grounded Playwright spec...`
        });

        currentScript = await this.runGeneratorAgent(job.projectId, tc, snapshot, plan);
        const saved = await this.scriptRunner.upsertScript(uid, job.projectId, job.testcaseId, {
          scriptContent: currentScript,
          framework: "playwright-ts",
          targetUrl: job.targetUrl,
          status: "draft",
          source: "zyra",
          notes: "Generated by TestPilot 3-Agent (Planner + Generator)",
          verifiedLocators: this.extractVerifiedLocators(snapshot)
        });
        await this.appendJobUpdate(job.id, {
          resultScriptId: saved.script?.id ?? null,
          resultVersionId: saved.script?.activeVersionId ?? null,
          logMessage: `Saved draft v${saved.script?.activeVersion ?? 1}. Starting verification run...`
        });
      } else {
        const state = await this.scriptRunner.getScript(uid, job.projectId, job.testcaseId);
        currentScript = state.script?.scriptContent || "";
        snapshot = await this.inspector.inspectPage(job.targetUrl, auth);
      }

      // Closed-loop Healer (up to maxAttempts)
      let verified = false;
      let lastError: string | null = null;
      let latestScriptId: string | null = null;
      let latestVersionId: string | null = null;
      for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
        await this.appendJobUpdate(job.id, {
          stage: "running",
          attempt,
          logMessage: `Running Playwright verification (attempt ${attempt}/${job.maxAttempts})...`
        });

        const execResult = await this.runPlaywrightVerification(currentScript, job.targetUrl, auth);
        if (execResult.passed) {
          verified = true;
          if (attempt === 1 && job.mode === "single") {
            // Script passed on the first try — promote the existing draft version in-place instead of creating a duplicate v2.
            await this.db.query(
              `UPDATE test_scripts SET status = 'verified', updated_by = $2, updated_at = now()
               WHERE project_id = $1 AND testcase_id = $3 AND framework = 'playwright-ts'`,
              [job.projectId, uid, job.testcaseId]
            );
            const state = await this.scriptRunner.getScript(uid, job.projectId, job.testcaseId);
            latestScriptId = state.script?.id ?? null;
            latestVersionId = state.script?.activeVersionId ?? null;
          } else {
            const promoted = await this.scriptRunner.upsertScript(uid, job.projectId, job.testcaseId, {
              scriptContent: currentScript,
              framework: "playwright-ts",
              targetUrl: job.targetUrl,
              status: "verified",
              source: "healer",
              notes: `Verified by 3-Agent pipeline on attempt ${attempt}`,
              verifiedLocators: this.extractVerifiedLocators(snapshot)
            });
            latestScriptId = promoted.script?.id ?? null;
            latestVersionId = promoted.script?.activeVersionId ?? null;
          }
          const triggered = await this.scriptRunner.triggerRun(uid, job.projectId, job.testcaseId, {
            targetUrl: job.targetUrl
          });
          await this.appendJobUpdate(job.id, {
            stage: "completed",
            attempt,
            resultScriptId: latestScriptId,
            resultVersionId: latestVersionId,
            resultRunId: triggered.run.id,
            errorMessage: null,
            logMessage: `Verified! Script passed on attempt ${attempt} and marked as 'verified'.`
          });
          await this.notifyZyraSession(job.id, "completed", {
            attempt,
            resultRunId: triggered.run.id
          });
          break;
        }

        lastError = execResult.errorMessage || "Playwright run failed.";
        if (attempt >= job.maxAttempts) break;

        await this.appendJobUpdate(job.id, {
          stage: "healing",
          attempt,
          logMessage: `Run failed on attempt ${attempt}. Healer analyzing error & failure snapshot...`
        });

        // Re-inspect if failure happened on a navigated URL or use Playwright's error-context.md
        const failureContext = execResult.errorContext || snapshot.ariaSnapshot;
        currentScript = await this.runHealerAgent(
          job.projectId,
          tc,
          currentScript,
          lastError,
          failureContext,
          snapshot
        );

        const healedSave = await this.scriptRunner.upsertScript(uid, job.projectId, job.testcaseId, {
          scriptContent: currentScript,
          framework: "playwright-ts",
          targetUrl: job.targetUrl,
          status: "draft",
          source: "healer",
          notes: `Healer fix attempt ${attempt}`,
          verifiedLocators: this.extractVerifiedLocators(snapshot)
        });
        await this.appendJobUpdate(job.id, {
          resultScriptId: healedSave.script?.id ?? null,
          resultVersionId: healedSave.script?.activeVersionId ?? null,
          logMessage: `Healer saved patched script v${healedSave.script?.activeVersion ?? "?"}. Retrying...`
        });
      }

      if (!verified) {
        const failMsg = lastError || "Healer could not verify the script within max attempts.";
        await this.appendJobUpdate(job.id, {
          stage: "failed",
          errorMessage: failMsg,
          logMessage: `Stopped after ${job.maxAttempts} attempts. Script kept as draft for manual review.`
        });
        await this.notifyZyraSession(job.id, "failed", { errorMessage: failMsg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`3-Agent job ${jobId} failed: ${msg}`);
      await this.appendJobUpdate(jobId, {
        stage: "failed",
        errorMessage: msg,
        logMessage: `Error: ${msg}`
      });
      await this.notifyZyraSession(jobId, "failed", { errorMessage: msg });
    }
  }

  private async notifyZyraSession(
    jobId: string,
    stage: "completed" | "failed",
    info: { attempt?: number; errorMessage?: string | null; resultRunId?: string | null }
  ): Promise<void> {
    try {
      const res = await this.db.query<{
        project_id: string;
        testcase_id: string | null;
        target_url: string;
        zyra_session_id: string | null;
        external_id: string | null;
        title: string | null;
      }>(
        `SELECT j.project_id, j.testcase_id, j.target_url,
                j.plan_json->>'zyraSessionId' AS zyra_session_id,
                tc.external_id, tc.title
         FROM test_agent_jobs j
         LEFT JOIN testcases tc ON tc.id = j.testcase_id
         WHERE j.id = $1
         LIMIT 1`,
        [jobId]
      );
      const row = res.rows[0];
      if (!row?.zyra_session_id || !isUuid(row.zyra_session_id)) return;

      const sessionRes = await this.db.query(
        `SELECT id FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [row.zyra_session_id, row.project_id]
      );
      if (!sessionRes.rows[0]) return;

      const tcLabel = row.external_id ? `${row.external_id} – ${row.title || ""}`.trim() : row.title || "Test Case";
      const content =
        stage === "completed"
          ? `✅ **3-Agent Playwright selesai** untuk **${tcLabel}**.\n\nScript terverifikasi pada percobaan ke-${info.attempt ?? 1} untuk \`${row.target_url}\` dan siap dijalankan di tab **Automation Script**.`
          : `❌ **3-Agent Playwright gagal** untuk **${tcLabel}**.\n\n${info.errorMessage || "Gagal memverifikasi script."}`;

      const activity = [
        {
          actor: "agent",
          title: stage === "completed" ? "3-Agent Playwright completed" : "3-Agent Playwright failed",
          detail: `${tcLabel} — Job ${jobId}`,
          createdAt: new Date().toISOString()
        }
      ];

      await this.db.query(
        `INSERT INTO zyra_chat_messages (session_id, project_id, role, content, action_type, status, activity)
         VALUES ($1, $2, 'assistant', $3, 'automation', 'completed', $4::jsonb)`,
        [row.zyra_session_id, row.project_id, content, JSON.stringify(activity)]
      );
      await this.db.query(`UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = $1`, [row.zyra_session_id]);
    } catch (err) {
      this.logger.warn(`Failed to post 3-Agent feedback to Zyra session for job ${jobId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async runExplorePipeline(job: TestAgentJobRecord, auth: DecryptedAutomationAuth | null): Promise<void> {
    await this.appendJobUpdate(job.id, {
      stage: "planning",
      logMessage: `Explorer: Inspecting ${job.targetUrl} with headless Chromium...`
    });
    const snapshot = await this.inspector.inspectPage(job.targetUrl, auth);

    const systemPrompt = [
      "You are the TestPilot Playwright Planner Agent.",
      "Analyze the live page ARIA snapshot and interactive elements below.",
      "Return ONLY valid JSON: { \"scenarios\": [ { \"title\": string, \"description\": string, \"steps\": string[], \"expectedResult\": string, \"priority\": \"low\"|\"medium\"|\"high\" } ] }.",
      "CRITICAL RULE: Only propose scenarios that interact with elements that ACTUALLY EXIST in the provided snapshot. Never invent buttons, inputs, or routes."
    ].join("\n");

    const userPrompt = [
      `Target URL: ${snapshot.url}`,
      `Page Title: ${snapshot.title}`,
      job.instructions ? `User Scope/Instructions: ${job.instructions}` : "",
      `Interactive Elements (${snapshot.interactiveElements.length}):`,
      JSON.stringify(snapshot.interactiveElements.slice(0, 60)),
      `ARIA Snapshot:`,
      snapshot.ariaSnapshot.slice(0, 6000)
    ].filter(Boolean).join("\n\n");

    const aiRes = await this.legacy.runProjectAiPrompt(job.projectId, systemPrompt, userPrompt, 3000);
    const parsed = parseJsonObject(aiRes.text);
    const rawList = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
    const scenarios: DiscoveredScenario[] = rawList.slice(0, 8).map((item: any) => ({
      title: String(item?.title || "E2E Scenario").slice(0, 140),
      description: String(item?.description || ""),
      steps: Array.isArray(item?.steps) ? item.steps.map(String) : [],
      expectedResult: String(item?.expectedResult || "Page responds as expected"),
      priority: item?.priority === "high" || item?.priority === "low" ? item.priority : "medium"
    }));

    await this.appendJobUpdate(job.id, {
      stage: "completed",
      discoveredScenarios: scenarios,
      logMessage: `Explorer discovered ${scenarios.length} grounded test scenario(s) from ${snapshot.interactiveElements.length} live elements.`
    });
  }

  private async runPlannerAgent(
    projectId: string,
    tc: Record<string, any>,
    snapshot: PageSnapshot,
    instructions: string | null
  ): Promise<Record<string, unknown>> {
    const systemPrompt = [
      "You are the TestPilot Playwright Planner Agent.",
      "Map the test case steps to the EXACT interactive elements present on the live page.",
      "Return ONLY valid JSON: { \"steps\": [ { \"action\": string, \"locator\": string, \"value\"?: string, \"assertion\"?: string } ] }.",
      "STRICT GROUNDING: Every `locator` MUST be copied verbatim from `interactiveElements[].playwrightLocator` or strictly derived from `ariaSnapshot`. NEVER guess or invent selectors."
    ].join("\n");

    const formattedSteps =
      typeof tc.steps === "string" ? tc.steps : tc.steps ? JSON.stringify(tc.steps, null, 2) : "";

    const userPrompt = [
      `Test Case: [${tc.external_id || tc.id}] ${tc.title}`,
      tc.description ? `Description: ${tc.description}` : "",
      tc.preconditions ? `Preconditions: ${tc.preconditions}` : "",
      formattedSteps ? `Test Steps:\n${formattedSteps}` : "",
      tc.postconditions ? `Expected Result / Postconditions: ${tc.postconditions}` : "",
      instructions ? `Extra Instructions: ${instructions}` : "",
      `Live Page URL: ${snapshot.url} (Title: ${snapshot.title})`,
      `Verified Interactive Elements:`,
      JSON.stringify(snapshot.interactiveElements.slice(0, 80)),
      `ARIA Snapshot:`,
      snapshot.ariaSnapshot.slice(0, 6000)
    ].filter(Boolean).join("\n\n");

    const aiRes = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, userPrompt, 2500);
    return parseJsonObject(aiRes.text);
  }

  private async runGeneratorAgent(
    projectId: string,
    tc: Record<string, any>,
    snapshot: PageSnapshot,
    plan: Record<string, unknown>
  ): Promise<string> {
    const testTitle = tc.external_id ? `[${tc.external_id}] ${tc.title}` : String(tc.title || "Generated test");
    const systemPrompt = [
      "You are the TestPilot Playwright Generator Agent.",
      "Write a complete, runnable `@playwright/test` TypeScript spec file following official Playwright best practices (playwright.dev/docs/best-practices):",
      "1. Output ONLY valid TypeScript code (no markdown explanation).",
      "2. Import `{ test, expect } from \"@playwright/test\";`.",
      "3. GROUNDING: ONLY use locators verified in the Planner output or `interactiveElements`. Never invent `data-testid` or CSS IDs.",
      "4. USER-FACING LOCATORS & STRICT MODE: Prefer `getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId`; use `.filter({ hasText })` or chaining for repeated items; avoid strict mode violations (`.first()` only if truly ambiguous).",
      "5. WEB-FIRST ASSERTIONS ONLY: Always use auto-retrying assertions like `await expect(locator).toBeVisible()`, `toContainText()`, `toHaveValue()`, `toHaveURL()`. NEVER use `expect(await locator.textContent()).toBe(...)` or `page.$()` / `elementHandle()`.",
      "6. NO HARD SLEEPS: NEVER use `page.waitForTimeout(...)`. Rely on Playwright auto-waiting and web-first assertions.",
      "7. STRUCTURE: Group logical test phases with `await test.step('...', async () => { ... });` for clear trace reporting."
    ].join("\n");

    const userPrompt = [
      `Test Title: ${JSON.stringify(testTitle)}`,
      `Target URL: ${snapshot.url}`,
      `Planner Output:\n${JSON.stringify(plan, null, 2)}`,
      `Verified Interactive Elements:\n${JSON.stringify(snapshot.interactiveElements.slice(0, 80))}`
    ].join("\n\n");

    const aiRes = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, userPrompt, 3000);
    return stripCodeFences(aiRes.text);
  }

  private async runHealerAgent(
    projectId: string,
    tc: Record<string, any>,
    failingScript: string,
    errorMessage: string,
    failureAriaContext: string,
    snapshot: PageSnapshot
  ): Promise<string> {
    const systemPrompt = [
      "You are the TestPilot Playwright Healer Agent.",
      "Fix the failing Playwright TypeScript test using the actual failure error and live page ARIA snapshot while strictly following Playwright best practices:",
      "1. Output ONLY the full corrected TypeScript spec (no prose).",
      "2. Fix strict mode violations, wrong locators, or timing issues using ONLY elements present in the ARIA snapshot or verified elements.",
      "3. NEVER insert `page.waitForTimeout(...)`, `page.$()`, or non-retrying `expect(await ...)` assertions — use web-first `await expect(locator)...` and `.filter({ hasText })`.",
      "4. Keep `await test.step(...)` structure and stay faithful to the test case intent."
    ].join("\n");

    const userPrompt = [
      `Test Case: ${tc.title}`,
      `Failing Script:\n${failingScript}`,
      `Playwright Error:\n${errorMessage.slice(0, 4000)}`,
      `Failure Page ARIA / Context:\n${failureAriaContext.slice(0, 6000)}`,
      `Initial Page Verified Elements:\n${JSON.stringify(snapshot.interactiveElements.slice(0, 60))}`
    ].join("\n\n");

    const aiRes = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, userPrompt, 3000);
    return stripCodeFences(aiRes.text);
  }

  private extractVerifiedLocators(snapshot: PageSnapshot): Record<string, string> {
    const map: Record<string, string> = {};
    snapshot.interactiveElements.slice(0, 50).forEach((el, idx) => {
      map[`el_${idx + 1}:${el.tag}`] = el.playwrightLocator;
    });
    return map;
  }

  private async runPlaywrightVerification(
    scriptContent: string,
    targetUrl: string,
    auth: DecryptedAutomationAuth | null
  ): Promise<{ passed: boolean; errorMessage: string | null; errorContext: string | null }> {
    let tempDir: string | null = null;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "testpilot-agent-"));
      const resultsDir = path.join(tempDir, "test-results");
      const specPath = path.join(tempDir, "test.spec.ts");
      const configPath = path.join(tempDir, "playwright.config.ts");

      let storageLine = "";
      if (auth?.storageStateJson) {
        const authPath = path.join(tempDir, "auth.json");
        await fs.writeFile(authPath, auth.storageStateJson, "utf8");
        storageLine = `storageState: ${JSON.stringify(authPath)},`;
      }

      const configContent = [
        `import { defineConfig } from "@playwright/test";`,
        `export default defineConfig({`,
        `  testDir: ".",`,
        `  outputDir: ${JSON.stringify(resultsDir)},`,
        `  timeout: 60000,`,
        `  reporter: [["list"]],`,
        `  use: { headless: true, baseURL: ${JSON.stringify(targetUrl)}, ${storageLine} screenshot: "only-on-failure" }`,
        `});`
      ].join("\n");

      await fs.writeFile(configPath, configContent, "utf8");
      await fs.writeFile(specPath, scriptContent, "utf8");

      const playwrightBin = path.join(process.cwd(), "node_modules", ".bin", "playwright");
      const nodeModulesDir = path.join(process.cwd(), "node_modules");
      await execFileAsync(playwrightBin, ["test", "test.spec.ts", "--config", "playwright.config.ts"], {
        cwd: tempDir,
        timeout: 90_000,
        maxBuffer: 5 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_PATH: process.env.NODE_PATH ? `${nodeModulesDir}${path.delimiter}${process.env.NODE_PATH}` : nodeModulesDir
        }
      });

      return { passed: true, errorMessage: null, errorContext: null };
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      let errorContext: string | null = null;
      if (tempDir) {
        const ctxFiles = await this.findErrorContextFiles(path.join(tempDir, "test-results"));
        if (ctxFiles.length > 0) {
          errorContext = await fs.readFile(ctxFiles[0], "utf8").catch(() => null);
        }
      }
      return {
        passed: false,
        errorMessage: (execErr.stderr || execErr.stdout || execErr.message || "Verification failed").slice(0, 8000),
        errorContext
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async findErrorContextFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.findErrorContextFiles(full)));
      else if (e.isFile() && e.name === "error-context.md") out.push(full);
    }
    return out;
  }
}
