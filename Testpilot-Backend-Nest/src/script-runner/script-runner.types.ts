import type {
  SCRIPT_BROWSERS,
  SCRIPT_FRAMEWORKS,
  SCRIPT_RUN_STATUSES,
  SCRIPT_SOURCES,
  SCRIPT_STATUSES
} from "./script-runner.constants";

export type ScriptFramework = (typeof SCRIPT_FRAMEWORKS)[number];
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];
export type ScriptSource = (typeof SCRIPT_SOURCES)[number];
export type ScriptBrowser = (typeof SCRIPT_BROWSERS)[number];
export type ScriptRunStatus = (typeof SCRIPT_RUN_STATUSES)[number];

export interface TestScriptRecord {
  id: string;
  projectId: string;
  testcaseId: string;
  framework: ScriptFramework;
  targetUrl: string | null;
  status: ScriptStatus;
  activeVersionId: string | null;
  activeVersion: number | null;
  scriptContent: string | null;
  source: ScriptSource | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestScriptVersionRecord {
  id: string;
  scriptId: string;
  version: number;
  scriptContent: string;
  source: ScriptSource;
  notes: string | null;
  verifiedLocators: Record<string, string>;
  createdBy: string | null;
  createdAt: string;
}

export interface TestScriptRunRecord {
  id: string;
  projectId: string;
  testcaseId: string;
  scriptId: string;
  versionId: string | null;
  cycleId: string | null;
  executionId: string | null;
  status: ScriptRunStatus;
  targetUrl: string | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  errorMessage: string | null;
  triggeredBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface TestScriptStateResponse {
  script: TestScriptRecord | null;
  versions: TestScriptVersionRecord[];
  recentRuns: TestScriptRunRecord[];
}

export interface UpsertTestScriptInput {
  scriptContent: string;
  framework?: ScriptFramework;
  targetUrl?: string | null;
  status?: ScriptStatus;
  source?: ScriptSource;
  notes?: string | null;
  verifiedLocators?: Record<string, string>;
}

export interface RecorderSessionResponse {
  token: string;
  expiresAt: string | null;
  projectId: string;
  testcaseId: string;
  testcaseTitle: string;
  testcaseExternalId: string | null;
}

export interface TriggerScriptRunInput {
  targetUrl?: string | null;
  browser?: ScriptBrowser;
}

export interface RecordHeadedRunInput {
  status: "passed" | "failed" | "error";
  targetUrl?: string | null;
  durationMs?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
  screenshotDataUrl?: string | null;
}

export interface TriggerSuiteRunInput {
  onlyVerified?: boolean;
  targetUrl?: string | null;
  browser?: ScriptBrowser;
}

export interface SuiteRunResponse {
  cycleId: string;
  suiteId: string;
  suiteName: string;
  queuedCount: number;
  runs: TestScriptRunRecord[];
}

export interface ScriptRunnerJobPayload {
  runId: string;
  browser?: ScriptBrowser;
}
