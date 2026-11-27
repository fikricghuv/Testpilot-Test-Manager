import { analyzePlaywrightFailure } from "./playwright-failure.analyzer";

describe("analyzePlaywrightFailure", () => {
  it("classifies selector timeouts and extracts locator + line", () => {
    const res = analyzePlaywrightFailure(
      null,
      'Error: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-testid="submit-btn"]\')\n    at test.spec.ts:14:21',
      null
    );
    expect(res.category).toBe("selector_not_found");
    expect(res.selector).toBe('[data-testid="submit-btn"]');
    expect(res.failedLine).toBe("line 14:21");
  });

  it("classifies assertion failures with expected and received values", () => {
    const res = analyzePlaywrightFailure(
      null,
      'Error: expect(received).toBe(expected)\nExpected: "Dashboard"\nReceived: "Login"\n    at test.spec.ts:22:10',
      null
    );
    expect(res.category).toBe("assertion_failed");
    expect(res.expected).toBe('"Dashboard"');
    expect(res.received).toBe('"Login"');
    expect(res.failedLine).toBe("line 22:10");
  });

  it("classifies network errors", () => {
    const res = analyzePlaywrightFailure(
      null,
      "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9999/",
      null
    );
    expect(res.category).toBe("network_error");
  });
});
