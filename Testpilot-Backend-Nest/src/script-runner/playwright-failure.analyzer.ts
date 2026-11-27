export type FailureCategory =
  | "selector_not_found"
  | "assertion_failed"
  | "timeout"
  | "network_error"
  | "script_error"
  | "unknown";

export interface ScriptFailureAnalysis {
  category: FailureCategory;
  title: string;
  summary: string;
  failedLine: string | null;
  selector: string | null;
  expected: string | null;
  received: string | null;
  suggestion: string;
}

/**
 * Classifies a failed/errored Playwright run from its stdout/stderr/errorMessage
 * into a structured root-cause summary with actionable next steps.
 */
export function analyzePlaywrightFailure(
  stdout: string | null,
  stderr: string | null,
  errorMessage: string | null
): ScriptFailureAnalysis {
  const combined = [stderr, stdout, errorMessage].filter(Boolean).join("\n");

  const lineMatch = /test\.spec\.ts:(\d+:\d+)/.exec(combined);
  const failedLine = lineMatch ? `line ${lineMatch[1]}` : null;

  const locatorMatch =
    /(?:waiting for locator\(['"`](.+?)['"`]\)|locator\(['"`](.+?)['"`]\))/i.exec(combined);
  const selector = locatorMatch ? (locatorMatch[1] ?? locatorMatch[2] ?? null) : null;

  const expectedMatch = /Expected(?:\s+value)?:\s*(.+)/i.exec(combined);
  const receivedMatch = /Received(?:\s+value)?:\s*(.+)/i.exec(combined);
  const expected = expectedMatch ? expectedMatch[1].trim().slice(0, 200) : null;
  const received = receivedMatch ? receivedMatch[1].trim().slice(0, 200) : null;

  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(combined)) {
    return {
      category: "network_error",
      title: "Target Application Unreachable",
      summary: "The browser could not connect to or resolve the target URL.",
      failedLine,
      selector,
      expected,
      received,
      suggestion: "Verify targetUrl is reachable from the runner container and the target service is running."
    };
  }

  if (/waiting for locator|strict mode violation|resolved to \d+ elements|Timeout .* exceeded.*locator/is.test(combined)) {
    return {
      category: "selector_not_found",
      title: "Element / Locator Not Found",
      summary: selector
        ? `Playwright could not uniquely interact with locator "${selector}".`
        : "Playwright could not find or uniquely match the target element on the page.",
      failedLine,
      selector,
      expected,
      received,
      suggestion: "Check if the UI selector changed, add a more specific data-testid, or wait for navigation/loading to finish."
    };
  }

  if (/expect\(|toBe|toEqual|toContain|toHaveText|toBeVisible|AssertionError/i.test(combined)) {
    return {
      category: "assertion_failed",
      title: "Assertion Failed",
      summary:
        expected && received
          ? `Expected ${expected}, but received ${received}.`
          : "A Playwright expect() assertion did not match the actual page state.",
      failedLine,
      selector,
      expected,
      received,
      suggestion: "Inspect the screenshot/trace evidence to see whether the app returned an unexpected state or the expected value needs updating."
    };
  }

  if (/Test timeout of \d+ms exceeded|TimeoutError|Timed out/i.test(combined)) {
    return {
      category: "timeout",
      title: "Execution Timed Out",
      summary: "The test exceeded the maximum allowed execution timeout.",
      failedLine,
      selector,
      expected,
      received,
      suggestion: "Check for slow API responses, infinite loading spinners, or missing await statements."
    };
  }

  if (/SyntaxError|ReferenceError|TypeError|Cannot find module|TS\d{4}/i.test(combined)) {
    return {
      category: "script_error",
      title: "Script / Syntax Error",
      summary: "The Playwright script failed to compile or threw a runtime JavaScript/TypeScript error.",
      failedLine,
      selector,
      expected,
      received,
      suggestion: "Fix the syntax, import, or variable reference error in the script editor."
    };
  }

  const firstMeaningfulLine =
    combined
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("at ")) ?? "Playwright execution failed.";

  return {
    category: "unknown",
    title: "Test Execution Failed",
    summary: firstMeaningfulLine.slice(0, 300),
    failedLine,
    selector,
    expected,
    received,
    suggestion: "Review the console logs and attached trace/screenshot evidence for details."
  };
}
