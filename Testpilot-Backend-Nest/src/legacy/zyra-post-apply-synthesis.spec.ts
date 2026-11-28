import { ConflictException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { ZyraChatSessionService } from "./zyra-chat-session.service";
import { buildZyraPostApplyFacts } from "./zyra-reply-guards";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function makeLegacy(queryImpl?: jest.Mock): LegacyService {
  const db = { query: queryImpl ?? jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    suitesCache,
    testcasesListCache,
    projectOverviewCache,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

describe("buildZyraPostApplyFacts", () => {
  it("skips synthesis for answer-only turns and salvaged turns", () => {
    expect(
      buildZyraPostApplyFacts(
        { reply: "Here is the summary.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      ).shouldSynthesize
    ).toBe(false);

    expect(
      buildZyraPostApplyFacts(
        { reply: "Drafted.", actionType: "create", operations: [{ type: "create" }], __salvaged: true },
        { testcases: [], activity: [] }
      ).shouldSynthesize
    ).toBe(false);
  });

  it("extracts accurate staged, persisted, moveBreakdown, and error counts for mutation turns", () => {
    const facts = buildZyraPostApplyFacts(
      {
        reply: "Drafting 2 cases",
        actionType: "create",
        operations: [{ type: "create" }, { type: "create" }, { type: "move_to_suite" }]
      },
      {
        testcases: [
          { action: "proposed-create", title: "Login valid" },
          { id: "tc-1", externalId: "PRO-TC-1", title: "Existing case" }
        ],
        activity: [
          { title: "Could not update testcase", detail: "PRO-TC-99 was not found." },
          { title: "Staged test case", detail: "Login valid" }
        ],
        moveBreakdown: [{ suiteId: "s1", suiteName: "Auth", created: true, count: 1 }],
        unresolvedMoveTargetCount: 1,
        archivedNowCount: 0
      }
    );

    expect(facts.shouldSynthesize).toBe(true);
    expect(facts.stagedCount).toBe(1);
    expect(facts.persistedCount).toBe(1);
    expect(facts.unresolvedMoveTargetCount).toBe(1);
    expect(facts.moveBreakdown).toEqual([{ suiteName: "Auth", created: true, count: 1 }]);
    expect(facts.errors).toEqual(["PRO-TC-99 was not found."]);
    expect(facts.titlesSample).toEqual(["Login valid", "Existing case"]);
  });
});

describe("LegacyService.synthesizeZyraPostApplyReply", () => {
  it("keeps answer turns as 1-call without invoking runProjectAiPrompt", async () => {
    const svc = makeLegacy() as any;
    const promptSpy = jest.spyOn(svc, "runProjectAiPrompt");
    const decision = { reply: "Coverage looks good.", actionType: "answer", operations: [] };
    const out = await svc.synthesizeZyraPostApplyReply("p1", "How is coverage?", decision, { testcases: [], activity: [] });
    expect(out).toBe(decision);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("synthesizes a grounded reply for mutation turns when AI key is available", async () => {
    const svc = makeLegacy() as any;
    jest.spyOn(svc, "zyraAiAllocation").mockResolvedValue({ key: { provider: "openai", api_key: "sk-test" }, reason: "" });
    const promptSpy = jest.spyOn(svc, "runProjectAiPrompt").mockResolvedValue({
      text: "Drafted 2 test cases for review in the Auth suite.",
      provider: "openai",
      model: "gpt-4o-mini"
    });
    const decision = {
      reply: "I created 5 test cases.",
      actionType: "create",
      operations: [{ type: "create" }, { type: "create" }]
    };
    const applied = {
      testcases: [
        { action: "proposed-create", title: "Case A" },
        { action: "proposed-create", title: "Case B" }
      ],
      activity: []
    };

    const out = await svc.synthesizeZyraPostApplyReply("p1", "Create login tests", decision, applied);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe("Drafted 2 test cases for review in the Auth suite.");
  });

  it("falls back to the original decision if post-apply synthesis throws", async () => {
    const svc = makeLegacy() as any;
    jest.spyOn(svc, "zyraAiAllocation").mockResolvedValue({ key: { provider: "openai", api_key: "sk-test" }, reason: "" });
    jest.spyOn(svc, "runProjectAiPrompt").mockRejectedValue(new Error("provider timeout"));
    const decision = {
      reply: "Drafted 1 test case.",
      actionType: "create",
      operations: [{ type: "create" }]
    };
    const applied = { testcases: [{ action: "proposed-create", title: "Case A" }], activity: [] };

    const out = await svc.synthesizeZyraPostApplyReply("p1", "Create 1 test", decision, applied);
    expect(out).toBe(decision);
  });
});

describe("ZyraChatSessionService", () => {
  it("refuses to delete a session while a generation plan is running", async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ active_plan: { status: "running" } }] });
    const svc = new ZyraChatSessionService({ query } as unknown as DatabaseService);
    await expect(
      svc.deleteSession("00000000-0000-4000-8000-000000000001", "u1", "00000000-0000-4000-8000-000000000002", async () => "u1")
    ).rejects.toThrow(ConflictException);
  });
});

describe("LegacyService.zyraEffectiveUpdateFields", () => {
  it("replaces all steps when a full shorter step list starting at step 1 is provided", () => {
    const svc = makeLegacy() as any;
    const current = {
      steps: [
        { stepNumber: 1, action: "Old 1", expectedResult: "Exp 1" },
        { stepNumber: 2, action: "Old 2", expectedResult: "Exp 2" },
        { stepNumber: 3, action: "Old 3", expectedResult: "Exp 3" }
      ]
    };
    const effective = svc.zyraEffectiveUpdateFields(
      { stepsJson: [{ stepNumber: 1, action: "Login as admin", expectedResult: "Dashboard shown" }] },
      current
    );
    expect(effective.stepsJson).toEqual([{ stepNumber: 1, action: "Login as admin", expectedResult: "Dashboard shown" }]);
  });

  it("still patches a single later step when stepNumber > 1 or action is blank", () => {
    const svc = makeLegacy() as any;
    const current = {
      steps: [
        { stepNumber: 1, action: "Open app", expectedResult: "App opens" },
        { stepNumber: 2, action: "Click login", expectedResult: "Vague" }
      ]
    };
    const effective = svc.zyraEffectiveUpdateFields(
      { stepsJson: [{ stepNumber: 2, action: "", expectedResult: "Redirected to /home" }] },
      current
    );
    expect(effective.stepsJson).toEqual([
      { stepNumber: 1, action: "Open app", expectedResult: "App opens" },
      { stepNumber: 2, action: "Click login", expectedResult: "Redirected to /home" }
    ]);
  });
});
