import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCaseId, testpilotTag } from "./tag";

const noAnnotations: { type: string; description?: string }[] = [];

test("reads the case id from the documented tag form", () => {
  assert.deepEqual(extractCaseId(['@testpilot.testId("TES-1042")'], noAnnotations), {
    caseId: "TES-1042",
    malformed: null
  });
});

test("accepts single quotes and incidental whitespace", () => {
  assert.equal(extractCaseId([`@testpilot.testId( 'TES-7' )`], noAnnotations).caseId, "TES-7");
});

test("ignores unrelated tags alongside the marker", () => {
  assert.equal(extractCaseId(["@smoke", '@testpilot.testId("TES-1")', "@slow"], noAnnotations).caseId, "TES-1");
});

/*
 * The card's own Playwright example omits the leading '@'. Playwright itself refuses that tag
 * ("Tag must start with \"@\" symbol"), so a suite written to the card verbatim never loads — but if
 * the string ever reaches this parser (from an annotation, or a future framework), it must not be
 * silently accepted as valid, or the two forms would diverge.
 */
test("does not match the card's unprefixed form, which Playwright itself rejects", () => {
  assert.deepEqual(extractCaseId(['testpilot.testId("TES-1042")'], noAnnotations), {
    caseId: null,
    malformed: null
  });
});

test("a lookalike tag from another tool is not a TestPilot marker", () => {
  assert.deepEqual(extractCaseId(['@not-testpilot.testId("X-1")'], noAnnotations), {
    caseId: null,
    malformed: null
  });
});

test("untagged is untagged, not malformed", () => {
  assert.deepEqual(extractCaseId(["@smoke"], noAnnotations), { caseId: null, malformed: null });
  assert.deepEqual(extractCaseId([], noAnnotations), { caseId: null, malformed: null });
});

test("a TestPilot marker that cannot be parsed is reported as malformed", () => {
  const result = extractCaseId(["@testpilot.testId(TES-1042)"], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

test("an empty id is malformed rather than an empty case id", () => {
  const result = extractCaseId(['@testpilot.testId("")'], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

/*
 * Two ids on one test would otherwise report against whichever the iteration order reached first,
 * which is a silently wrong result attached to a real case — the failure mode §3 exists to prevent.
 */
test("more than one id on a test is refused, not arbitrarily resolved", () => {
  const result = extractCaseId(['@testpilot.testId("TES-1")', '@testpilot.testId("TES-2")'], noAnnotations);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /more than one TestPilot case id \(TES-1, TES-2\)/);
});

test("the same id declared twice is not a conflict", () => {
  assert.equal(extractCaseId(['@testpilot.testId("TES-1")', '@testpilot.testId("TES-1")'], noAnnotations).caseId, "TES-1");
});

test("falls back to the testpilot annotation when no tag carries an id", () => {
  assert.equal(extractCaseId([], [{ type: "testpilot", description: "TES-99" }]).caseId, "TES-99");
});

test("a tag wins over an annotation, since the tag is the documented convention", () => {
  assert.equal(
    extractCaseId(['@testpilot.testId("TES-TAG")'], [{ type: "testpilot", description: "TES-ANNOTATION" }]).caseId,
    "TES-TAG"
  );
});

test("annotations of other types are left alone", () => {
  assert.deepEqual(extractCaseId([], [{ type: "issue", description: "TES-1" }]), {
    caseId: null,
    malformed: null
  });
});

test("an empty testpilot annotation is malformed, not untagged", () => {
  const result = extractCaseId([], [{ type: "testpilot", description: "   " }]);
  assert.equal(result.caseId, null);
  assert.match(result.malformed ?? "", /could not be read/);
});

test("ids are not shape-validated locally — the project decides its own format", () => {
  // A team using 'LOGIN_01' or 'abc123' is not doing anything wrong; only the server knows which
  // ids exist, which is what the startup resolve call is for.
  assert.equal(extractCaseId(['@testpilot.testId("LOGIN_01")'], noAnnotations).caseId, "LOGIN_01");
  assert.equal(extractCaseId(['@testpilot.testId("abc123")'], noAnnotations).caseId, "abc123");
});

test("testpilotTag round-trips through the parser", () => {
  assert.equal(extractCaseId([testpilotTag("TES-500")], noAnnotations).caseId, "TES-500");
});
