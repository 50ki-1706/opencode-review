import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as v from "valibot";
import {
  decideGate,
  findingSchema,
  gateSkipMessages,
  jevResponseSchema,
  publishableFindingSchema,
  publishableGate,
  reportFindingInputSchema,
  resolvedRangeSchema,
  toPublishableFinding,
  toolReceiptSchema,
  validationResultFromJev,
  validationResultSchema,
  type Finding,
  type ResolvedRange,
} from "../src/finding.ts";

const validInput = {
  path: "src/counter.ts",
  candidateStart: 2,
  candidateEnd: 2,
  anchor: "  return n + 1;",
  severity: "medium",
  title: "Off-by-one in increment",
  body: "increment(0) returns 1, but callers expect 0.",
};

const input = (overrides: Record<string, unknown> = {}) => ({ ...validInput, ...overrides });

test("reportFindingInputSchema accepts a minimal valid finding", () => {
  const parsed = v.safeParse(reportFindingInputSchema, input());
  assert.equal(parsed.success, true);
});

test("reportFindingInputSchema rejects invalid lines and unknown fields", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["empty path", { path: "" }],
    ["missing path", { path: undefined }],
    ["zero start", { candidateStart: 0 }],
    ["negative end", { candidateEnd: -1 }],
    ["fractional start", { candidateStart: 1.5 }],
    ["NaN start", { candidateStart: Number.NaN }],
    ["infinite end", { candidateEnd: Number.POSITIVE_INFINITY }],
    ["start after end", { candidateStart: 5, candidateEnd: 4 }],
    ["unknown severity", { severity: "catastrophic" }],
    ["empty anchor", { anchor: "" }],
    ["empty title", { title: "" }],
    ["empty body", { body: "" }],
    ["unknown field", { id: "finding-1" }],
  ];
  for (const [name, overrides] of cases) {
    assert.equal(v.safeParse(reportFindingInputSchema, input(overrides)).success, false, name);
  }
});

test("reportFindingInputSchema accepts start equal to end and rejects blank-only strings", () => {
  assert.equal(v.safeParse(reportFindingInputSchema, input({ candidateStart: 3, candidateEnd: 3 })).success, true);
  // The Tool template rejects blanks first; the Core repeats the check as
  // defense-in-depth for hand-written or corrupted NDJSON (decisions.md D26).
  for (const field of ["path", "anchor", "title", "body"]) {
    assert.equal(v.safeParse(reportFindingInputSchema, input({ [field]: " \t " })).success, false, field);
  }
});

test("reportFindingInputSchema enforces the documented per-field caps", () => {
  const caps: Array<[string, number]> = [["path", 512], ["anchor", 5000], ["title", 200], ["body", 20000]];
  for (const [field, cap] of caps) {
    assert.equal(v.safeParse(reportFindingInputSchema, input({ [field]: "x".repeat(cap) })).success, true, `${field} at cap`);
    assert.equal(v.safeParse(reportFindingInputSchema, input({ [field]: "x".repeat(cap + 1) })).success, false, `${field} above cap`);
  }
});

test("toolReceiptSchema requires a reason on rejection", () => {
  assert.equal(v.safeParse(toolReceiptSchema, { queued: true }).success, true);
  assert.equal(v.safeParse(toolReceiptSchema, { queued: false, reason: "path is not changed" }).success, true);
  assert.equal(v.safeParse(toolReceiptSchema, { queued: false }).success, false);
  assert.equal(v.safeParse(toolReceiptSchema, { queued: false, reason: "" }).success, false);
  assert.equal(v.safeParse(toolReceiptSchema, { queued: "yes" }).success, false);
});

const validFinding = {
  id: "finding-1",
  skill: "bug-review",
  path: "src/counter.ts",
  candidateRange: { start: 2, end: 2, anchor: "  return n + 1;" },
  severity: "medium",
  title: "Off-by-one in increment",
  body: "increment(0) returns 1, but callers expect 0.",
};

const validResolved = {
  path: "src/counter.ts",
  commitId: "0123456789abcdef0123456789abcdef01234567",
  startLine: 2,
  endLine: 2,
  anchorStartLine: 2,
  side: "RIGHT",
  code: "  return n + 1;",
};

test("findingSchema rejects unknown, missing and invalid fields", () => {
  assert.equal(v.safeParse(findingSchema, validFinding).success, true);
  assert.equal(v.safeParse(findingSchema, { ...validFinding, extra: 1 }).success, false);
  assert.equal(v.safeParse(findingSchema, { ...validFinding, id: "" }).success, false);
  const { candidateRange: _range, ...withoutRange } = validFinding;
  assert.equal(v.safeParse(findingSchema, withoutRange).success, false);
});

test("resolvedRangeSchema pins the RIGHT side and the 40-hex commit id", () => {
  assert.equal(v.safeParse(resolvedRangeSchema, validResolved).success, true);
  assert.equal(v.safeParse(resolvedRangeSchema, { ...validResolved, side: "LEFT" }).success, false);
  assert.equal(v.safeParse(resolvedRangeSchema, { ...validResolved, commitId: "abc" }).success, false);
  assert.equal(v.safeParse(resolvedRangeSchema, { ...validResolved, startLine: 0 }).success, false);
});

test("validationResultSchema keeps probabilities inside 0..1", () => {
  assert.equal(v.safeParse(validationResultSchema, { supported: 0, commentWorthy: 1, rangeQuality: "correct" }).success, true);
  assert.equal(v.safeParse(validationResultSchema, { supported: 1.0001, commentWorthy: 0.5, rangeQuality: "correct" }).success, false);
  assert.equal(v.safeParse(validationResultSchema, { supported: 0.5, commentWorthy: Number.NaN, rangeQuality: "correct" }).success, false);
  assert.equal(v.safeParse(validationResultSchema, { supported: 0.5, commentWorthy: 0.5, rangeQuality: "sideways" }).success, false);
});

test("publishableFindingSchema mirrors the GitHub payload fields", () => {
  const publishable = {
    id: "finding-1",
    skill: "bug-review",
    path: "src/counter.ts",
    commitId: validResolved.commitId,
    startLine: 2,
    endLine: 2,
    side: "RIGHT",
    severity: "high",
    title: "t",
    body: "b",
  };
  assert.equal(v.safeParse(publishableFindingSchema, publishable).success, true);
  assert.equal(v.safeParse(publishableFindingSchema, { ...publishable, side: "LEFT" }).success, false);
  assert.equal(v.safeParse(publishableFindingSchema, { ...publishable, candidateRange: validFinding.candidateRange }).success, false);
});

const finding: Finding = v.parse(findingSchema, validFinding);
const resolved: ResolvedRange = v.parse(resolvedRangeSchema, validResolved);
const validation = (overrides: Partial<{ supported: number; commentWorthy: number; rangeQuality: string }> = {}) =>
  v.parse(validationResultSchema, { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct", ...overrides });

test("publishableGate blocks when deterministic range checks fail", () => {
  const result = publishableGate(
    { finding, resolved, validation: validation(), deterministicRangeChecksPassed: false },
    { supported: 0.7, commentWorthy: 0.6 },
  );
  assert.equal(result, false);
});

test("publishableGate compares thresholds inclusively", () => {
  const atThreshold = v.parse(validationResultSchema, { supported: 0.7, commentWorthy: 0.6, rangeQuality: "correct" });
  assert.equal(
    publishableGate({ finding, resolved, validation: atThreshold, deterministicRangeChecksPassed: true }, { supported: 0.7, commentWorthy: 0.6 }),
    true,
  );
  const below = v.parse(validationResultSchema, { supported: 0.69999, commentWorthy: 0.59999, rangeQuality: "correct" });
  assert.equal(
    publishableGate({ finding, resolved, validation: below, deterministicRangeChecksPassed: true }, { supported: 0.7, commentWorthy: 0.6 }),
    false,
  );
});

test("publishableGate requires rangeQuality correct", () => {
  for (const rangeQuality of ["too_narrow", "too_wide", "wrong_location"] as const) {
    assert.equal(
      publishableGate(
        { finding, resolved, validation: validation({ rangeQuality }), deterministicRangeChecksPassed: true },
        { supported: 0.7, commentWorthy: 0.6 },
      ),
      false,
      rangeQuality,
    );
  }
  assert.equal(
    publishableGate({ finding, resolved, validation: validation({ rangeQuality: "correct" }), deterministicRangeChecksPassed: true }, { supported: 0.7, commentWorthy: 0.6 }),
    true,
  );
});

test("validationResultFromJev maps a parsed Jev response", () => {
  const response = v.parse(
    jevResponseSchema,
    {
      model: "jev-1.13-free",
      answers: {
        supported: { type: "noul", noul: 0.92 },
        commentWorthy: { type: "noul", noul: 0.81 },
        rangeQuality: { type: "choice", choice: "correct", confidence: 0.9 },
      },
    },
  );
  assert.deepEqual(validationResultFromJev(response), { supported: 0.92, commentWorthy: 0.81, rangeQuality: "correct" });
});

// --- Phase 4 gate decisions -------------------------------------------------

const thresholds = { supported: 0.7, commentWorthy: 0.6 };

test("toPublishableFinding projects only the GitHub payload fields", () => {
  assert.deepEqual(toPublishableFinding(finding, resolved), {
    id: "finding-1",
    skill: "bug-review",
    path: "src/counter.ts",
    commitId: resolved.commitId,
    startLine: 2,
    endLine: 2,
    side: "RIGHT",
    severity: "medium",
    title: "Off-by-one in increment",
    body: "increment(0) returns 1, but callers expect 0.",
  });
});

test("decideGate publishes inclusively at the thresholds", () => {
  for (const values of [
    { supported: 0.7, commentWorthy: 0.6, rangeQuality: "correct" },
    { supported: 0.92, commentWorthy: 0.81, rangeQuality: "correct" },
  ] as const) {
    const decision = decideGate({ finding, resolved, validation: validation(values), thresholds, rangeRetryUsed: false });
    assert.equal(decision.kind, "publishable", JSON.stringify(values));
    if (decision.kind === "publishable") {
      assert.deepEqual(decision.publishable.startLine, 2);
    }
  }
});

test("decideGate applies supported, commentWorthy, rangeQuality skip precedence", () => {
  const cases: Array<[
    string,
    { supported: number; commentWorthy: number; rangeQuality: string },
    boolean,
    string | null,
  ]> = [
    ["below both", { supported: 0.69, commentWorthy: 0.5, rangeQuality: "too_wide" }, false, "below_supported"],
    ["below supported only", { supported: 0.69999, commentWorthy: 0.9, rangeQuality: "correct" }, false, "below_supported"],
    ["below commentWorthy only", { supported: 0.9, commentWorthy: 0.59999, rangeQuality: "too_narrow" }, false, "below_comment_worthy"],
    ["wrong location", { supported: 0.9, commentWorthy: 0.9, rangeQuality: "wrong_location" }, false, "range_quality_wrong_location"],
    ["content passes, quality correct", { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct" }, true, null],
  ];
  for (const [name, values, publishable, reason] of cases) {
    const decision = decideGate({ finding, resolved, validation: validation(values), thresholds, rangeRetryUsed: false });
    assert.equal(decision.kind, publishable ? "publishable" : "skip", name);
    if (!publishable && decision.kind === "skip") {
      assert.equal(decision.reason, reason, name);
      assert.equal(decision.message, gateSkipMessages[decision.reason]);
    }
  }
});

test("decideGate asks for one range retry and never asks again", () => {
  for (const quality of ["too_narrow", "too_wide"] as const) {
    const first = decideGate({
      finding,
      resolved,
      validation: validation({ supported: 0.9, commentWorthy: 0.9, rangeQuality: quality }),
      thresholds,
      rangeRetryUsed: false,
    });
    assert.deepEqual(first, { kind: "retry_range", quality });

    const second = decideGate({
      finding,
      resolved,
      validation: validation({ supported: 0.9, commentWorthy: 0.9, rangeQuality: quality }),
      thresholds,
      rangeRetryUsed: true,
    });
    assert.equal(second.kind, "skip");
    if (second.kind === "skip") {
      assert.equal(second.reason, "range_retry_exhausted");
    }
  }
});

test("decideGate agrees with the response threshold fixtures", () => {
  const rows: Array<[string, boolean]> = [
    ["response-valid.json", true],
    ["response-threshold-at.json", true],
    ["response-threshold-below.json", false],
    ["response-threshold-above.json", true],
  ];
  for (const [name, expected] of rows) {
    const parsed = v.parse(jevResponseSchema, JSON.parse(readFileSync(new URL(`./jev/fixtures/${name}`, import.meta.url), "utf8")));
    const decision = decideGate({ finding, resolved, validation: validationResultFromJev(parsed), thresholds, rangeRetryUsed: false });
    assert.equal(decision.kind === "publishable", expected, name);
  }
});
