import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { DatabaseService } from "../database/database.service";
import { isUuid, LegacyService } from "../legacy/legacy.service";
import {
  analyzeK6JsonLines,
  extractK6ChecksBreakdown,
  filterRecordedHeaders,
  generateK6FlowScript,
  generateK6Script,
  isApiCandidateUrl,
  normalizeBuilderConfig,
  normalizeFlowConfig,
  parseHarToRecordedCalls,
  parseK6SummaryJson,
  validateTargetUrl
} from "./k6-script.generator";
import {
  K6_TIMEOUT_BUFFER_MS,
  MAX_DURATION_SEC,
  MAX_OUTPUT_LENGTH,
  MAX_SCRIPT_LENGTH,
  PERFORMANCE_HTTP_METHODS,
  PERFORMANCE_RUNNER_JOB,
  PERFORMANCE_RUNNER_QUEUE,
  PERFORMANCE_TEST_MODES
} from "./performance-tests.constants";
import type {
  CreatePerformanceTestInput,
  PerformanceBuilderConfig,
  PerformanceFlowConfig,
  PerformanceHttpMethod,
  PerformanceProjectReport,
  PerformanceReportRange,
  PerformanceRunBreakdown,
  PerformanceRunRecord,
  PerformanceRunStatus,
  PerformanceRunSummary,
  PerformanceRunnerJobPayload,
  PerformanceTestMode,
  PerformanceTestRecord,
  PerformanceTimeseriesPoint,
  RecordedApiCall,
  RecorderSessionState,
  UpdatePerformanceTestInput
} from "./performance-tests.types";

interface PerformanceTestRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  mode: PerformanceTestMode;
  builder_config: PerformanceBuilderConfig | null;
  flow_config: PerformanceFlowConfig | null;
  script_content: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  latest_run_id?: string | null;
  latest_run_status?: PerformanceRunStatus | null;
  latest_run_vus?: number | null;
  latest_run_duration_sec?: number | null;
  latest_run_total_requests?: number | null;
  latest_run_rps?: number | null;
  latest_run_error_rate?: number | null;
  latest_run_avg_ms?: number | null;
  latest_run_p95_ms?: number | null;
  latest_run_thresholds_passed?: boolean | null;
  latest_run_duration_ms?: number | null;
  latest_run_created_at?: Date | string | null;
  latest_run_finished_at?: Date | string | null;
}

interface PerformanceRunRow {
  id: string;
  project_id: string;
  test_id: string;
  status: PerformanceRunStatus;
  vus: number | null;
  duration_sec: number | null;
  total_requests: number | null;
  rps: number | null;
  error_rate: number | null;
  avg_ms: number | null;
  min_ms: number | null;
  med_ms: number | null;
  p90_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  checks_passed: number | null;
  checks_failed: number | null;
  thresholds_passed: boolean | null;
  summary_json: Record<string, unknown> | null;
  timeseries_json?: PerformanceTimeseriesPoint[] | null;
  breakdown_json?: PerformanceRunBreakdown | null;
  stdout: string | null;
  stderr: string | null;
  error_message: string | null;
  triggered_by: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_ms: number | null;
  created_at: Date | string;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function truncateOutput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_OUTPUT_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_OUTPUT_LENGTH) + "\n...[truncated]";
}

function mapRunRow(row: PerformanceRunRow): PerformanceRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    testId: row.test_id,
    status: row.status,
    vus: row.vus,
    durationSec: row.duration_sec,
    totalRequests: row.total_requests,
    rps: row.rps,
    errorRate: row.error_rate,
    avgMs: row.avg_ms,
    minMs: row.min_ms,
    medMs: row.med_ms,
    p90Ms: row.p90_ms,
    p95Ms: row.p95_ms,
    maxMs: row.max_ms,
    checksPassed: row.checks_passed,
    checksFailed: row.checks_failed,
    thresholdsPassed: row.thresholds_passed,
    summaryJson: row.summary_json,
    timeseriesJson: row.timeseries_json ?? null,
    breakdownJson: row.breakdown_json ?? null,
    stdout: row.stdout,
    stderr: row.stderr,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    durationMs: row.duration_ms,
    createdAt: toIso(row.created_at) ?? new Date().toISOString()
  };
}

function mapTestRow(row: PerformanceTestRow): PerformanceTestRecord {
  const latestRun: PerformanceRunSummary | null = row.latest_run_id
    ? {
        id: row.latest_run_id,
        status: row.latest_run_status ?? "queued",
        vus: row.latest_run_vus ?? null,
        durationSec: row.latest_run_duration_sec ?? null,
        totalRequests: row.latest_run_total_requests ?? null,
        rps: row.latest_run_rps ?? null,
        errorRate: row.latest_run_error_rate ?? null,
        avgMs: row.latest_run_avg_ms ?? null,
        p95Ms: row.latest_run_p95_ms ?? null,
        thresholdsPassed: row.latest_run_thresholds_passed ?? null,
        durationMs: row.latest_run_duration_ms ?? null,
        createdAt: toIso(row.latest_run_created_at) ?? new Date().toISOString(),
        finishedAt: toIso(row.latest_run_finished_at)
      }
    : null;

  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    builderConfig: row.builder_config,
    flowConfig: row.flow_config ?? null,
    scriptContent: row.script_content,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    latestRun
  };
}

@Injectable()
export class PerformanceTestsService {
  private readonly logger = new Logger(PerformanceTestsService.name);
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly cancelledRunIds = new Set<string>();
  private readonly recorderSessions = new Map<
    string,
    {
      state: RecorderSessionState;
      browser: Browser | null;
      context: BrowserContext | null;
      page: Page | null;
    }
  >();

  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => LegacyService))
    private readonly legacy: LegacyService,
    @Optional()
    @InjectQueue(PERFORMANCE_RUNNER_QUEUE)
    private readonly queue?: Queue<PerformanceRunnerJobPayload>
  ) {}

  private assertUuid(value: string, label: string): void {
    if (!isUuid(value)) {
      throw new BadRequestException(`Invalid ${label} ID.`);
    }
  }

  private resolvePayload(input: {
    mode?: PerformanceTestMode;
    builderConfig?: PerformanceBuilderConfig | null;
    flowConfig?: PerformanceFlowConfig | null;
    scriptContent?: string | null;
  }): {
    mode: PerformanceTestMode;
    builderConfig: PerformanceBuilderConfig | null;
    flowConfig: PerformanceFlowConfig | null;
    scriptContent: string;
  } {
    const mode: PerformanceTestMode = input.mode ?? "builder";
    if (!PERFORMANCE_TEST_MODES.includes(mode)) {
      throw new BadRequestException(`Invalid mode: ${mode}`);
    }

    if (mode === "builder") {
      if (!input.builderConfig) {
        throw new BadRequestException("builderConfig is required when mode is 'builder'.");
      }
      const normalized = normalizeBuilderConfig(input.builderConfig);
      const scriptContent = generateK6Script(normalized);
      return { mode, builderConfig: normalized, flowConfig: null, scriptContent };
    }

    if (mode === "flow") {
      if (!input.flowConfig) {
        throw new BadRequestException("flowConfig is required when mode is 'flow'.");
      }
      const normalizedFlow = normalizeFlowConfig(input.flowConfig);
      const scriptContent = generateK6FlowScript(normalizedFlow);
      return { mode, builderConfig: null, flowConfig: normalizedFlow, scriptContent };
    }

    const scriptContent = (input.scriptContent ?? "").trim();
    if (!scriptContent) {
      throw new BadRequestException("scriptContent is required when mode is 'script'.");
    }
    if (scriptContent.length > MAX_SCRIPT_LENGTH) {
      throw new BadRequestException(`Script content cannot exceed ${MAX_SCRIPT_LENGTH} characters.`);
    }

    return {
      mode,
      builderConfig: input.builderConfig ? normalizeBuilderConfig(input.builderConfig) : null,
      flowConfig: input.flowConfig ? normalizeFlowConfig(input.flowConfig) : null,
      scriptContent
    };
  }

  async listTests(userId: string | null | undefined, projectId: string): Promise<{ list: PerformanceTestRecord[] }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { rows } = await this.db.query<PerformanceTestRow>(
      `
      SELECT
        pt.*,
        lr.id AS latest_run_id,
        lr.status AS latest_run_status,
        lr.vus AS latest_run_vus,
        lr.duration_sec AS latest_run_duration_sec,
        lr.total_requests AS latest_run_total_requests,
        lr.rps AS latest_run_rps,
        lr.error_rate AS latest_run_error_rate,
        lr.avg_ms AS latest_run_avg_ms,
        lr.p95_ms AS latest_run_p95_ms,
        lr.thresholds_passed AS latest_run_thresholds_passed,
        lr.duration_ms AS latest_run_duration_ms,
        lr.created_at AS latest_run_created_at,
        lr.finished_at AS latest_run_finished_at
      FROM performance_tests pt
      LEFT JOIN LATERAL (
        SELECT *
        FROM performance_test_runs r
        WHERE r.test_id = pt.id
        ORDER BY r.created_at DESC
        LIMIT 1
      ) lr ON TRUE
      WHERE pt.project_id = $1 AND pt.deleted_at IS NULL
      ORDER BY pt.created_at DESC
      `,
      [projectId]
    );

    return { list: rows.map(mapTestRow) };
  }

  async createTest(
    userId: string | null | undefined,
    projectId: string,
    input: CreatePerformanceTestInput
  ): Promise<{ test: PerformanceTestRecord }> {
    this.assertUuid(projectId, "project");
    const { uid } = await this.legacy.requireProjectAccess(userId, projectId);

    const name = (input.name ?? "").trim();
    if (!name) {
      throw new BadRequestException("Performance test name is required.");
    }
    if (name.length > 255) {
      throw new BadRequestException("Performance test name cannot exceed 255 characters.");
    }

    const { mode, builderConfig, flowConfig, scriptContent } = this.resolvePayload(input);
    const description = input.description?.trim() || null;

    const { rows } = await this.db.query<PerformanceTestRow>(
      `
      INSERT INTO performance_tests (
        project_id, name, description, mode, builder_config, flow_config, script_content, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $8)
      RETURNING *
      `,
      [
        projectId,
        name,
        description,
        mode,
        builderConfig ? JSON.stringify(builderConfig) : null,
        flowConfig ? JSON.stringify(flowConfig) : null,
        scriptContent,
        uid ?? null
      ]
    );

    return { test: mapTestRow(rows[0]) };
  }

  async getTest(
    userId: string | null | undefined,
    projectId: string,
    testId: string
  ): Promise<{ test: PerformanceTestRecord; runs: PerformanceRunRecord[] }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { rows: testRows } = await this.db.query<PerformanceTestRow>(
      `SELECT * FROM performance_tests WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [testId, projectId]
    );
    if (testRows.length === 0) {
      throw new NotFoundException("Performance test not found.");
    }

    const { rows: runRows } = await this.db.query<PerformanceRunRow>(
      `
      SELECT *
      FROM performance_test_runs
      WHERE test_id = $1 AND project_id = $2
      ORDER BY created_at DESC
      LIMIT 30
      `,
      [testId, projectId]
    );

    return {
      test: mapTestRow(testRows[0]),
      runs: runRows.map(mapRunRow)
    };
  }

  async updateTest(
    userId: string | null | undefined,
    projectId: string,
    testId: string,
    input: UpdatePerformanceTestInput
  ): Promise<{ test: PerformanceTestRecord }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    const { uid } = await this.legacy.requireProjectAccess(userId, projectId);

    const { rows: existingRows } = await this.db.query<PerformanceTestRow>(
      `SELECT * FROM performance_tests WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [testId, projectId]
    );
    if (existingRows.length === 0) {
      throw new NotFoundException("Performance test not found.");
    }
    const existing = existingRows[0];

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) {
      throw new BadRequestException("Performance test name cannot be empty.");
    }
    if (name.length > 255) {
      throw new BadRequestException("Performance test name cannot exceed 255 characters.");
    }

    const description =
      input.description !== undefined ? input.description?.trim() || null : existing.description;

    const { mode, builderConfig, flowConfig, scriptContent } = this.resolvePayload({
      mode: input.mode ?? existing.mode,
      builderConfig: input.builderConfig !== undefined ? input.builderConfig : existing.builder_config,
      flowConfig: input.flowConfig !== undefined ? input.flowConfig : existing.flow_config,
      scriptContent: input.scriptContent !== undefined ? input.scriptContent : existing.script_content
    });

    const { rows } = await this.db.query<PerformanceTestRow>(
      `
      UPDATE performance_tests
      SET name = $1,
          description = $2,
          mode = $3,
          builder_config = $4::jsonb,
          flow_config = $5::jsonb,
          script_content = $6,
          updated_by = $7,
          updated_at = now()
      WHERE id = $8 AND project_id = $9
      RETURNING *
      `,
      [
        name,
        description,
        mode,
        builderConfig ? JSON.stringify(builderConfig) : null,
        flowConfig ? JSON.stringify(flowConfig) : null,
        scriptContent,
        uid ?? null,
        testId,
        projectId
      ]
    );

    return { test: mapTestRow(rows[0]) };
  }

  async deleteTest(
    userId: string | null | undefined,
    projectId: string,
    testId: string
  ): Promise<{ deleted: true }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    const { uid } = await this.legacy.requireProjectAccess(userId, projectId);

    const { rowCount } = await this.db.query(
      `
      UPDATE performance_tests
      SET deleted_at = now(), updated_by = $3, updated_at = now()
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
      `,
      [testId, projectId, uid ?? null]
    );

    if (!rowCount) {
      throw new NotFoundException("Performance test not found.");
    }

    return { deleted: true };
  }

  async triggerRun(
    userId: string | null | undefined,
    projectId: string,
    testId: string
  ): Promise<{ run: PerformanceRunRecord }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    const { uid } = await this.legacy.requireProjectAccess(userId, projectId);

    const { rows: testRows } = await this.db.query<PerformanceTestRow>(
      `SELECT * FROM performance_tests WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [testId, projectId]
    );
    if (testRows.length === 0) {
      throw new NotFoundException("Performance test not found.");
    }

    const test = testRows[0];
    const activeCfg = test.builder_config ?? test.flow_config;
    const vus = activeCfg?.stages?.length
      ? Math.max(...activeCfg.stages.map((s) => s.targetVus))
      : (activeCfg?.vus ?? null);
    const durationSec = activeCfg?.stages?.length
      ? activeCfg.stages.reduce((acc, s) => acc + s.durationSec, 0)
      : (activeCfg?.durationSec ?? null);

    const { rows: runRows } = await this.db.query<PerformanceRunRow>(
      `
      INSERT INTO performance_test_runs (
        project_id, test_id, status, vus, duration_sec, triggered_by
      )
      VALUES ($1, $2, 'queued', $3, $4, $5)
      RETURNING *
      `,
      [projectId, testId, vus, durationSec, uid ?? null]
    );
    const run = mapRunRow(runRows[0]);

    if (this.queue) {
      await this.queue.add(
        PERFORMANCE_RUNNER_JOB,
        { runId: run.id },
        { removeOnComplete: 100, removeOnFail: 100 }
      );
    } else {
      setImmediate(() => {
        void this.executeRunJob(run.id).catch((err) => {
          this.logger.error(`Background k6 run ${run.id} failed`, err);
        });
      });
    }

    return { run };
  }

  async getRun(
    userId: string | null | undefined,
    projectId: string,
    testId: string,
    runId: string
  ): Promise<{ run: PerformanceRunRecord }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    this.assertUuid(runId, "run");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { rows } = await this.db.query<PerformanceRunRow>(
      `SELECT * FROM performance_test_runs WHERE id = $1 AND test_id = $2 AND project_id = $3`,
      [runId, testId, projectId]
    );
    if (rows.length === 0) {
      throw new NotFoundException("Performance test run not found.");
    }

    return { run: mapRunRow(rows[0]) };
  }

  async cancelRun(
    userId: string | null | undefined,
    projectId: string,
    testId: string,
    runId: string
  ): Promise<{ run: PerformanceRunRecord }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    this.assertUuid(runId, "run");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { rows } = await this.db.query<PerformanceRunRow>(
      `SELECT * FROM performance_test_runs WHERE id = $1 AND test_id = $2 AND project_id = $3`,
      [runId, testId, projectId]
    );
    if (rows.length === 0) {
      throw new NotFoundException("Performance test run not found.");
    }

    const current = rows[0];
    if (current.status !== "queued" && current.status !== "running") {
      return { run: mapRunRow(current) };
    }

    this.cancelledRunIds.add(runId);
    const activeProc = this.activeProcesses.get(runId);
    if (activeProc && !activeProc.killed) {
      activeProc.kill("SIGTERM");
    }

    const { rows: updated } = await this.db.query<PerformanceRunRow>(
      `
      UPDATE performance_test_runs
      SET status = 'cancelled', finished_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [runId]
    );

    return { run: mapRunRow(updated[0]) };
  }

  async executeRunJob(runId: string): Promise<void> {
    const { rows } = await this.db.query<
      PerformanceRunRow & { script_content: string; mode: PerformanceTestMode; builder_config: PerformanceBuilderConfig | null }
    >(
      `
      SELECT r.*, pt.script_content, pt.mode, pt.builder_config
      FROM performance_test_runs r
      JOIN performance_tests pt ON pt.id = r.test_id
      WHERE r.id = $1
      `,
      [runId]
    );

    const jobData = rows[0];
    if (!jobData) {
      this.logger.warn(`Performance run ${runId} not found, skipping.`);
      return;
    }

    if (jobData.status === "cancelled" || this.cancelledRunIds.has(runId)) {
      this.cancelledRunIds.delete(runId);
      return;
    }

    await this.db.query(
      `UPDATE performance_test_runs SET status = 'running', started_at = now() WHERE id = $1`,
      [runId]
    );

    const startedAt = Date.now();
    let tempDir: string | null = null;

    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "testpilot-k6-"));
      const scriptPath = path.join(tempDir, "script.js");
      const summaryPath = path.join(tempDir, "summary.json");
      const pointsPath = path.join(tempDir, "points.jsonl");

      await fs.writeFile(scriptPath, jobData.script_content, "utf8");

      const maxTimeoutMs = (Math.min(jobData.duration_sec ?? MAX_DURATION_SEC, MAX_DURATION_SEC) * 1000) + K6_TIMEOUT_BUFFER_MS;
      const k6Bin = process.env.K6_BINARY_PATH || "k6";

      const result = await this.spawnK6(
        k6Bin,
        ["run", scriptPath, "--summary-export", summaryPath, "--out", `json=${pointsPath}`, "--no-color"],
        {
          cwd: tempDir,
          timeoutMs: maxTimeoutMs,
          runId
        }
      );

      if (this.cancelledRunIds.has(runId)) {
        this.cancelledRunIds.delete(runId);
        return;
      }

      let rawSummary: Record<string, unknown> | null = null;
      try {
        const summaryText = await fs.readFile(summaryPath, "utf8");
        rawSummary = JSON.parse(summaryText) as Record<string, unknown>;
      } catch {
        rawSummary = null;
      }

      let timeseries: PerformanceTimeseriesPoint[] | null = null;
      let breakdown: PerformanceRunBreakdown | null = null;
      const checksList = extractK6ChecksBreakdown(rawSummary);
      try {
        const ndjson = await fs.readFile(pointsPath, "utf8");
        const analyzed = analyzeK6JsonLines(ndjson);
        if (analyzed.timeseries.length > 0) timeseries = analyzed.timeseries;
        if (analyzed.endpoints.length > 0 || Object.keys(analyzed.statusCodes).length > 0 || checksList.length > 0) {
          breakdown = {
            endpoints: analyzed.endpoints,
            statusCodes: analyzed.statusCodes,
            checks: checksList
          };
        }
      } catch {
        timeseries = null;
        if (checksList.length > 0) {
          breakdown = { endpoints: [], statusCodes: {}, checks: checksList };
        }
      }

      const parsed = rawSummary ? parseK6SummaryJson(rawSummary) : null;
      let finalStatus: PerformanceRunStatus = "passed";
      let errorMessage: string | null = null;

      if (result.timedOut) {
        finalStatus = "error";
        errorMessage = `k6 execution timed out after ${Math.round(maxTimeoutMs / 1000)}s.`;
      } else if (result.exitCode === 99) {
        // k6 exits with 99 when one or more thresholds fail.
        finalStatus = "failed";
        errorMessage = "One or more k6 thresholds failed.";
      } else if (result.exitCode !== 0) {
        finalStatus = "error";
        errorMessage = truncateOutput(result.stderr) || `k6 exited with code ${result.exitCode ?? "unknown"}.`;
      }

      await this.db.query(
        `
        UPDATE performance_test_runs
        SET status = $2,
            total_requests = $3,
            rps = $4,
            error_rate = $5,
            avg_ms = $6,
            min_ms = $7,
            med_ms = $8,
            p90_ms = $9,
            p95_ms = $10,
            max_ms = $11,
            checks_passed = $12,
            checks_failed = $13,
            thresholds_passed = $14,
            summary_json = $15::jsonb,
            timeseries_json = $16::jsonb,
            breakdown_json = $17::jsonb,
            stdout = $18,
            stderr = $19,
            error_message = $20,
            duration_ms = $21,
            finished_at = now()
        WHERE id = $1
        `,
        [
          runId,
          finalStatus,
          parsed?.totalRequests ?? null,
          parsed?.rps ?? null,
          parsed?.errorRate ?? null,
          parsed?.avgMs ?? null,
          parsed?.minMs ?? null,
          parsed?.medMs ?? null,
          parsed?.p90Ms ?? null,
          parsed?.p95Ms ?? null,
          parsed?.maxMs ?? null,
          parsed?.checksPassed ?? null,
          parsed?.checksFailed ?? null,
          parsed?.thresholdsPassed ?? null,
          rawSummary ? JSON.stringify(rawSummary) : null,
          timeseries ? JSON.stringify(timeseries) : null,
          breakdown ? JSON.stringify(breakdown) : null,
          truncateOutput(result.stdout),
          truncateOutput(result.stderr),
          errorMessage,
          Date.now() - startedAt
        ]
      );
    } catch (err) {
      if (this.cancelledRunIds.has(runId)) {
        this.cancelledRunIds.delete(runId);
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to execute k6.";
      await this.db.query(
        `
        UPDATE performance_test_runs
        SET status = 'error',
            error_message = $2,
            duration_ms = $3,
            finished_at = now()
        WHERE id = $1
        `,
        [runId, truncateOutput(message), Date.now() - startedAt]
      );
    } finally {
      this.activeProcesses.delete(runId);
      this.cancelledRunIds.delete(runId);
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private spawnK6(
    bin: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; runId: string }
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, HOME: opts.cwd, K6_NO_USAGE_REPORT: "true" },
        stdio: ["ignore", "pipe", "pipe"]
      });

      this.activeProcesses.set(opts.runId, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_LENGTH * 2) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_LENGTH * 2) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
  }

  /**
   * Launches a Playwright Chromium browser window and records XHR/Fetch API calls in real time.
   */
  async startRecorderSession(
    userId: string | null | undefined,
    projectId: string,
    startUrl: string
  ): Promise<{ session: RecorderSessionState }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);
    const validatedUrl = validateTargetUrl(startUrl);

    const hasDisplay =
      Boolean(process.env.DISPLAY) || process.platform === "darwin" || process.platform === "win32";
    const interactive = !hasDisplay;

    const sessionId = randomUUID();
    const state: RecorderSessionState = {
      sessionId,
      projectId,
      startUrl: validatedUrl,
      currentUrl: validatedUrl,
      interactive,
      status: "recording",
      capturedCalls: [],
      errorMessage: null,
      startedAt: new Date().toISOString()
    };

    try {
      const browser = await chromium.launch({ headless: interactive });
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();

      const pendingCalls = new Map<object, RecordedApiCall>();

      context.on("request", (req) => {
        const resourceType = req.resourceType();
        const url = req.url();
        const method = req.method().toUpperCase() as PerformanceHttpMethod;
        if (!PERFORMANCE_HTTP_METHODS.includes(method)) return;
        if (!isApiCandidateUrl(url, resourceType, method)) return;

        const call: RecordedApiCall = {
          id: `rec-${state.capturedCalls.length + 1}`,
          method,
          url,
          headers: filterRecordedHeaders(req.headers()),
          body: req.postData() ?? null,
          status: null,
          resourceType,
          timestamp: new Date().toISOString()
        };
        pendingCalls.set(req, call);
        state.capturedCalls.push(call);
      });

      context.on("response", (res) => {
        const call = pendingCalls.get(res.request());
        if (call) {
          call.status = res.status();
        }
      });

      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          state.currentUrl = frame.url();
        }
      });

      browser.on("disconnected", () => {
        if (state.status === "recording") {
          state.status = "stopped";
        }
      });

      this.recorderSessions.set(sessionId, { state, browser, context, page });
      try {
        await page.goto(validatedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (navErr) {
        state.errorMessage =
          navErr instanceof Error
            ? `Failed to load ${validatedUrl}: ${navErr.message.split("\n")[0]}`
            : `Failed to load ${validatedUrl}`;
      }
      state.currentUrl = page.url();
      if (!state.errorMessage && state.currentUrl.startsWith("chrome-error://")) {
        state.errorMessage = `Browser could not load ${validatedUrl} (check URL, DNS, or network access from the backend container).`;
      }

      return { session: state };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unable to launch browser recorder. Use HAR import as an alternative.";
      state.status = "error";
      state.errorMessage = msg;
      this.recorderSessions.set(sessionId, { state, browser: null, context: null, page: null });
      throw new BadRequestException({ error: msg });
    }
  }

  async getRecorderSession(
    userId: string | null | undefined,
    projectId: string,
    sessionId: string
  ): Promise<{ session: RecorderSessionState }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const entry = this.recorderSessions.get(sessionId);
    if (!entry || entry.state.projectId !== projectId) {
      throw new NotFoundException("Recorder session not found.");
    }
    return { session: entry.state };
  }

  async getRecorderFrame(
    userId: string | null | undefined,
    projectId: string,
    sessionId: string
  ): Promise<Buffer> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const entry = this.recorderSessions.get(sessionId);
    if (!entry || entry.state.projectId !== projectId || !entry.page) {
      throw new NotFoundException("Active recorder page not found.");
    }
    try {
      return await entry.page.screenshot({ type: "jpeg", quality: 70 });
    } catch {
      // Return empty buffer if page is mid-navigation or closing
      return Buffer.alloc(0);
    }
  }

  async performRecorderAction(
    userId: string | null | undefined,
    projectId: string,
    sessionId: string,
    action: {
      type: string;
      x?: number;
      y?: number;
      text?: string;
      key?: string;
      url?: string;
      deltaY?: number;
      value?: string;
    }
  ): Promise<{ session: RecorderSessionState }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const entry = this.recorderSessions.get(sessionId);
    if (!entry || entry.state.projectId !== projectId || !entry.page) {
      throw new NotFoundException("Active recorder page not found.");
    }

    const page = entry.page;
    if (action.type === "click" && typeof action.x === "number" && typeof action.y === "number") {
      const selectInfo = await page
        .evaluate(({ px, py }) => {
          const el = document.elementFromPoint(px, py);
          const sel = el?.closest("select") as HTMLSelectElement | null;
          if (!sel) return null;
          return Array.from(sel.options).map((opt) => ({
            value: opt.value,
            text: opt.text,
            selected: opt.selected
          }));
        }, { px: action.x, py: action.y })
        .catch(() => null);

      if (selectInfo && selectInfo.length > 0) {
        entry.state.activeSelect = { x: action.x, y: action.y, options: selectInfo };
      } else {
        entry.state.activeSelect = null;
        await page.mouse.click(action.x, action.y);
      }
    } else if (
      action.type === "select" &&
      typeof action.x === "number" &&
      typeof action.y === "number" &&
      typeof action.value === "string"
    ) {
      await page
        .evaluate(
          ({ px, py, val }) => {
            const el = document.elementFromPoint(px, py);
            const sel = el?.closest("select") as HTMLSelectElement | null;
            if (!sel) return;
            sel.value = val;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          },
          { px: action.x, py: action.y, val: action.value }
        )
        .catch(() => undefined);
      entry.state.activeSelect = null;
    } else if (action.type === "type" && typeof action.text === "string") {
      await page.keyboard.type(action.text);
    } else if (action.type === "key" && typeof action.key === "string") {
      await page.keyboard.press(action.key);
    } else if (action.type === "scroll" && typeof action.deltaY === "number") {
      await page.mouse.wheel(0, action.deltaY);
    } else if (action.type === "goto" && typeof action.url === "string") {
      const target = validateTargetUrl(action.url);
      entry.state.activeSelect = null;
      entry.state.errorMessage = null;
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (navErr) {
        entry.state.errorMessage =
          navErr instanceof Error
            ? `Failed to load ${target}: ${navErr.message.split("\n")[0]}`
            : `Failed to load ${target}`;
      }
    }

    entry.state.currentUrl = page.url();
    return { session: entry.state };
  }

  async stopRecorderSession(
    userId: string | null | undefined,
    projectId: string,
    sessionId: string
  ): Promise<{ session: RecorderSessionState }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const entry = this.recorderSessions.get(sessionId);
    if (!entry || entry.state.projectId !== projectId) {
      throw new NotFoundException("Recorder session not found.");
    }

    entry.state.status = "stopped";
    if (entry.browser) {
      await entry.browser.close().catch(() => undefined);
      entry.browser = null;
      entry.context = null;
      entry.page = null;
    }

    return { session: entry.state };
  }

  async importHar(
    userId: string | null | undefined,
    projectId: string,
    harJson: unknown
  ): Promise<{ calls: RecordedApiCall[] }> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);
    return { calls: parseHarToRecordedCalls(harJson) };
  }

  /**
   * Renders a professional A4 PDF report for a performance test run using Playwright Chromium.
   */
  async exportRunPdf(
    userId: string | null | undefined,
    projectId: string,
    testId: string,
    runId: string
  ): Promise<{ content: Buffer; contentType: string; fileName: string }> {
    this.assertUuid(projectId, "project");
    this.assertUuid(testId, "performance test");
    this.assertUuid(runId, "run");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { test } = await this.getTest(userId, projectId, testId);
    const { run } = await this.getRun(userId, projectId, testId, runId);

    const escapeHtml = (str: string) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const parsed = run.summaryJson ? parseK6SummaryJson(run.summaryJson) : null;
    const metrics = (run.summaryJson?.metrics ?? {}) as Record<
      string,
      { values?: Record<string, number>; avg?: number; count?: number }
    >;

    const phases = [
      { key: "http_req_blocked", label: "Blocked" },
      { key: "http_req_connecting", label: "Connecting" },
      { key: "http_req_tls_handshaking", label: "TLS Handshake" },
      { key: "http_req_sending", label: "Sending" },
      { key: "http_req_waiting", label: "Waiting (TTFB)" },
      { key: "http_req_receiving", label: "Receiving" }
    ].map((p) => {
      const m = metrics[p.key];
      const avg = m?.values?.avg ?? m?.avg ?? 0;
      return { label: p.label, avgMs: typeof avg === "number" && Number.isFinite(avg) ? avg : 0 };
    });

    const checksPassed = run.checksPassed ?? 0;
    const checksFailed = run.checksFailed ?? 0;
    const totalChecks = checksPassed + checksFailed;
    const checkPct = totalChecks > 0 ? Math.round((checksPassed / totalChecks) * 100) : null;

    const statusBg =
      run.status === "passed"
        ? "#dcfce7;color:#166534"
        : run.status === "failed" || run.status === "error"
        ? "#fee2e2;color:#991b1b"
        : "#e0f2fe;color:#075985";

    const buildSparkSvg = (values: number[], color: string): string => {
      if (values.length < 2) return "";
      const w = 320;
      const h = 80;
      const pad = 8;
      const max = Math.max(...values, 1);
      const pts = values
        .map((v, i) => {
          const x = pad + (i / (values.length - 1)) * (w - pad * 2);
          const y = pad + (h - pad * 2) - (v / max) * (h - pad * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="80" style="background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" /></svg>`;
    };

    const ts = run.timeseriesJson ?? [];
    const p95Svg = buildSparkSvg(
      ts.map((p) => p.p95Ms),
      "#2563eb"
    );
    const rpsSvg = buildSparkSvg(
      ts.map((p) => p.rps),
      "#16a34a"
    );

    const thresholdRows = (parsed?.thresholds ?? [])
      .map(
        (t) =>
          `<tr><td><code>${escapeHtml(t.metric)}: ${escapeHtml(t.expression)}</code></td><td style="text-align:right;font-weight:600;color:${
            t.ok ? "#16a34a" : "#dc2626"
          }">${t.ok ? "PASS" : "FAIL"}</td></tr>`
      )
      .join("");

    const breakdown = run.breakdownJson;
    const endpointRows = (breakdown?.endpoints ?? [])
      .map(
        (ep) =>
          `<tr>
            <td><strong>${escapeHtml(ep.method)}</strong></td>
            <td class="mono">${escapeHtml(ep.url)}</td>
            <td class="mono" style="text-align:right">${ep.count}</td>
            <td class="mono" style="text-align:right">${ep.failed} (${(ep.errorRate * 100).toFixed(1)}%)</td>
            <td class="mono" style="text-align:right">${ep.avgMs.toFixed(1)}</td>
            <td class="mono" style="text-align:right">${ep.p95Ms.toFixed(1)}</td>
            <td class="mono" style="text-align:right">${ep.maxMs.toFixed(1)}</td>
          </tr>`
      )
      .join("");

    const statusBadges = Object.entries(breakdown?.statusCodes ?? {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(
        ([code, count]) =>
          `<span style="display:inline-block;margin-right:8px;padding:3px 8px;border-radius:6px;background:#f1f5f9;font-family:ui-monospace,monospace;font-size:11px;"><strong>HTTP ${escapeHtml(code)}</strong>: ${count}</span>`
      )
      .join("");

    const checksList = breakdown?.checks ?? extractK6ChecksBreakdown(run.summaryJson);
    const checkRows = checksList
      .map(
        (c) =>
          `<tr>
            <td>${escapeHtml(c.group)}</td>
            <td>${escapeHtml(c.name)}</td>
            <td class="mono" style="text-align:right;color:#16a34a">${c.passes}</td>
            <td class="mono" style="text-align:right;color:${c.fails > 0 ? "#dc2626" : "#64748b"}">${c.fails}</td>
          </tr>`
      )
      .join("");

    const pdfHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 0; font-size: 12px; line-height: 1.45; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
    .sub { color: #64748b; font-size: 11px; margin: 0; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: ${statusBg}; }
    .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
    .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; background: #f8fafc; }
    .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; }
    .kpi-val { font-size: 18px; font-weight: 700; font-family: ui-monospace, monospace; margin-top: 4px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
    .card h3 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    td, th { padding: 5px 6px; border-bottom: 1px solid #f1f5f9; text-align: left; }
    .mono { font-family: ui-monospace, monospace; }
    pre { background: #0f172a; color: #f8fafc; padding: 10px; border-radius: 6px; font-size: 10px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 class="title">${escapeHtml(test.name)}</h1>
      <p class="sub">Mode: <strong>${escapeHtml(test.mode.toUpperCase())}</strong> &middot; VUs: ${
        run.vus ?? "—"
      } &middot; Duration: ${run.durationSec ?? "—"}s &middot; Executed: ${escapeHtml(
      new Date(run.createdAt).toLocaleString()
    )}</p>
    </div>
    <span class="badge">${escapeHtml(run.status)}</span>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Total Requests</div><div class="kpi-val">${
      run.totalRequests !== null ? run.totalRequests.toLocaleString() : "—"
    }</div></div>
    <div class="kpi"><div class="kpi-label">Throughput (RPS)</div><div class="kpi-val">${
      run.rps !== null ? `${run.rps.toFixed(2)} /s` : "—"
    }</div></div>
    <div class="kpi"><div class="kpi-label">p95 Latency</div><div class="kpi-val">${
      run.p95Ms !== null ? `${run.p95Ms.toFixed(2)} ms` : "—"
    }</div></div>
    <div class="kpi"><div class="kpi-label">Error Rate</div><div class="kpi-val">${
      run.errorRate !== null ? `${(run.errorRate * 100).toFixed(2)}%` : "—"
    }</div></div>
    <div class="kpi"><div class="kpi-label">Checks Pass</div><div class="kpi-val">${
      checkPct !== null ? `${checkPct}% (${checksPassed}/${totalChecks})` : "—"
    }</div></div>
    <div class="kpi"><div class="kpi-label">Avg Latency</div><div class="kpi-val">${
      run.avgMs !== null ? `${run.avgMs.toFixed(2)} ms` : "—"
    }</div></div>
  </div>

  ${
    ts.length >= 2
      ? `<div class="grid-2">
           <div class="card"><h3>p95 Latency Over Time (ms)</h3>${p95Svg}</div>
           <div class="card"><h3>Requests / sec Over Time</h3>${rpsSvg}</div>
         </div>`
      : ""
  }

  <div class="grid-2">
    <div class="card">
      <h3>Latency Percentiles</h3>
      <table>
        <tr><td>Min</td><td class="mono" style="text-align:right">${run.minMs !== null ? `${run.minMs.toFixed(2)} ms` : "—"}</td></tr>
        <tr><td>Median</td><td class="mono" style="text-align:right">${run.medMs !== null ? `${run.medMs.toFixed(2)} ms` : "—"}</td></tr>
        <tr><td>Average</td><td class="mono" style="text-align:right">${run.avgMs !== null ? `${run.avgMs.toFixed(2)} ms` : "—"}</td></tr>
        <tr><td>p90</td><td class="mono" style="text-align:right">${run.p90Ms !== null ? `${run.p90Ms.toFixed(2)} ms` : "—"}</td></tr>
        <tr><td>p95</td><td class="mono" style="text-align:right">${run.p95Ms !== null ? `${run.p95Ms.toFixed(2)} ms` : "—"}</td></tr>
        <tr><td>Max</td><td class="mono" style="text-align:right">${run.maxMs !== null ? `${run.maxMs.toFixed(2)} ms` : "—"}</td></tr>
      </table>
    </div>
    <div class="card">
      <h3>HTTP Phase Timings (Avg)</h3>
      <table>
        ${phases
          .map(
            (p) =>
              `<tr><td>${escapeHtml(p.label)}</td><td class="mono" style="text-align:right">${p.avgMs.toFixed(2)} ms</td></tr>`
          )
          .join("")}
      </table>
    </div>
  </div>

  ${
    thresholdRows
      ? `<div class="card" style="margin-bottom:16px"><h3>k6 Thresholds</h3><table>${thresholdRows}</table></div>`
      : ""
  }

  ${
    statusBadges
      ? `<div class="card" style="margin-bottom:16px"><h3>HTTP Status Code Distribution</h3><div>${statusBadges}</div></div>`
      : ""
  }

  ${
    endpointRows
      ? `<div class="card" style="margin-bottom:16px"><h3>Endpoint Breakdown</h3><table><tr><th>Method</th><th>Endpoint / URL</th><th style="text-align:right">Reqs</th><th style="text-align:right">Errors</th><th style="text-align:right">Avg (ms)</th><th style="text-align:right">p95 (ms)</th><th style="text-align:right">Max (ms)</th></tr>${endpointRows}</table></div>`
      : ""
  }

  ${
    checkRows
      ? `<div class="card" style="margin-bottom:16px"><h3>Checks Breakdown</h3><table><tr><th>Group</th><th>Check Name</th><th style="text-align:right">Passed</th><th style="text-align:right">Failed</th></tr>${checkRows}</table></div>`
      : ""
  }
</body>
</html>`;

    const slug = test.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "performance-report";

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(pdfHtml, { waitUntil: "load" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `<div></div>`,
        footerTemplate: `<div style="width:100%;font-size:9px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between;"><span>TestPilot Performance Report (Grafana k6)</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" }
      });
      return {
        content: Buffer.from(pdfBuffer),
        contentType: "application/pdf",
        fileName: `${slug}-k6-report.pdf`
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Computes project-wide Performance Tests report (KPIs, trend, per-scenario breakdown,
   * and top slowest endpoints) for Reports & Insights.
   */
  async getProjectReport(
    userId: string | null | undefined,
    projectId: string,
    range: PerformanceReportRange = "30d"
  ): Promise<PerformanceProjectReport> {
    this.assertUuid(projectId, "project");
    await this.legacy.requireProjectAccess(userId, projectId);

    const { rows: testRows } = await this.db.query<PerformanceTestRow>(
      `SELECT * FROM performance_tests WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [projectId]
    );

    const intervalSql =
      range === "7d"
        ? "AND r.created_at >= now() - interval '7 days'"
        : range === "30d"
        ? "AND r.created_at >= now() - interval '30 days'"
        : "";

    const { rows: runRows } = await this.db.query<
      PerformanceRunRow & { test_name: string }
    >(
      `
      SELECT r.*, pt.name AS test_name
      FROM performance_test_runs r
      JOIN performance_tests pt ON pt.id = r.test_id
      WHERE r.project_id = $1
        AND pt.deleted_at IS NULL
        ${intervalSql}
      ORDER BY r.created_at DESC
      LIMIT 200
      `,
      [projectId]
    );

    const completedRuns = runRows.filter((r) => r.status === "passed" || r.status === "failed" || r.status === "error");
    const passedRuns = completedRuns.filter((r) => r.status === "passed").length;
    const failedRuns = completedRuns.filter((r) => r.status === "failed" || r.status === "error").length;
    const passRatePct = completedRuns.length > 0 ? Math.round((passedRuns / completedRuns.length) * 100) : null;

    const avgNullable = (vals: Array<number | null | undefined>): number | null => {
      const nums = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (nums.length === 0) return null;
      return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
    };

    const trend = [...completedRuns]
      .slice(0, 40)
      .reverse()
      .map((r) => ({
        runId: r.id,
        testId: r.test_id,
        testName: r.test_name,
        status: r.status,
        p95Ms: r.p95_ms,
        rps: r.rps,
        errorRate: r.error_rate,
        createdAt: toIso(r.created_at) ?? new Date().toISOString()
      }));

    const runsByTest = new Map<string, Array<PerformanceRunRow & { test_name: string }>>();
    for (const r of runRows) {
      const list = runsByTest.get(r.test_id) ?? [];
      list.push(r);
      runsByTest.set(r.test_id, list);
    }

    const scenarios = testRows.map((t) => {
      const tRuns = runsByTest.get(t.id) ?? [];
      const tCompleted = tRuns.filter((r) => r.status === "passed" || r.status === "failed" || r.status === "error");
      const tPassed = tCompleted.filter((r) => r.status === "passed").length;
      const tFailed = tCompleted.filter((r) => r.status === "failed" || r.status === "error").length;
      const latest = tRuns[0] ?? null;
      return {
        id: t.id,
        name: t.name,
        mode: t.mode,
        totalRuns: tRuns.length,
        passedRuns: tPassed,
        failedRuns: tFailed,
        passRatePct: tCompleted.length > 0 ? Math.round((tPassed / tCompleted.length) * 100) : null,
        avgP95Ms: avgNullable(tCompleted.map((r) => r.p95_ms)),
        avgRps: avgNullable(tCompleted.map((r) => r.rps)),
        avgErrorRate: avgNullable(tCompleted.map((r) => r.error_rate)),
        latestStatus: latest ? latest.status : null,
        latestRunAt: latest ? toIso(latest.created_at) : null
      };
    });

    const endpointAgg = new Map<
      string,
      {
        method: string;
        url: string;
        testId: string;
        testName: string;
        totalCount: number;
        failedCount: number;
        avgSum: number;
        p95Max: number;
        maxMs: number;
        samples: number;
      }
    >();

    for (const r of completedRuns) {
      const eps = r.breakdown_json?.endpoints ?? [];
      for (const ep of eps) {
        const key = `${r.test_id}::${ep.method}::${ep.url}`;
        const cur = endpointAgg.get(key) ?? {
          method: ep.method,
          url: ep.url,
          testId: r.test_id,
          testName: r.test_name,
          totalCount: 0,
          failedCount: 0,
          avgSum: 0,
          p95Max: 0,
          maxMs: 0,
          samples: 0
        };
        cur.totalCount += ep.count;
        cur.failedCount += ep.failed;
        cur.avgSum += ep.avgMs;
        cur.p95Max = Math.max(cur.p95Max, ep.p95Ms);
        cur.maxMs = Math.max(cur.maxMs, ep.maxMs);
        cur.samples += 1;
        endpointAgg.set(key, cur);
      }
    }

    const slowestEndpoints = Array.from(endpointAgg.values())
      .map((ep) => ({
        method: ep.method,
        url: ep.url,
        testId: ep.testId,
        testName: ep.testName,
        totalCount: ep.totalCount,
        failedCount: ep.failedCount,
        errorRate: ep.totalCount > 0 ? Number((ep.failedCount / ep.totalCount).toFixed(4)) : 0,
        avgMs: ep.samples > 0 ? Number((ep.avgSum / ep.samples).toFixed(2)) : 0,
        p95Ms: Number(ep.p95Max.toFixed(2)),
        maxMs: Number(ep.maxMs.toFixed(2))
      }))
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 10);

    return {
      range,
      kpis: {
        totalScenarios: testRows.length,
        totalRuns: runRows.length,
        passedRuns,
        failedRuns,
        passRatePct,
        avgP95Ms: avgNullable(completedRuns.map((r) => r.p95_ms)),
        avgRps: avgNullable(completedRuns.map((r) => r.rps)),
        avgErrorRate: avgNullable(completedRuns.map((r) => r.error_rate))
      },
      trend,
      scenarios,
      slowestEndpoints
    };
  }

  /**
   * Exports the project Performance Report as CSV or Excel (.xlsx).
   */
  async exportProjectReport(
    userId: string | null | undefined,
    projectId: string,
    format: string,
    range: PerformanceReportRange = "30d"
  ): Promise<{ content: Buffer; contentType: string; fileName: string }> {
    if (format !== "csv" && format !== "xlsx") {
      throw new BadRequestException({ error: `Unsupported export format "${format}". Use csv or xlsx.` });
    }

    const report = await this.getProjectReport(userId, projectId, range);

    if (format === "csv") {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        ["Scenario", "Mode", "Total Runs", "Passed", "Failed", "Pass Rate (%)", "Avg p95 (ms)", "Avg RPS", "Avg Error Rate (%)", "Latest Status", "Latest Run At"].join(",")
      ];
      for (const s of report.scenarios) {
        lines.push(
          [
            esc(s.name),
            esc(s.mode),
            s.totalRuns,
            s.passedRuns,
            s.failedRuns,
            s.passRatePct ?? "",
            s.avgP95Ms ?? "",
            s.avgRps ?? "",
            s.avgErrorRate !== null ? (s.avgErrorRate * 100).toFixed(2) : "",
            esc(s.latestStatus ?? ""),
            esc(s.latestRunAt ?? "")
          ].join(",")
        );
      }
      return {
        content: Buffer.from(lines.join("\n"), "utf8"),
        contentType: "text/csv; charset=utf-8",
        fileName: `performance-report-${range}.csv`
      };
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Scenarios");
    ws.addRow([
      "Scenario",
      "Mode",
      "Total Runs",
      "Passed",
      "Failed",
      "Pass Rate (%)",
      "Avg p95 (ms)",
      "Avg RPS",
      "Avg Error Rate (%)",
      "Latest Status",
      "Latest Run At"
    ]);
    for (const s of report.scenarios) {
      ws.addRow([
        s.name,
        s.mode,
        s.totalRuns,
        s.passedRuns,
        s.failedRuns,
        s.passRatePct ?? "",
        s.avgP95Ms ?? "",
        s.avgRps ?? "",
        s.avgErrorRate !== null ? Number((s.avgErrorRate * 100).toFixed(2)) : "",
        s.latestStatus ?? "",
        s.latestRunAt ?? ""
      ]);
    }

    if (report.slowestEndpoints.length > 0) {
      const epSheet = wb.addWorksheet("Slowest Endpoints");
      epSheet.addRow(["Method", "URL", "Scenario", "Requests", "Failed", "Error Rate (%)", "Avg (ms)", "p95 (ms)", "Max (ms)"]);
      for (const ep of report.slowestEndpoints) {
        epSheet.addRow([
          ep.method,
          ep.url,
          ep.testName,
          ep.totalCount,
          ep.failedCount,
          Number((ep.errorRate * 100).toFixed(2)),
          ep.avgMs,
          ep.p95Ms,
          ep.maxMs
        ]);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    return {
      content: Buffer.from(buf),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: `performance-report-${range}.xlsx`
    };
  }
}
