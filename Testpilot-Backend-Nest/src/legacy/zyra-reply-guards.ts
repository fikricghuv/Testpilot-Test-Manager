import { zyraReplyLanguage } from "./zyra-language-context";
import { foldRu, ZYRA_RU, ZYRA_RU_ALREADY_DISCLOSED, ZYRA_RU_COMPLETION_CLAIM } from "./zyra-replies-ru";

type Body = Record<string, any>;

export interface ZyraReconcileDecision {
  reply: string;
  actionType: string;
  operations: Array<{ type: string }>;
  __salvaged?: boolean;
}

export interface ZyraReconcileApplied {
  testcases: Body[];
  activity: Body[];
  moveBreakdown?: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>;
  unresolvedMoveTargetCount?: number;
  archivedNowCount?: number;
  liveSavedCount?: number;
}

export const ZYRA_COMPLETION_CLAIM =
  /\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(created|added|generated(\s+and\s+saved)?|saved|archived|updated|deleted|removed|moved|staged|drafted|proposed)\b[^.!?\n]{0,80}\b(test\s?cases?|tc-\d|suite|repository)\b|\b(test\s?cases?|suite)\b[^.!?\n]{0,80}\b(have|has|were|was)\s+been\s+(created|added|generated|saved|archived|updated|removed|moved|staged|drafted|proposed)\b|\b(test\s?cases?|suite)\b[^.!?\n,;]{0,10}\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s\w{1,12}\s)(created|added|generated|saved|archived|updated|deleted|removed|moved)\b/i;

export const ZYRA_TESTCASE_ONLY_COMPLETION_CLAIM =
  /\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(created|added|generated(\s+and\s+saved)?|saved|archived|updated|deleted|removed|moved|staged|drafted|proposed)\b[^.!?\n]{0,80}\b(test\s?cases?|tc-\d|repository)\b|\b(test\s?cases?)\b[^.!?\n]{0,80}\b(have|has|were|was)\s+been\s+(created|added|generated|saved|archived|updated|removed|moved|staged|drafted|proposed)\b|\b(test\s?cases?)\b[^.!?\n,;]{0,10}\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s\w{1,12}\s)(created|added|generated|saved|archived|updated|deleted|removed|moved)\b/i;

export const ZYRA_ALREADY_DISCLOSED =
  /\b(nothing (is|was|has\s+been) (saved|changed|created|written|generated)|no\s+test\s?cases?\s+(were|was)\s+(created|saved|added|generated|changed)|could\s+not\s+(create|save|generate|archive|update|add)|i\s+did\s+not\s+save\s+(it|them)|generation\s+is\s+(turned\s+off|disabled|off)|staged\s+for\s+(your\s+)?review|awaiting\s+(your\s+)?(go[\s-]?ahead|confirmation|approval)|until\s+you\s+save|not\s+(yet\s+)?(saved|written|applied)\s+to\s+the\s+repository)\b/i;

export const ZYRA_PERSISTED_CLAIM =
  /\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(created|added|saved|archived|updated|deleted|removed)\b[^.!?\n]{0,80}\b(test\s?cases?|tc-\d|suite|repository)\b|\b(test\s?cases?|suite)\b[^.!?\n]{0,80}\b(have|has|were|was)\s+been\s+(created|added|saved|archived|updated|removed)\b|\b(test\s?cases?|suite)\b[^.!?\n,;]{0,10}\b(?<!\b(?:being|getting|will\s+be|would\s+be|should\s+be|could\s+be|can\s+be|must\s+be|to\s+be|not\s+yet)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s)(?<!\b(?:that|which|who)\s(?:was|were)\s\w{1,12}\s)(created|added|saved|archived|updated|deleted|removed)\b/i;

export const ZYRA_NON_TESTCASE_OP_TYPES = new Set([
  "create_suite",
  "create_run",
  "update_run",
  "delete_run",
  "create_bug",
  "update_bug",
  "delete_bug",
  "generate_script",
  "run_script"
]);

export function isZyraTestcaseTable(block: string[]): boolean {
  if (block.length < 2) return false;
  if (!block.slice(0, 2).some((line) => /^\s*\|[\s:|-]+\|\s*$/.test(line))) return false;
  const header = block[0].split("|").map((cell) => cell.trim().toLowerCase()).filter(Boolean);
  const anchors = ["title", "scenario", "steps", "step", "expected", "precondition", "preconditions", "postcondition", "postconditions"];
  const columns = [...anchors, "priority", "severity", "type", "status", "area", "module", "id", "#", "test case", "testcase"];
  const hasAnchor = header.some((cell) => anchors.some((anchor) => cell.includes(anchor)));
  const matches = header.filter((cell) => columns.some((column) => cell.includes(column))).length;
  return hasAnchor && matches >= 2;
}

export function stripZyraTestcaseTables(reply: string, hasRows: boolean): string {
  const lines = reply.split("\n");
  const kept: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].trim().startsWith("|")) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].trim().startsWith("|")) end += 1;
    const block = lines.slice(i, end);
    if (isZyraTestcaseTable(block)) {
      removed = true;
    } else {
      kept.push(...block);
    }
    i = end;
  }
  if (!removed) return reply;
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (hasRows) return cleaned;
  return [
    cleaned,
    "",
    zyraReplyLanguage() === "ru"
      ? ZYRA_RU.strippedTable
      : "_Those test cases were only described in chat — they were not saved to the repository. Ask me to generate them and they'll be created and shown in the table above._"
  ].join("\n").trim();
}

export function zyraMoveBreakdownSuffix(
  moveBreakdown: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }> | undefined
): string {
  if (!moveBreakdown || !moveBreakdown.length) return "";
  const total = moveBreakdown.reduce((sum, entry) => sum + entry.count, 0);
  if (zyraReplyLanguage() === "ru") {
    const partsRu = moveBreakdown.map((entry) => {
      const label = entry.created ? ZYRA_RU.moveSuiteCreated(entry.suiteName) : entry.suiteName;
      return entry.count > 0 ? `${label}: ${entry.count}` : ZYRA_RU.moveNoneMatched(label);
    });
    return ZYRA_RU.movedToSuites(partsRu, total);
  }
  const parts = moveBreakdown.map((entry) => {
    const label = entry.created ? `${entry.suiteName} (created)` : entry.suiteName;
    return entry.count > 0 ? `${label}: ${entry.count}` : `${label}: 0 (none matched)`;
  });
  return `\n\n📦 **Moved to suites (actual):** ${parts.join(" · ")} — ${total} test case(s) total.`;
}

function zyraFalseCompletionBannerRu(reply: string, salvaged: boolean, englishPattern: RegExp): string {
  const folded = foldRu(reply);
  if (!englishPattern.test(reply) && !ZYRA_RU_COMPLETION_CLAIM.test(folded)) return "";
  if (!salvaged && (ZYRA_ALREADY_DISCLOSED.test(reply) || ZYRA_RU_ALREADY_DISCLOSED.test(folded))) return "";
  return ZYRA_RU.falseClaimBanner;
}

export function zyraFalseCompletionBanner(
  reply: string,
  salvaged = false,
  claimPattern: RegExp = ZYRA_COMPLETION_CLAIM
): string {
  if (zyraReplyLanguage() === "ru") return zyraFalseCompletionBannerRu(reply, salvaged, claimPattern);
  if (!claimPattern.test(reply)) return "";
  if (!salvaged && ZYRA_ALREADY_DISCLOSED.test(reply)) return "";
  return "⚠️ **Sorry! Nothing was saved.** Anything described below as created, saved or archived was not carried out — I only described it.\n\nAsk me to go ahead and I'll make the change and show you the affected test cases.";
}

export function zyraPersistedClaimBanner(reply: string): string {
  if (zyraReplyLanguage() === "ru") {
    const folded = foldRu(reply);
    const claims = ZYRA_PERSISTED_CLAIM.test(reply) || ZYRA_RU_COMPLETION_CLAIM.test(folded);
    const disclosed = ZYRA_ALREADY_DISCLOSED.test(reply) || ZYRA_RU_ALREADY_DISCLOSED.test(folded);
    return claims && !disclosed ? ZYRA_RU.falseClaimBanner : "";
  }
  if (!ZYRA_PERSISTED_CLAIM.test(reply) || ZYRA_ALREADY_DISCLOSED.test(reply)) return "";
  return "⚠️ **Sorry! Nothing was saved.** Anything described below as created, saved or archived was not carried out — I only described it.\n\nAsk me to go ahead and I'll make the change and show you the affected test cases.";
}

export function reconcileZyraReply(decision: ZyraReconcileDecision, applied: ZyraReconcileApplied): string {
  const archiveFailure = applied.activity.find((entry) => String(entry.detail || "").startsWith("The confirmed archive failed"));
  const archivedSuffix = applied.archivedNowCount
    ? `\n\n🗄️ Archived ${applied.archivedNowCount} test case${applied.archivedNowCount === 1 ? "" : "s"} — they now show under the Archived filter in the repository and can be restored from there.`
    : archiveFailure
      ? `\n\n⚠️ ${String(archiveFailure.detail)}`
      : "";
  const moveSuffix = zyraMoveBreakdownSuffix(applied.moveBreakdown) + archivedSuffix;

  if (decision.actionType === "answer") {
    const banner = !applied.testcases.length && !applied.liveSavedCount ? zyraFalseCompletionBanner(decision.reply, decision.__salvaged) : "";
    return banner ? [banner, "", decision.reply].join("\n") + moveSuffix : decision.reply + moveSuffix;
  }

  if (decision.operations.length && decision.operations.every((op) => ZYRA_NON_TESTCASE_OP_TYPES.has(op.type))) {
    const banner = zyraFalseCompletionBanner(decision.reply, decision.__salvaged, ZYRA_TESTCASE_ONLY_COMPLETION_CLAIM);
    return (banner ? banner + "\n\n" : "") + decision.reply + moveSuffix;
  }

  const requested = decision.operations.filter((op) => !ZYRA_NON_TESTCASE_OP_TYPES.has(op.type)).length;
  const appliedCount = applied.testcases.length + (applied.liveSavedCount ?? 0);
  const ru = zyraReplyLanguage() === "ru";

  const unchangedUpdates = applied.activity
    .filter((entry) => entry.title === "Could not update testcase" && /did not change any field|drafting it|drafting step/.test(String(entry.detail || "")))
    .map((entry) => String(entry.detail));
  if (!appliedCount && unchangedUpdates.length) {
    if (ru) return [ZYRA_RU.nothingStagedNoChange(unchangedUpdates.length), "", decision.reply].join("\n") + moveSuffix;
    return [
      `⚠️ Nothing was staged. ${unchangedUpdates.join(" ")} The test case${unchangedUpdates.length === 1 ? " is" : "s are"} unchanged.`,
      "",
      decision.reply
    ].join("\n") + moveSuffix;
  }
  if (!appliedCount && ru) {
    const detailRu = decision.operations.length ? ZYRA_RU.nothingSavedMissing : ZYRA_RU.nothingSavedNoOps;
    return [ZYRA_RU.nothingSaved(detailRu), "", decision.reply].join("\n") + moveSuffix;
  }
  if (!appliedCount) {
    const detail = decision.operations.length
      ? "The test cases it referred to do not exist in this project, so there was nothing to change."
      : "I did not produce any test case operations for this request.";
    return [
      `⚠️ Nothing was saved. ${detail} Ask me to generate the test cases and I'll draft them for review in the same step.`,
      "",
      decision.reply
    ].join("\n") + moveSuffix;
  }

  const proposedCount = applied.testcases.filter((tc) => typeof tc.action === "string" && tc.action.startsWith("proposed-")).length;
  const reviewHint = proposedCount > 0 && ru
    ? ZYRA_RU.reviewHint(proposedCount)
    : proposedCount > 0
      ? `\n\n📝 ${proposedCount} of them ${proposedCount === 1 ? "is" : "are"} staged for your review — open the review panel to select, edit, or discard, then Save to add ${proposedCount === 1 ? "it" : "them"} to the repository. Nothing has been written to the repository yet.`
      : "";

  const banner = proposedCount > 0 ? zyraPersistedClaimBanner(decision.reply) : "";
  const bannerPrefix = banner ? banner + "\n\n" : "";

  const unresolvedMoves = applied.unresolvedMoveTargetCount || 0;
  if (appliedCount < requested || unresolvedMoves > 0) {
    const reasons = applied.activity
      .filter((entry) => /could not|skipped/i.test(String(entry.title || "")))
      .map((entry) => String(entry.detail || entry.title))
      .filter(Boolean);
    if (ru) {
      const headlineRu = [
        appliedCount < requested ? ZYRA_RU.partialHeadline(appliedCount, requested) : "",
        unresolvedMoves > 0 ? ZYRA_RU.partialUnresolvedMoves(unresolvedMoves) : ""
      ].filter(Boolean).join(" ");
      return bannerPrefix + [
        `⚠️ ${headlineRu}` + (appliedCount < requested ? ZYRA_RU.partialRestNotDrafted : ""),
        "",
        decision.reply + reviewHint
      ].join("\n") + moveSuffix;
    }
    const headline = [
      appliedCount < requested ? `${appliedCount} of ${requested} test case operation(s) were drafted for review.` : "",
      unresolvedMoves > 0 ? `${unresolvedMoves} named test case(s) could not be moved.` : ""
    ].filter(Boolean).join(" ");
    return bannerPrefix + [
      `⚠️ ${headline}` + (reasons.length ? ` ${reasons.join(" ")}` : appliedCount < requested ? " The rest were not drafted." : ""),
      "",
      decision.reply + reviewHint
    ].join("\n") + moveSuffix;
  }

  return bannerPrefix + decision.reply + reviewHint + moveSuffix;
}

export function finalizeZyraChatReply(decision: ZyraReconcileDecision, applied: ZyraReconcileApplied, renderedRows: Body[]): string {
  const reconciled = reconcileZyraReply(decision, applied);
  return stripZyraTestcaseTables(reconciled, renderedRows.length > 0);
}

export interface ZyraPostApplyFacts {
  shouldSynthesize: boolean;
  actionType: string;
  requestedOperations: number;
  stagedCount: number;
  persistedCount: number;
  archivedNowCount: number;
  liveSavedCount: number;
  unresolvedMoveTargetCount: number;
  moveBreakdown: Array<{ suiteName: string; created: boolean; count: number }>;
  errors: string[];
  titlesSample: string[];
}

/**
 * Extracts ground-truth execution facts after `applyZyraChatOperations` finishes so post-apply
 * reply synthesis can narrate what actually happened instead of relying on pre-execution prose.
 */
export function buildZyraPostApplyFacts(decision: ZyraReconcileDecision, applied: ZyraReconcileApplied): ZyraPostApplyFacts {
  const stagedCount = applied.testcases.filter((tc) => typeof tc.action === "string" && tc.action.startsWith("proposed-")).length;
  const persistedCount = applied.testcases.length - stagedCount;
  const archivedNowCount = applied.archivedNowCount ?? 0;
  const liveSavedCount = applied.liveSavedCount ?? 0;
  const unresolvedMoveTargetCount = applied.unresolvedMoveTargetCount ?? 0;
  const moveBreakdown = (applied.moveBreakdown || []).map((m) => ({
    suiteName: m.suiteName,
    created: m.created,
    count: m.count
  }));
  const errors = applied.activity
    .filter((entry) => /could not|skipped|failed/i.test(String(entry.title || "")) || String(entry.detail || "").startsWith("The confirmed archive failed"))
    .map((entry) => String(entry.detail || entry.title))
    .filter(Boolean)
    .slice(0, 8);
  const titlesSample = applied.testcases
    .map((tc) => String(tc.title || tc.externalId || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  const shouldSynthesize =
    decision.actionType !== "answer" &&
    decision.operations.length > 0 &&
    !decision.__salvaged;

  return {
    shouldSynthesize,
    actionType: decision.actionType,
    requestedOperations: decision.operations.length,
    stagedCount,
    persistedCount,
    archivedNowCount,
    liveSavedCount,
    unresolvedMoveTargetCount,
    moveBreakdown,
    errors,
    titlesSample
  };
}
