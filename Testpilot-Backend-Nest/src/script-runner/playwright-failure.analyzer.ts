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
  source?: "json_reporter" | "regex_fallback";
  retries?: number;
  flaky?: boolean;
  failedStepTitle?: string | null;
}

interface PlaywrightJsonError {
  message?: string;
  stack?: string;
  snippet?: string;
  location?: { file?: string; line?: number; column?: number };
}

interface PlaywrightJsonResult {
  status?: string;
  retry?: number;
  duration?: number;
  error?: PlaywrightJsonError;
  errors?: PlaywrightJsonError[];
  steps?: Array<{ title?: string; error?: PlaywrightJsonError; duration?: number }>;
}

function collectTestsFromSuites(suites: unknown[]): Array<{ title?: string; ok?: boolean; results?: PlaywrightJsonResult[] }> {
  const out: Array<{ title?: string; ok?: boolean; results?: PlaywrightJsonResult[] }> = [];
  for (const s of suites) {
    if (!s || typeof s !== "object") continue;
    const suite = s as Record<string, any>;
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (spec && typeof spec === "object" && Array.isArray(spec.tests)) {
          for (const t of spec.tests) {
            if (t && typeof t === "object") out.push(t);
          }
        }
      }
    }
    if (Array.isArray(suite.suites)) {
      out.push(...collectTestsFromSuites(suite.suites));
    }
  }
  return out;
}

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Analyzes Playwright's structured JSON reporter output first, falling back to
 * regex-based log analysis when JSON report data is absent or malformed.
 */
export function analyzePlaywrightJsonReport(
  reportJson: unknown,
  stdout: string | null,
  stderr: string | null,
  errorMessage: string | null
): ScriptFailureAnalysis {
  if (reportJson && typeof reportJson === "object") {
    const report = reportJson as Record<string, any>;
    const suites = Array.isArray(report.suites) ? report.suites : [];
    const tests = collectTestsFromSuites(suites);

    const failedTest = tests.find((t) =>
      Array.isArray(t.results) && t.results.some((r) => r.status === "failed" || r.status === "timedOut" || r.status === "interrupted")
    );
    const allResults = failedTest?.results ?? tests.flatMap((t) => t.results ?? []);
    const lastFailedResult = [...allResults]
      .reverse()
      .find((r) => r.status === "failed" || r.status === "timedOut" || r.status === "interrupted");

    const topLevelErrors: PlaywrightJsonError[] = Array.isArray(report.errors) ? report.errors : [];
    const resultErrors: PlaywrightJsonError[] = lastFailedResult
      ? [
          ...(Array.isArray(lastFailedResult.errors) ? lastFailedResult.errors : []),
          ...(lastFailedResult.error ? [lastFailedResult.error] : [])
        ]
      : [];
    const primaryError = resultErrors[0] ?? topLevelErrors[0];

    if (primaryError) {
      const rawMsg = stripAnsi([primaryError.message, primaryError.stack, primaryError.snippet].filter(Boolean).join("\n"));
      const base = analyzePlaywrightFailure(stdout, rawMsg, errorMessage);
      const loc = primaryError.location;
      const failedLine =
        loc && typeof loc.line === "number"
          ? `line ${loc.line}${typeof loc.column === "number" ? `:${loc.column}` : ""}`
          : base.failedLine;

      const failedStep = Array.isArray(lastFailedResult?.steps)
        ? lastFailedResult.steps.find((st) => Boolean(st.error))
        : undefined;

      const maxRetry = allResults.reduce((m, r) => Math.max(m, Number(r.retry ?? 0)), 0);
      const isFlaky = Boolean(failedTest?.ok) && maxRetry > 0;

      return {
        ...base,
        failedLine,
        source: "json_reporter",
        retries: maxRetry,
        flaky: isFlaky,
        failedStepTitle: failedStep?.title ?? null
      };
    }
  }

  return {
    ...analyzePlaywrightFailure(stdout, stderr, errorMessage),
    source: "regex_fallback"
  };
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
