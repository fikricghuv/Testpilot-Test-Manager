export const PERFORMANCE_RUNNER_QUEUE = "performance-runner";
export const PERFORMANCE_RUNNER_JOB = "run-k6-test";

export const PERFORMANCE_TEST_MODES = ["builder", "flow", "script"] as const;
export const PERFORMANCE_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const PERFORMANCE_RUN_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "error",
  "cancelled"
] as const;

export const MAX_VUS = 100;
export const MAX_DURATION_SEC = 300;
export const MAX_TARGET_RPS = 500;
export const MAX_SCRIPT_LENGTH = 100_000;
export const MAX_OUTPUT_LENGTH = 50_000;
export const K6_TIMEOUT_BUFFER_MS = 30_000;
