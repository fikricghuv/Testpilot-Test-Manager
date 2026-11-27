export type FailureTriageClassification =
  | "application_bug"
  | "selector_drift"
  | "flaky_test"
  | "environment_issue"
  | "script_bug";

export interface ZyraFailureTriageResult {
  classification: FailureTriageClassification;
  confidence: "high" | "medium" | "low";
  rootCause: string;
  suggestedFix: string;
  bugDraft: {
    title: string;
    description: string;
    stepsToReproduce: string;
    expectedResult: string;
    actualResult: string;
    severity: "critical" | "high" | "medium" | "low";
    priority: "critical" | "high" | "medium" | "low";
  };
  provider: string;
  model: string;
}

export interface ZyraPerformanceInsightsResult {
  healthVerdict: "healthy" | "degraded" | "bottleneck_detected" | "threshold_failed";
  summary: string;
  bottlenecks: string[];
  recommendations: string[];
  recommendedConfig: {
    loadProfile: string;
    vus: number;
    durationSec: number;
    p95ThresholdMs: number;
    maxErrorRate: number;
  };
  provider: string;
  model: string;
}

export type TestDataCategory = "valid" | "boundary" | "invalid" | "security_edge";

export interface ZyraTestDataRow {
  category: TestDataCategory;
  name: string;
  input: Record<string, unknown>;
  expectedBehavior: string;
}

export interface ZyraTestDataResult {
  summary: string;
  datasets: ZyraTestDataRow[];
  playwrightFixtureSnippet: string;
  provider: string;
  model: string;
}
