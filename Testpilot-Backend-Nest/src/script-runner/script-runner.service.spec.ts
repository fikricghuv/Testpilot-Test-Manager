import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ScriptRunnerService } from "./script-runner.service";
import { SCRIPT_RUNNER_JOB } from "./script-runner.constants";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TESTCASE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SCRIPT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";

function createMocks() {
  const query = jest.fn();
  const clientQuery = jest.fn();
  const db = {
    query,
    transaction: jest.fn(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
      fn({ query: clientQuery })
    )
  };
  const legacy = {
    requireSession: jest.fn((uid?: string | null) => {
      if (!uid) throw new BadRequestException({ error: "Authentication required" });
      return uid;
    }),
    requireProjectAccess: jest.fn().mockResolvedValue({ id: PROJECT_ID }),
    logProjectActivity: jest.fn().mockResolvedValue(undefined)
  };
  const queue = {
    add: jest.fn().mockResolvedValue({ id: "job-1" })
  };
  const storage = {
    put: jest.fn().mockResolvedValue(undefined)
  };

  const service = new ScriptRunnerService(db as any, legacy as any, storage as any, queue as any);
  return { service, db, query, clientQuery, legacy, storage, queue };
}

describe("ScriptRunnerService", () => {
  it("returns empty script state when no script exists for testcase", async () => {
    const { service, query } = createMocks();
    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await service.getScript(USER_ID, PROJECT_ID, TESTCASE_ID);
    expect(res).toEqual({ script: null, versions: [], recentRuns: [] });
  });

  it("rejects empty scriptContent or invalid targetUrl on upsert", async () => {
    const { service, query } = createMocks();
    query.mockResolvedValue({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] });

    await expect(
      service.upsertScript(USER_ID, PROJECT_ID, TESTCASE_ID, { scriptContent: "   " })
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.upsertScript(USER_ID, PROJECT_ID, TESTCASE_ID, {
        scriptContent: "test('ok', async () => {});",
        targetUrl: "ftp://invalid.local"
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("creates a new script and version inside a transaction", async () => {
    const { service, query, clientQuery, legacy } = createMocks();
    const now = new Date("2026-11-25T10:00:00Z");

    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: SCRIPT_ID,
          project_id: PROJECT_ID,
          testcase_id: TESTCASE_ID,
          framework: "playwright-ts",
          target_url: "https://example.com/",
          status: "draft",
          active_version_id: VERSION_ID,
          active_version: 1,
          script_content: "test('login', async () => {});",
          source: "manual",
          created_at: now,
          updated_at: now
        }]
      })
      .mockResolvedValueOnce({
        rows: [{
          id: VERSION_ID,
          script_id: SCRIPT_ID,
          version: 1,
          script_content: "test('login', async () => {});",
          source: "manual",
          notes: "Initial",
          verified_locators: {},
          created_by: USER_ID,
          created_at: now
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: SCRIPT_ID }] })
      .mockResolvedValueOnce({ rows: [{ max_ver: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: VERSION_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await service.upsertScript(USER_ID, PROJECT_ID, TESTCASE_ID, {
      scriptContent: "test('login', async () => {});",
      targetUrl: "https://example.com",
      notes: "Initial"
    });

    expect(res.script?.activeVersion).toBe(1);
    expect(res.versions).toHaveLength(1);
    expect(legacy.logProjectActivity).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when activating an unknown version", async () => {
    const { service, query } = createMocks();
    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.activateVersion(USER_ID, PROJECT_ID, TESTCASE_ID, VERSION_ID)
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when triggering a run without a saved script", async () => {
    const { service, query } = createMocks();
    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.triggerRun(USER_ID, PROJECT_ID, TESTCASE_ID)).rejects.toThrow(BadRequestException);
  });

  it("creates cycle, execution, run record and enqueues BullMQ job on triggerRun", async () => {
    const { service, query, clientQuery, queue } = createMocks();
    const now = new Date("2026-11-25T10:00:00Z");
    const runId = "66666666-6666-4666-8666-666666666666";

    query
      .mockResolvedValueOnce({ rows: [{ id: TESTCASE_ID, title: "Login", external_id: "TC-1" }] })
      .mockResolvedValueOnce({
        rows: [{ id: SCRIPT_ID, active_version_id: VERSION_ID, target_url: "https://example.com" }]
      });

    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: "cycle-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "ci-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "exec-1" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: runId,
          project_id: PROJECT_ID,
          testcase_id: TESTCASE_ID,
          script_id: SCRIPT_ID,
          version_id: VERSION_ID,
          cycle_id: "cycle-1",
          execution_id: "exec-1",
          status: "queued",
          target_url: "https://example.com",
          duration_ms: null,
          stdout: null,
          stderr: null,
          error_message: null,
          triggered_by: USER_ID,
          started_at: null,
          finished_at: null,
          created_at: now
        }]
      });

    const res = await service.triggerRun(USER_ID, PROJECT_ID, TESTCASE_ID);
    expect(res.run.status).toBe("queued");
    expect(queue.add).toHaveBeenCalledWith(
      SCRIPT_RUNNER_JOB,
      { runId },
      expect.objectContaining({ removeOnComplete: 50, removeOnFail: 50 })
    );
  });
});
