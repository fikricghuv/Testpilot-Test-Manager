import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AutomationAgentsService } from "../automation-agents/automation-agents.service";
import { DatabaseService } from "../database/database.service";
import { isUuid, LegacyService } from "../legacy/legacy.service";
import type {
  FailureTriageClassification,
  TestDataCategory,
  ZyraFailureTriageResult,
  ZyraPerformanceInsightsResult,
  ZyraTestDataResult,
  ZyraTestDataRow
} from "./zyra-insights.types";

function parseJsonObject<T>(rawText: string): T {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new BadRequestException("Zyra returned an invalid JSON response.");
  }
}

@Injectable()
export class ZyraInsightsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly legacy: LegacyService,
    private readonly automationAgents: AutomationAgentsService
  ) {}

  private assertUuid(id: string, label: string): void {
    if (!isUuid(id)) {
      throw new NotFoundException(`${label} not found.`);
    }
  }

  /**
   * Capability #1: AI Failure Triage & Auto Bug Draft from a failed Playwright script run or execution.
   */
  async triageFailure(
    userId: string | null | undefined,
    projectId: string,
    input: { runId?: string; executionId?: string; testcaseId?: string }
  ): Promise<ZyraFailureTriageResult> {
    this.assertUuid(projectId, "Project");
    await this.legacy.requireProjectAccess(userId, projectId);

    let contextTitle = "Automation Failure";
    let testCaseContext = "";
    let errorContext = "";

    if (input.runId) {
      this.assertUuid(input.runId, "Script run");
      const res = await this.db.query<{
        id: string;
        status: string;
        error_message: string | null;
        stdout: string | null;
        stderr: string | null;
        failure_analysis: unknown;
        target_url: string | null;
        browser: string | null;
        tc_title: string | null;
        tc_external_id: string | null;
        tc_steps: unknown;
        tc_expected: string | null;
      }>(
        `SELECT r.id, r.status, r.error_message, r.stdout, r.stderr, r.failure_analysis, r.target_url, r.browser,
                tc.title AS tc_title, tc.external_id AS tc_external_id, tc.steps AS tc_steps, tc.expected_result AS tc_expected
         FROM test_script_runs r
         LEFT JOIN testcases tc ON tc.id = r.testcase_id
         WHERE r.id = $1 AND r.project_id = $2
         LIMIT 1`,
        [input.runId, projectId]
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundException("Script run not found.");
      contextTitle = `${row.tc_external_id ? `[${row.tc_external_id}] ` : ""}${row.tc_title || "Playwright Run"}`;
      testCaseContext = [
        `Target URL: ${row.target_url || "N/A"}`,
        `Browser: ${row.browser || "chromium"}`,
        `Steps: ${typeof row.tc_steps === "string" ? row.tc_steps : JSON.stringify(row.tc_steps ?? [])}`,
        `Expected Result: ${row.tc_expected || "N/A"}`
      ].join("\n");
      errorContext = [
        `Run Status: ${row.status}`,
        `Error Message: ${row.error_message || "N/A"}`,
        `Rule-Based Analysis: ${row.failure_analysis ? JSON.stringify(row.failure_analysis) : "N/A"}`,
        `Stderr (tail): ${(row.stderr || "").slice(-2500)}`,
        `Stdout (tail): ${(row.stdout || "").slice(-1500)}`
      ].join("\n");
    } else if (input.executionId) {
      this.assertUuid(input.executionId, "Execution");
      const res = await this.db.query<{
        status: string;
        error_message: string | null;
        actual_result: string | null;
        tc_title: string | null;
        tc_external_id: string | null;
        tc_steps: unknown;
        tc_expected: string | null;
      }>(
        `SELECT e.status, e.error_message, e.actual_result,
                tc.title AS tc_title, tc.external_id AS tc_external_id, tc.steps AS tc_steps, tc.expected_result AS tc_expected
         FROM executions e
         LEFT JOIN testcases tc ON tc.id = e.testcase_id
         WHERE e.id = $1 AND e.project_id = $2
         LIMIT 1`,
        [input.executionId, projectId]
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundException("Execution not found.");
      contextTitle = `${row.tc_external_id ? `[${row.tc_external_id}] ` : ""}${row.tc_title || "Test Execution"}`;
      testCaseContext = [
        `Steps: ${typeof row.tc_steps === "string" ? row.tc_steps : JSON.stringify(row.tc_steps ?? [])}`,
        `Expected Result: ${row.tc_expected || "N/A"}`
      ].join("\n");
      errorContext = [
        `Execution Status: ${row.status}`,
        `Actual Result: ${row.actual_result || "N/A"}`,
        `Error Message: ${row.error_message || "N/A"}`
      ].join("\n");
    } else {
      throw new BadRequestException("Provide either runId or executionId to triage.");
    }

    const systemPrompt = [
      "You are Zyra, an expert QA Failure Triage Copilot.",
      "Analyze the failed test execution and return ONLY valid JSON matching this schema:",
      "{",
      '  "classification": "application_bug" | "selector_drift" | "flaky_test" | "environment_issue" | "script_bug",',
      '  "confidence": "high" | "medium" | "low",',
      '  "rootCause": string,',
      '  "suggestedFix": string,',
      '  "bugDraft": {',
      '    "title": string,',
      '    "description": string,',
      '    "stepsToReproduce": string,',
      '    "expectedResult": string,',
      '    "actualResult": string,',
      '    "severity": "critical" | "high" | "medium" | "low",',
      '    "priority": "critical" | "high" | "medium" | "low"',
      "  }",
      "}"
    ].join("\n");

    const userPrompt = `Test Case: ${contextTitle}\n\n${testCaseContext}\n\nFailure Telemetry:\n${errorContext}`;
    const ai = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, userPrompt, 2000);
    const parsed = parseJsonObject<Partial<ZyraFailureTriageResult>>(ai.text);

    const validClasses: FailureTriageClassification[] = [
      "application_bug",
      "selector_drift",
      "flaky_test",
      "environment_issue",
      "script_bug"
    ];
    const classification = validClasses.includes(parsed.classification as FailureTriageClassification)
      ? (parsed.classification as FailureTriageClassification)
      : "application_bug";

    return {
      classification,
      confidence: parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium",
      rootCause: String(parsed.rootCause || "Unable to determine root cause."),
      suggestedFix: String(parsed.suggestedFix || "Review failure logs and re-verify the failing step."),
      bugDraft: {
        title: String(parsed.bugDraft?.title || `Failure in ${contextTitle}`).slice(0, 200),
        description: String(parsed.bugDraft?.description || parsed.rootCause || ""),
        stepsToReproduce: String(parsed.bugDraft?.stepsToReproduce || testCaseContext),
        expectedResult: String(parsed.bugDraft?.expectedResult || "Test passes without error."),
        actualResult: String(parsed.bugDraft?.actualResult || errorContext.slice(0, 500)),
        severity: (["critical", "high", "medium", "low"].includes(String(parsed.bugDraft?.severity))
          ? parsed.bugDraft?.severity
          : "medium") as "critical" | "high" | "medium" | "low",
        priority: (["critical", "high", "medium", "low"].includes(String(parsed.bugDraft?.priority))
          ? parsed.bugDraft?.priority
          : "medium") as "critical" | "high" | "medium" | "low"
      },
      provider: ai.provider,
      model: ai.model
    };
  }

  /**
   * Capability #4: Performance & k6 Insights Advisor.
   */
  async analyzePerformanceRun(
    userId: string | null | undefined,
    projectId: string,
    input: { performanceTestId: string; runId?: string }
  ): Promise<ZyraPerformanceInsightsResult> {
    this.assertUuid(projectId, "Project");
    this.assertUuid(input.performanceTestId, "Performance test");
    await this.legacy.requireProjectAccess(userId, projectId);

    const testRes = await this.db.query<{
      id: string;
      name: string;
      target_url: string;
      load_profile: string | null;
      vus: number;
      duration_sec: number;
      target_rps: number | null;
      stages_json: unknown;
      thresholds_json: unknown;
    }>(
      `SELECT id, name, target_url, load_profile, vus, duration_sec, target_rps, stages_json, thresholds_json
       FROM performance_tests
       WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [input.performanceTestId, projectId]
    );
    const test = testRes.rows[0];
    if (!test) throw new NotFoundException("Performance test not found.");

    const runRes = input.runId
      ? await this.db.query(
          `SELECT * FROM performance_test_runs WHERE id = $1 AND performance_test_id = $2 AND project_id = $3 LIMIT 1`,
          [input.runId, input.performanceTestId, projectId]
        )
      : await this.db.query(
          `SELECT * FROM performance_test_runs WHERE performance_test_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [input.performanceTestId, projectId]
        );
    const run = runRes.rows[0];
    if (!run) throw new NotFoundException("No performance test run found to analyze.");

    const systemPrompt = [
      "You are Zyra, a senior Performance & Grafana k6 Engineer.",
      "Analyze the k6 test configuration and run metrics, then return ONLY valid JSON:",
      "{",
      '  "healthVerdict": "healthy" | "degraded" | "bottleneck_detected" | "threshold_failed",',
      '  "summary": string,',
      '  "bottlenecks": string[],',
      '  "recommendations": string[],',
      '  "recommendedConfig": {',
      '    "loadProfile": string,',
      '    "vus": number,',
      '    "durationSec": number,',
      '    "p95ThresholdMs": number,',
      '    "maxErrorRate": number',
      "  }",
      "}"
    ].join("\n");

    const userPrompt = JSON.stringify(
      {
        test: {
          name: test.name,
          targetUrl: test.target_url,
          loadProfile: test.load_profile,
          vus: test.vus,
          durationSec: test.duration_sec,
          targetRps: test.target_rps,
          stages: test.stages_json,
          thresholds: test.thresholds_json
        },
        run: {
          status: run.status,
          totalRequests: run.total_requests,
          rps: run.rps,
          errorRate: run.error_rate,
          avgMs: run.avg_ms,
          p90Ms: run.p90_ms,
          p95Ms: run.p95_ms,
          maxMs: run.max_ms,
          checksPassed: run.checks_passed,
          checksFailed: run.checks_failed,
          thresholdsPassed: run.thresholds_passed,
          errorMessage: run.error_message,
          breakdown: run.breakdown_json
        }
      },
      null,
      2
    );

    const ai = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, userPrompt, 2000);
    const parsed = parseJsonObject<Partial<ZyraPerformanceInsightsResult>>(ai.text);

    const validVerdicts = ["healthy", "degraded", "bottleneck_detected", "threshold_failed"] as const;
    const healthVerdict = validVerdicts.includes(parsed.healthVerdict as (typeof validVerdicts)[number])
      ? (parsed.healthVerdict as ZyraPerformanceInsightsResult["healthVerdict"])
      : run.thresholds_passed === false
        ? "threshold_failed"
        : "healthy";

    return {
      healthVerdict,
      summary: String(parsed.summary || "Performance analysis completed."),
      bottlenecks: Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks.map(String) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
      recommendedConfig: {
        loadProfile: String(parsed.recommendedConfig?.loadProfile || test.load_profile || "load"),
        vus: Number(parsed.recommendedConfig?.vus || test.vus || 10),
        durationSec: Number(parsed.recommendedConfig?.durationSec || test.duration_sec || 30),
        p95ThresholdMs: Number(parsed.recommendedConfig?.p95ThresholdMs || 500),
        maxErrorRate: Number(parsed.recommendedConfig?.maxErrorRate ?? 0.01)
      },
      provider: ai.provider,
      model: ai.model
    };
  }

  /**
   * Capability #5: Structured Test Data & Boundary Value Generator.
   */
  async generateTestData(
    userId: string | null | undefined,
    projectId: string,
    input: { testcaseId?: string; prompt?: string }
  ): Promise<ZyraTestDataResult> {
    this.assertUuid(projectId, "Project");
    await this.legacy.requireProjectAccess(userId, projectId);

    let scenarioContext = (input.prompt || "").trim();
    if (input.testcaseId) {
      this.assertUuid(input.testcaseId, "Test case");
      const res = await this.db.query<{
        external_id: string | null;
        title: string;
        description: string | null;
        preconditions: string | null;
        steps: unknown;
        expected_result: string | null;
      }>(
        `SELECT external_id, title, description, preconditions, steps, expected_result
         FROM testcases
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [input.testcaseId, projectId]
      );
      const tc = res.rows[0];
      if (!tc) throw new NotFoundException("Test case not found.");
      scenarioContext = [
        `Test Case: ${tc.external_id ? `[${tc.external_id}] ` : ""}${tc.title}`,
        tc.description ? `Description: ${tc.description}` : "",
        tc.preconditions ? `Preconditions: ${tc.preconditions}` : "",
        `Steps: ${typeof tc.steps === "string" ? tc.steps : JSON.stringify(tc.steps ?? [])}`,
        tc.expected_result ? `Expected Result: ${tc.expected_result}` : "",
        input.prompt ? `Additional Instructions: ${input.prompt}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (!scenarioContext) {
      throw new BadRequestException("Provide either testcaseId or prompt to generate test data.");
    }

    const systemPrompt = [
      "You are Zyra, a senior QA Test Data Engineer.",
      "Generate diverse, realistic structured test datasets covering valid, boundary, invalid, and security_edge cases.",
      "Return ONLY valid JSON matching this schema:",
      "{",
      '  "summary": string,',
      '  "datasets": [',
      '    { "category": "valid" | "boundary" | "invalid" | "security_edge", "name": string, "input": object, "expectedBehavior": string }',
      "  ],",
      '  "playwrightFixtureSnippet": string',
      "}"
    ].join("\n");

    const ai = await this.legacy.runProjectAiPrompt(projectId, systemPrompt, scenarioContext, 2500);
    const parsed = parseJsonObject<Partial<ZyraTestDataResult>>(ai.text);
    const validCategories: TestDataCategory[] = ["valid", "boundary", "invalid", "security_edge"];

    const datasets: ZyraTestDataRow[] = Array.isArray(parsed.datasets)
      ? parsed.datasets.map((row, idx) => ({
          category: validCategories.includes(row?.category as TestDataCategory)
            ? (row.category as TestDataCategory)
            : "valid",
          name: String(row?.name || `Dataset ${idx + 1}`),
          input: row?.input && typeof row.input === "object" && !Array.isArray(row.input) ? row.input : {},
          expectedBehavior: String(row?.expectedBehavior || "")
        }))
      : [];

    return {
      summary: String(parsed.summary || `Generated ${datasets.length} test dataset(s).`),
      datasets,
      playwrightFixtureSnippet: String(
        parsed.playwrightFixtureSnippet || `const testDatasets = ${JSON.stringify(datasets, null, 2)};`
      ),
      provider: ai.provider,
      model: ai.model
    };
  }

  /**
   * Capability #7: Bridge Zyra -> Automation (queue Playwright script generation from Zyra).
   */
  async generateAutomationForTestCase(
    userId: string | null | undefined,
    projectId: string,
    input: { testcaseId: string; targetUrl: string; instructions?: string | null }
  ) {
    this.assertUuid(projectId, "Project");
    this.assertUuid(input.testcaseId, "Test case");
    return this.automationAgents.startSingleGenerate(userId, projectId, input.testcaseId, {
      targetUrl: input.targetUrl,
      instructions: input.instructions ?? null
    });
  }
}
