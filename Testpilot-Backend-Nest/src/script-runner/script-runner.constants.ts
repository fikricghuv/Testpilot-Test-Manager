export const SCRIPT_RUNNER_QUEUE = "script-runner";
export const SCRIPT_RUNNER_JOB = "run-playwright-script";

export const SCRIPT_FRAMEWORKS = ["playwright-ts"] as const;
export const SCRIPT_STATUSES = ["draft", "verified", "archived"] as const;
export const SCRIPT_SOURCES = ["manual", "zyra", "healer", "recorder"] as const;
export const SCRIPT_BROWSERS = ["chromium", "firefox", "webkit", "all"] as const;
export const SCRIPT_RUN_STATUSES = ["queued", "running", "passed", "failed", "error", "cancelled"] as const;

export const MAX_SCRIPT_CONTENT_LENGTH = 200_000;
export const MAX_SCRIPT_OUTPUT_LENGTH = 50_000;
export const SCRIPT_EXECUTION_TIMEOUT_MS = 120_000;
