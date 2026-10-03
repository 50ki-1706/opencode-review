import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as v from "valibot";
import {
  buildJevState,
  degradeJevState,
  fitJevState,
  jevQuestions,
  jevRequestBody,
  jevResponseSchema,
  jevStateSize,
  JEV_STATE_LIMIT_CODE_UNITS,
  validationResultFromJev,
  findingSchema,
  resolvedRangeSchema,
  type JevEvidence,
  type JevState,
  type Finding,
  type ResolvedRange,
} from "../src/finding.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./jev/fixtures/${name}`, import.meta.url), "utf8"));

const parseFixture = (name: string) => v.safeParse(jevResponseSchema, fixture(name));

test("valid and threshold response fixtures conform to the Valibot schema", () => {
  for (const name of ["response-valid.json", "response-threshold-at.json", "response-threshold-below.json", "response-threshold-above.json"]) {
    assert.equal(parseFixture(name).success, true, name);
  }
  const valid = parseFixture("response-valid.json");
  assert.equal(valid.success, true);
  if (!valid.success) {
    return;
  }
  assert.deepEqual(validationResultFromJev(valid.output), { supported: 0.92, commentWorthy: 0.81, rangeQuality: "correct" });
});

test("malformed response fixtures fail on the expected path", () => {
  const cases: Array<[string, RegExp]> = [
    ["response-invalid-missing-answer.json", /rangeQuality/],
    ["response-invalid-noul-range.json", /supported\.noul/],
    ["response-invalid-choice-enum.json", /rangeQuality\.choice/],
    ["response-invalid-type.json", /supported\.type/],
  ];
  for (const [name, expected] of cases) {
    const parsed = parseFixture(name);
    assert.equal(parsed.success, false, name);
    if (parsed.success) {
      continue;
    }
    const paths = parsed.issues.map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? "");
    assert.ok(paths.some((path) => expected.test(path)), `${name}: ${paths.join("; ")}`);
  }
});

test("cost is tolerated as an undocumented string or number", () => {
  const base = fixture("response-valid.json") as Record<string, unknown>;
  assert.equal(v.safeParse(jevResponseSchema, { ...base, cost: "0" }).success, true);
  assert.equal(v.safeParse(jevResponseSchema, { ...base, cost: 0 }).success, true);
  assert.equal(v.safeParse(jevResponseSchema, { ...base, cost: {} }).success, false);
  assert.equal(v.safeParse(jevResponseSchema, { ...base, cost: null }).success, false);
});

test("unknown top-level fields and unexpected answer keys are rejected", () => {
  const base = fixture("response-valid.json") as Record<string, unknown>;
  assert.equal(v.safeParse(jevResponseSchema, { ...base, score: 1 }).success, false);
  assert.equal(v.safeParse(jevResponseSchema, { ...base, provider: "zen" }).success, false);
  const answers = base["answers"] as Record<string, unknown>;
  assert.equal(v.safeParse(jevResponseSchema, { ...base, answers: { ...answers, score: 1 } }).success, false);
});

test("missing question keys and optional choice fields are handled", () => {
  const base = fixture("response-valid.json") as Record<string, unknown>;
  const answers = base["answers"] as Record<string, unknown>;
  const { commentWorthy: _dropped, ...withoutCommentWorthy } = answers;
  assert.equal(v.safeParse(jevResponseSchema, { ...base, answers: withoutCommentWorthy }).success, false);

  const rangeQuality = { ...(answers["rangeQuality"] as Record<string, unknown>) };
  delete rangeQuality["probabilities"];
  assert.equal(v.safeParse(jevResponseSchema, { ...base, answers: { ...answers, rangeQuality } }).success, true);
  delete rangeQuality["confidence"];
  assert.equal(v.safeParse(jevResponseSchema, { ...base, answers: { ...answers, rangeQuality } }).success, true);

  const partial = { ...(answers["rangeQuality"] as Record<string, unknown>), probabilities: { correct: 1, too_narrow: 0 } };
  assert.equal(v.safeParse(jevResponseSchema, { ...base, answers: { ...answers, rangeQuality: partial } }).success, false);
});

const finding: Finding = v.parse(findingSchema, {
  id: "finding-1",
  skill: "bug-review",
  path: "src/counter.ts",
  candidateRange: { start: 2, end: 2, anchor: "  return n + 1;" },
  severity: "medium",
  title: "Off-by-one in increment",
  body: "callers expect increment(0) to return 0, but the function returns 1.",
});

const resolved: ResolvedRange = v.parse(resolvedRangeSchema, {
  path: "src/counter.ts",
  commitId: "0123456789abcdef0123456789abcdef01234567",
  startLine: 2,
  endLine: 2,
  anchorStartLine: 2,
  side: "RIGHT",
  code: "export function increment(n: number) {\n  return n + 1;\n}",
});

const evidence: JevEvidence = {
  contextBefore: ["export function increment(n: number) {"],
  contextAfter: ["}"],
  diffHunks: ["@@ -1,3 +1,3 @@", " export function increment(n: number) {", "-  return n;", "+  return n + 1;", " }"],
  evidenceTruncated: false,
};

test("jevRequestBody is deterministic and keeps the contract key order", () => {
  const first = jevRequestBody({ model: "jev-1.13-free", finding, resolved, skillCriteria: { name: "bug-review", criteria: "Report concrete harm." }, evidence });
  const second = jevRequestBody({ model: "jev-1.13-free", finding, resolved, skillCriteria: { name: "bug-review", criteria: "Report concrete harm." }, evidence });
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  assert.deepEqual(Object.keys(first), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(first.state), ["skill", "finding", "range", "evidence"]);
  assert.deepEqual(Object.keys(first.state.finding), ["path", "severity", "title", "body"]);
  assert.deepEqual(Object.keys(first.state.evidence), ["contextBefore", "contextAfter", "diffHunks", "evidenceTruncated"]);
  assert.deepEqual(Object.keys(first.questions), ["supported", "commentWorthy", "rangeQuality"]);

  assert.equal(first.questions.supported.type, "noul");
  assert.equal(first.questions.commentWorthy.type, "noul");
  assert.equal(first.questions.rangeQuality.type, "choice");
  assert.equal(first.questions.rangeQuality.criteria.correct, null);
  assert.deepEqual(first.state.range.code, ["export function increment(n: number) {", "  return n + 1;", "}"]);
  assert.equal(first.state.finding.path, "src/counter.ts");
});

test("buildJevState keeps already-shaped evidence untouched at L0", () => {
  const state = buildJevState({ finding, resolved, skillCriteria: { name: "bug-review", criteria: "Report concrete harm." }, evidence });
  assert.deepEqual(state.evidence, evidence);
  assert.equal(jevStateSize(state), JSON.stringify(state).length);
});

test("fitJevState degrades oversized evidence before giving up", () => {
  const bulky: JevEvidence = {
    contextBefore: Array.from({ length: 2000 }, (_, index) => `before line ${index} ${"x".repeat(40)}`),
    contextAfter: Array.from({ length: 2000 }, (_, index) => `after line ${index} ${"y".repeat(40)}`),
    diffHunks: Array.from({ length: 500 }, (_, index) => `+${index} ${"z".repeat(40)}`),
    evidenceTruncated: false,
  };
  const state = buildJevState({ finding, resolved, skillCriteria: { name: "bug-review", criteria: "c" }, evidence: bulky });
  const fitted = fitJevState(state);
  assert.equal(fitted.kind, "fits");
  if (fitted.kind !== "fits") {
    return;
  }
  assert.ok(fitted.level > 0, "oversized evidence must use a degradation level");
  assert.ok(jevStateSize(fitted.state) <= JEV_STATE_LIMIT_CODE_UNITS);
  assert.equal(fitted.state.evidence.evidenceTruncated, true);
});

test("fitJevState reports evidence_overflow when the range code itself exceeds the limit", () => {
  const hugeResolved = v.parse(resolvedRangeSchema, { ...resolved, code: "x".repeat(JEV_STATE_LIMIT_CODE_UNITS + 1) });
  const state = buildJevState({ finding, resolved: hugeResolved, skillCriteria: { name: "bug-review", criteria: "c" }, evidence });
  assert.deepEqual(fitJevState(state), { kind: "evidence_overflow" });
});

// --- Phase 4 golden fixtures -------------------------------------------------

test("the captured request fixture is reproduced byte for byte", () => {
  const expected = fixture("request-expected.json") as {
    state: {
      skill: { name: string; criteria: string };
      finding: { path: string; severity: string; title: string; body: string };
      range: { commitId: string; path: string; startLine: number; endLine: number; side: "RIGHT"; code: string[] };
      evidence: JevEvidence;
    };
  };
  const { state } = expected;
  const fixtureFinding = v.parse(findingSchema, {
    id: "fixture-finding",
    skill: state.skill.name,
    path: state.finding.path,
    candidateRange: {
      start: state.range.startLine,
      end: state.range.endLine,
      anchor: state.range.code.join("\n"),
    },
    severity: state.finding.severity,
    title: state.finding.title,
    body: state.finding.body,
  });
  const fixtureResolved = v.parse(resolvedRangeSchema, {
    path: state.range.path,
    commitId: state.range.commitId,
    startLine: state.range.startLine,
    endLine: state.range.endLine,
    anchorStartLine: state.range.startLine,
    side: state.range.side,
    code: state.range.code.join("\n"),
  });
  const request = jevRequestBody({
    model: "jev-1.13-free",
    finding: fixtureFinding,
    resolved: fixtureResolved,
    skillCriteria: state.skill,
    evidence: state.evidence,
  });
  assert.equal(JSON.stringify(request), JSON.stringify(fixture("request-expected.json")));
});

test("questions are program-fixed: exact keys, option enum and no finding text", () => {
  assert.deepEqual(Object.keys(jevQuestions), ["supported", "commentWorthy", "rangeQuality"]);
  assert.deepEqual(Object.keys(jevQuestions.supported), ["type", "instructions", "criteria"]);
  assert.equal(jevQuestions.supported.type, "noul");
  assert.equal(jevQuestions.commentWorthy.type, "noul");
  assert.equal(jevQuestions.rangeQuality.type, "choice");
  assert.deepEqual(Object.keys(jevQuestions.rangeQuality.criteria), ["correct", "too_narrow", "too_wide", "wrong_location"]);
  assert.equal(jevQuestions.rangeQuality.criteria.correct, null);
  for (const option of ["too_narrow", "too_wide", "wrong_location"] as const) {
    assert.equal(typeof jevQuestions.rangeQuality.criteria[option], "string", option);
    assert.ok((jevQuestions.rangeQuality.criteria[option] as string).length > 0, option);
  }
  const request = jevRequestBody({ model: "jev-1.13-free", finding, resolved, skillCriteria: { name: "bug-review", criteria: "c" }, evidence });
  const questionsJson = JSON.stringify(request.questions);
  for (const value of [finding.title, finding.body, finding.candidateRange.anchor]) {
    assert.ok(!questionsJson.includes(value), "finding text must stay out of the questions");
  }
});

test("the state-minimum fixture fits at L0 byte-identically", () => {
  const state = fixture("state-minimum.json") as JevState;
  const fitted = fitJevState(state);
  assert.equal(fitted.kind, "fits");
  if (fitted.kind !== "fits") {
    return;
  }
  assert.equal(fitted.level, 0);
  assert.equal(JSON.stringify(fitted.state), JSON.stringify(state));
});

test("the state-overflow fixture is evidence_overflow even at the floor", () => {
  const state = fixture("state-overflow.json") as JevState;
  const fitted = fitJevState(state);
  assert.deepEqual(fitted, { kind: "evidence_overflow" });
  assert.ok(jevStateSize(degradeJevState(state, 4)) > JEV_STATE_LIMIT_CODE_UNITS);
});

test("ladder levels are ordered, byte-identical across runs and mark truncation", () => {
  const state = fixture("state-minimum.json") as JevState;
  const levels = [0, 1, 2, 3, 4] as const;
  const first = levels.map((level) => JSON.stringify(degradeJevState(state, level)));
  const second = levels.map((level) => JSON.stringify(degradeJevState(state, level)));
  assert.deepEqual(first, second, "same input must serialize identically on every run");
  assert.equal(first[0], JSON.stringify(state), "L0 is the untouched state");

  const sizes = first.map((text) => text.length);
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index]! <= sizes[index - 1]!, `L${index} must not grow`);
  }
  for (const level of levels) {
    const degraded = degradeJevState(state, level);
    assert.equal(degraded.evidence.evidenceTruncated, state.evidence.evidenceTruncated || level > 0);
    assert.deepEqual(Object.keys(degraded), ["skill", "finding", "range", "evidence"]);
    assert.deepEqual(Object.keys(degraded.evidence), ["contextBefore", "contextAfter", "diffHunks", "evidenceTruncated"]);
  }
});
