import { BadRequestException } from "@nestjs/common";
import { AUTOMATION_AGENTS_JOB } from "./automation-agents.constants";
import { AutomationAgentsService } from "./automation-agents.service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TESTCASE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";

function createMocks() {
  const query = jest.fn();
  const db = { query };
  const legacy = {
    requireSession: jest.fn((uid?: string | null) => {
      if (!uid) throw new BadRequestException({ error: "Authentication required" });
      return uid;
    }),
    requireProjectAccess: jest.fn().mockResolvedValue({ id: PROJECT_ID }),
    runProjectAiPrompt: jest.fn(),
    createTestCase: jest.fn()
  };
  const inspector = {
    inspectPage: jest.fn()
  };
  const scriptRunner = {
    getScript: jest.fn(),
    upsertScript: jest.fn(),
    triggerRun: jest.fn()
  };
  const queue = {
    add: jest.fn().mockResolvedValue({ id: "bull-1" })
  };
  const service = new AutomationAgentsService(
    db as any,
    legacy as any,
    inspector as any,
    scriptRunner as any,
    queue as any
  );
  return { service, query, legacy, inspector, scriptRunner, queue };
}

describe("AutomationAgentsService", () => {
  it("rejects invalid targetUrl on startSingleGenerate", async () => {
    const { service } = createMocks();
    await expect(
      service.startSingleGenerate(USER_ID, PROJECT_ID, TESTCASE_ID, { targetUrl: "not-a-url" })
    ).rejects.toThrow(BadRequestException);
  });

  it("enqueues a 3-Agent single generate job and returns mapped job record", async () => {
    const { service, query, queue } = createMocks();
    const now = new Date("2026-11-26T14:00:00Z");
    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID,
            project_id: PROJECT_ID,
            testcase_id: TESTCASE_ID,
            mode: "single",
            stage: "queued",
            target_url: "https://example.com/",
            instructions: null,
            attempt: 0,
            max_attempts: 3,
            plan_json: {},
            logs_json: [{ at: now.toISOString(), stage: "queued", message: "Queued" }],
            discovered_scenarios_json: [],
            result_script_id: null,
            result_version_id: null,
            result_run_id: null,
            error_message: null,
            created_at: now,
            updated_at: now
          }
        ]
      });

    const res = await service.startSingleGenerate(USER_ID, PROJECT_ID, TESTCASE_ID, {
      targetUrl: "https://example.com"
    });

    expect(res.job.id).toBe(JOB_ID);
    expect(res.job.mode).toBe("single");
    expect(queue.add).toHaveBeenCalledWith(
      AUTOMATION_AGENTS_JOB,
      { jobId: JOB_ID },
      expect.any(Object)
    );
  });

  it("runs explore pipeline and saves grounded scenarios from live elements", async () => {
    const { service, query, inspector, legacy } = createMocks();
    const now = new Date("2026-11-26T14:00:00Z");
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID,
            project_id: PROJECT_ID,
            testcase_id: null,
            mode: "explore",
            stage: "queued",
            target_url: "https://example.com/",
            instructions: null,
            attempt: 0,
            max_attempts: 3,
            plan_json: {},
            logs_json: [],
            discovered_scenarios_json: [],
            created_by: USER_ID,
            created_at: now,
            updated_at: now
          }
        ]
      })
      .mockResolvedValue({ rows: [{ stage: "planning", logs_json: [] }] });

    inspector.inspectPage.mockResolvedValue({
      url: "https://example.com/",
      title: "Example",
      ariaSnapshot: "- button \"Sign In\"",
      interactiveElements: [
        {
          tag: "button",
          type: "submit",
          role: "button",
          label: "Sign In",
          placeholder: null,
          text: "Sign In",
          testId: null,
          id: null,
          playwrightLocator: "page.getByRole('button', { name: 'Sign In' })"
        }
      ]
    });

    legacy.runProjectAiPrompt.mockResolvedValue({
      provider: "openai",
      model: "gpt-4o",
      text: JSON.stringify({
        scenarios: [
          {
            title: "Sign in button is clickable",
            description: "Verify sign in action",
            steps: ["Open page", "Click Sign In"],
            expectedResult: "Navigates to login",
            priority: "high"
          }
        ]
      })
    });

    await service.executeJob(JOB_ID);

    expect(inspector.inspectPage).toHaveBeenCalledWith("https://example.com/", expect.anything());
    expect(legacy.runProjectAiPrompt).toHaveBeenCalledTimes(1);
    const completedUpdate = query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE test_agent_jobs") && call[1]?.[1] === "completed"
    );
    expect(completedUpdate).toBeDefined();
  });
});
