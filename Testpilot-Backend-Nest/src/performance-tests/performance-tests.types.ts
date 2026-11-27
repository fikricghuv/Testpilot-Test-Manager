import type {
  PERFORMANCE_HTTP_METHODS,
  PERFORMANCE_RUN_STATUSES,
  PERFORMANCE_TEST_MODES
} from "./performance-tests.constants";

export type PerformanceTestMode = (typeof PERFORMANCE_TEST_MODES)[number];
export type PerformanceHttpMethod = (typeof PERFORMANCE_HTTP_METHODS)[number];
export type PerformanceRunStatus = (typeof PERFORMANCE_RUN_STATUSES)[number];

export type PerformanceLoadProfile = "fixed" | "ramping" | "constant-arrival-rate";

export interface PerformanceStage {
  durationSec: number;
  targetVus: number;
}

export interface PerformanceBuilderConfig {
  targetUrl: string;
  method: PerformanceHttpMethod;
  headers?: Record<string, string>;
  body?: string | null;
  loadProfile?: PerformanceLoadProfile;
  vus: number;
  durationSec: number;
  targetRps?: number | null;
  stages?: PerformanceStage[];
  sleepSec?: number;
  p95ThresholdMs?: number | null;
  errorRateThresholdPct?: number | null;
  expectedStatus?: number | null;
}

export interface K6ThresholdResult {
  metric: string;
  expression: string;
  ok: boolean;
}

export interface K6SummaryData {
  totalRequests: number | null;
  rps: number | null;
  errorRate: number | null;
  avgMs: number | null;
  minMs: number | null;
  medMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  checksPassed: number | null;
  checksFailed: number | null;
  thresholdsPassed: boolean | null;
  thresholds: K6ThresholdResult[];
}

export interface PerformanceFlowStep {
  id: string;
  name: string;
  method: PerformanceHttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
  expectedStatus?: number | null;
  sleepAfterSec?: number;
  enabled?: boolean;
}

export interface PerformanceFlowConfig {
  loadProfile?: PerformanceLoadProfile;
  vus: number;
  durationSec: number;
  targetRps?: number | null;
  stages?: PerformanceStage[];
  p95ThresholdMs?: number | null;
  errorRateThresholdPct?: number | null;
  steps: PerformanceFlowStep[];
}

export interface RecordedApiCall {
  id: string;
  method: PerformanceHttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  status: number | null;
  resourceType: string;
  timestamp: string;
}

export interface RecorderSelectOption {
  value: string;
  text: string;
  selected: boolean;
}

export interface RecorderActiveSelect {
  x: number;
  y: number;
  options: RecorderSelectOption[];
}

export interface RecorderSessionState {
  sessionId: string;
  projectId: string;
  startUrl: string;
  currentUrl: string | null;
  interactive: boolean;
  status: "recording" | "stopped" | "error";
  capturedCalls: RecordedApiCall[];
  activeSelect?: RecorderActiveSelect | null;
  errorMessage: string | null;
  startedAt: string;
}

export interface PerformanceTestRecord {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  mode: PerformanceTestMode;
  builderConfig: PerformanceBuilderConfig | null;
  flowConfig: PerformanceFlowConfig | null;
  scriptContent: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: PerformanceRunSummary | null;
}

export interface PerformanceRunSummary {
  id: string;
  status: PerformanceRunStatus;
  vus: number | null;
  durationSec: number | null;
  totalRequests: number | null;
  rps: number | null;
  errorRate: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  thresholdsPassed: boolean | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface PerformanceTimeseriesPoint {
  t: number; // seconds since start
  rps: number;
  failedRps?: number;
  avgMs: number;
  medMs?: number;
  p90Ms?: number;
  p95Ms: number;
  p99Ms?: number;
  errorRate: number;
  vus: number;
  waitingMs?: number;
  connectingMs?: number;
  tlsMs?: number;
}

export interface PerformanceEndpointBreakdown {
  method: string;
  url: string;
  count: number;
  failed: number;
  errorRate: number;
  avgMs: number;
  medMs: number;
  p90Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface PerformanceCheckBreakdown {
  group: string;
  name: string;
  passes: number;
  fails: number;
}

export interface PerformanceRunBreakdown {
  endpoints: PerformanceEndpointBreakdown[];
  statusCodes: Record<string, number>;
  checks: PerformanceCheckBreakdown[];
}

export interface PerformanceRunRecord extends PerformanceRunSummary {
  projectId: string;
  testId: string;
  minMs: number | null;
  medMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
  checksPassed: number | null;
  checksFailed: number | null;
  summaryJson: Record<string, unknown> | null;
  timeseriesJson: PerformanceTimeseriesPoint[] | null;
  breakdownJson: PerformanceRunBreakdown | null;
  stdout: string | null;
  stderr: string | null;
  errorMessage: string | null;
  triggeredBy: string | null;
  startedAt: string | null;
}

export interface CreatePerformanceTestInput {
  name: string;
  description?: string | null;
  mode?: PerformanceTestMode;
  builderConfig?: PerformanceBuilderConfig | null;
  flowConfig?: PerformanceFlowConfig | null;
  scriptContent?: string | null;
}

export interface UpdatePerformanceTestInput {
  name?: string;
  description?: string | null;
  mode?: PerformanceTestMode;
  builderConfig?: PerformanceBuilderConfig | null;
  flowConfig?: PerformanceFlowConfig | null;
  scriptContent?: string | null;
}

export interface PerformanceRunnerJobPayload {
  runId: string;
}

export type PerformanceReportRange = "7d" | "30d" | "all";

export interface PerformanceProjectReport {
  range: PerformanceReportRange;
  kpis: {
    totalScenarios: number;
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    passRatePct: number | null;
    avgP95Ms: number | null;
    avgRps: number | null;
    avgErrorRate: number | null;
  };
  trend: Array<{
    runId: string;
    testId: string;
    testName: string;
    status: PerformanceRunStatus;
    p95Ms: number | null;
    rps: number | null;
    errorRate: number | null;
    createdAt: string;
  }>;
  scenarios: Array<{
    id: string;
    name: string;
    mode: PerformanceTestMode;
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    passRatePct: number | null;
    avgP95Ms: number | null;
    avgRps: number | null;
    avgErrorRate: number | null;
    latestStatus: PerformanceRunStatus | null;
    latestRunAt: string | null;
  }>;
  slowestEndpoints: Array<{
    method: string;
    url: string;
    testId: string;
    testName: string;
    totalCount: number;
    failedCount: number;
    errorRate: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
  }>;
}
