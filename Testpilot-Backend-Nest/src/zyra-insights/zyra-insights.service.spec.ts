import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AutomationAgentsService } from "../automation-agents/automation-agents.service";
import type { DatabaseService } from "../database/database.service";
import type { LegacyService } from "../legacy/legacy.service";
import { ZyraInsightsService } from "./zyra-insights.service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PERF_ID = "33333333-3333-4333-8333-333333333333";
const TC_ID = "44444444-4444-4444-8444-444444444444";

describe("ZyraInsightsService", () => {
  function makeService(dbRows: Record<string, unknown[][]>, aiText: string) {
    const db = {
      query: jest.fn((sql: string) => {
        for (const [needle, rows] of Object.entries(dbRows)) {
          if (sql.includes(needle)) {
            return Promise.resolve({ rows });
          }
        }
        return Promise.resolve({ rows: [] });
      })
    } as unknown as DatabaseService;

    const legacy = {
      requireProjectAccess: jest.fn().mockResolvedValue({ id: PROJECT_ID }),
      runProjectAiPrompt: jest.fn().mockResolvedValue({
        text: aiText,
        provider: "openai",
        model: "gpt-4o-mini"
      })
    } as unknown as LegacyService;

    const automationAgents = {
      startSingleGenerate: jest.fn().mockResolvedValue({ id: "job-1", status: "queued" })
    } as unknown as AutomationAgentsService;

    return { service: new ZyraInsightsService(db, legacy, automationAgents), automationAgents, legacy };
  }

  it("triages a failed script run and builds a bugDraft", async () => {
    const aiJson = JSON.stringify({
      classification: "selector_drift",
      confidence: "high",
      rootCause: "Login submit button selector changed from #submit to [data-testid='login-btn'].",
      suggestedFix: "Update locator to page.getByTestId('login-btn').",
      bugDraft: {
        title: "Login button locator fails in Playwright",
        description: "Selector #submit no longer exists.",
        stepsToReproduce: "1. Open /login\n2. Click submit",
        expectedResult: "User logs in",
        actualResult: "Timeout waiting for #submit",
        severity: "medium",
        priority: "high"
      }
    });

    const { service } = makeService(
      {
        "FROM test_script_runs r": [
          [
            {
              id: RUN_ID,
              status: "failed",
              error_message: "Timeout waiting for #submit",
              stdout: "",
              stderr: "waiting for locator('#submit')",
              failure_analysis: { category: "selector_not_found" },
              target_url: "https://example.com/login",
              browser: "chromium",
              tc_title: "User Login",
              tc_external_id: "DEMO-TC-1",
              tc_steps: ["Open login", "Click submit"],
              tc_expected: "Logged in"
            }
          ]
        ]
      },
      aiJson
    );

    const res = await service.triageFailure("user-1", PROJECT_ID, { runId: RUN_ID });
    expect(res.classification).toBe("selector_drift");
    expect(res.confidence).toBe("high");
    expect(res.bugDraft.title).toContain("Login button");
  });

  it("analyzes a performance run and returns k6 recommendations", async () => {
    const aiJson = JSON.stringify({
      healthVerdict: "threshold_failed",
      summary: "p95 latency exceeded 500ms due to slow /api/orders query.",
      bottlenecks: ["GET /api/orders p95=920ms"],
      recommendations: ["Add index on orders(user_id)"],
      recommendedConfig: {
        loadProfile: "ramp",
        vus: 20,
        durationSec: 60,
        p95ThresholdMs: 500,
        maxErrorRate: 0.01
      }
    });

    const { service } = makeService(
      {
        "FROM performance_tests": [
          [{ id: PERF_ID, name: "Orders Load", target_url: "https://example.com", load_profile: "load", vus: 10, duration_sec: 30 }]
        ],
        "FROM performance_test_runs": [
          [{ id: "run-p1", status: "failed", total_requests: 500, rps: 16.5, error_rate: 0, p95_ms: 920, thresholds_passed: false }]
        ]
      },
      aiJson
    );

    const res = await service.analyzePerformanceRun("user-1", PROJECT_ID, { performanceTestId: PERF_ID });
    expect(res.healthVerdict).toBe("threshold_failed");
    expect(res.bottlenecks).toHaveLength(1);
    expect(res.recommendedConfig.vus).toBe(20);
  });

  it("generates structured test data and Playwright fixture snippet", async () => {
    const aiJson = JSON.stringify({
      summary: "Generated 2 datasets for email/password login.",
      datasets: [
        {
          category: "valid",
          name: "Standard user",
          input: { email: "qa@example.com", password: "Password123!" },
          expectedBehavior: "Login succeeds"
        },
        {
          category: "boundary",
          name: "Empty password",
          input: { email: "qa@example.com", password: "" },
          expectedBehavior: "Validation error shown"
        }
      ],
      playwrightFixtureSnippet: "const fixtures = [];"
    });

    const { service } = makeService(
      {
        "FROM testcases": [[{ external_id: "DEMO-TC-1", title: "Login", steps: ["Enter credentials"], expected_result: "Success" }]]
      },
      aiJson
    );

    const res = await service.generateTestData("user-1", PROJECT_ID, { testcaseId: TC_ID });
    expect(res.datasets).toHaveLength(2);
    expect(res.datasets[1].category).toBe("boundary");
    expect(res.playwrightFixtureSnippet).toContain("fixtures");
  });

  it("bridges Zyra -> Automation via startSingleGenerate", async () => {
    const { service, automationAgents } = makeService({}, "{}");
    const job = await service.generateAutomationForTestCase("user-1", PROJECT_ID, {
      testcaseId: TC_ID,
      targetUrl: "https://example.com"
    });
    expect(job).toEqual({ id: "job-1", status: "queued" });
    expect(automationAgents.startSingleGenerate).toHaveBeenCalledWith("user-1", PROJECT_ID, TC_ID, {
      targetUrl: "https://example.com",
      instructions: null
    });
  });

  it("validates missing parameters", async () => {
    const { service } = makeService({}, "{}");
    await expect(service.triageFailure("user-1", PROJECT_ID, {})).rejects.toThrow(BadRequestException);
    await expect(service.generateTestData("user-1", PROJECT_ID, {})).rejects.toThrow(BadRequestException);
    await expect(service.triageFailure("user-1", "bad-id", { runId: RUN_ID })).rejects.toThrow(NotFoundException);
  });
});
