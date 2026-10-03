// Canonical Valibot schemas, types and the publish gate.
//
// The Valibot schemas are the authoritative definitions; TypeScript types are
// inferred from them (docs/architecture.md "型と値の所有者"). This module must
// stay free of OpenCode, GitHub and Jev transport dependencies.
import * as v from "valibot";

// --- Shared primitives -----------------------------------------------------

export const severitySchema = v.picklist(["critical", "high", "medium", "low"]);
export type Severity = v.InferOutput<typeof severitySchema>;

export const rangeQualitySchema = v.picklist(["correct", "too_narrow", "too_wide", "wrong_location"]);
export type RangeQuality = v.InferOutput<typeof rangeQualitySchema>;

const lineNumberSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1));
const probabilitySchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const commitIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));

// --- report_finding input (NDJSON record) ----------------------------------

// Core-side record limits. They are defense-in-depth: the Tool template rejects
// blank strings, changed-path mismatches and >32 KiB records first, but a
// corrupted or hand-written NDJSON file must not become a formal Finding either
// (docs/architecture.md "Tool schema" vs "Core / Valibot" rows). Every record
// that passes these caps is smaller than the 32 KiB Tool limit by construction.
const boundedNonBlankStringSchema = (maxLength: number) =>
  v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank"),
    v.maxLength(maxLength),
  );

export const reportFindingInputSchema = v.pipe(
  v.strictObject({
    path: boundedNonBlankStringSchema(512),
    candidateStart: lineNumberSchema,
    candidateEnd: lineNumberSchema,
    anchor: boundedNonBlankStringSchema(5000),
    severity: severitySchema,
    title: boundedNonBlankStringSchema(200),
    body: boundedNonBlankStringSchema(20000),
  }),
  v.check((input) => input.candidateStart <= input.candidateEnd, "candidateStart must be <= candidateEnd"),
);
export type ReportFindingInput = v.InferOutput<typeof reportFindingInputSchema>;

export const toolReceiptSchema = v.variant("queued", [
  v.strictObject({ queued: v.literal(true) }),
  v.strictObject({ queued: v.literal(false), reason: nonEmptyStringSchema }),
]);
export type ToolReceipt = v.InferOutput<typeof toolReceiptSchema>;

// --- Canonical core types --------------------------------------------------

export const candidateRangeSchema = v.strictObject({
  start: lineNumberSchema,
  end: lineNumberSchema,
  anchor: nonEmptyStringSchema,
});

export const findingSchema = v.strictObject({
  id: nonEmptyStringSchema,
  skill: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  candidateRange: candidateRangeSchema,
  severity: severitySchema,
  title: nonEmptyStringSchema,
  body: nonEmptyStringSchema,
});
export type Finding = v.InferOutput<typeof findingSchema>;

export const resolvedRangeSchema = v.strictObject({
  path: nonEmptyStringSchema,
  commitId: commitIdSchema,
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  /** Anchor window start inside the resolved range (Q07 corrections need it). */
  anchorStartLine: lineNumberSchema,
  side: v.literal("RIGHT"),
  code: v.string(),
});
export type ResolvedRange = v.InferOutput<typeof resolvedRangeSchema>;

export const validationResultSchema = v.strictObject({
  supported: probabilitySchema,
  commentWorthy: probabilitySchema,
  rangeQuality: rangeQualitySchema,
});
export type ValidationResult = v.InferOutput<typeof validationResultSchema>;

export const publishableFindingSchema = v.strictObject({
  id: nonEmptyStringSchema,
  skill: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  commitId: commitIdSchema,
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  side: v.literal("RIGHT"),
  severity: severitySchema,
  title: nonEmptyStringSchema,
  body: nonEmptyStringSchema,
});
export type PublishableFinding = v.InferOutput<typeof publishableFindingSchema>;

export type ReviewThresholds = {
  supported: number;
  commentWorthy: number;
};

export type ReviewContext = {
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  skill: string;
  model: string;
  thresholds: ReviewThresholds;
  limits: {
    timeoutSeconds: number;
    maxFindings: number;
  };
};

export type PublishGateInput = {
  finding: Finding;
  resolved: ResolvedRange;
  validation: ValidationResult;
  deterministicRangeChecksPassed: boolean;
};

// publishable = deterministicRangeChecksPassed
//   AND supported >= supportedThreshold
//   AND commentWorthy >= commentWorthyThreshold
//   AND rangeQuality == correct
export function publishableGate(input: PublishGateInput, thresholds: ReviewThresholds): boolean {
  return (
    input.deterministicRangeChecksPassed &&
    input.validation.supported >= thresholds.supported &&
    input.validation.commentWorthy >= thresholds.commentWorthy &&
    input.validation.rangeQuality === "correct"
  );
}

/** Result-file projection of finding + resolved range; no extra fields. */
export function toPublishableFinding(finding: Finding, resolved: ResolvedRange): PublishableFinding {
  return {
    id: finding.id,
    skill: finding.skill,
    path: resolved.path,
    commitId: resolved.commitId,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    side: resolved.side,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
  };
}

// --- Gate decision (Phase 4) -----------------------------------------------

/**
 * Reasons a validated finding is not published. `range_retry_exhausted`
 * overlaps with range.ts: there it means the deterministic correction was
 * impossible or a no-op; here it also covers a correction that Jev still did
 * not rate as `correct`.
 */
export const gateSkipReasons = [
  "evidence_overflow",
  "below_supported",
  "below_comment_worthy",
  "range_quality_wrong_location",
  "range_retry_exhausted",
] as const;
export type GateSkipReason = (typeof gateSkipReasons)[number];

/** Japanese messages recorded in the result file for gate skips. */
export const gateSkipMessages: Record<GateSkipReason, string> = {
  evidence_overflow: "stateが上限（24000 UTF-16 code units）を超えるためJev検証を省略しました。",
  below_supported: "Jevのsupportedがしきい値未満のため投稿しません。",
  below_comment_worthy: "JevのcommentWorthyがしきい値未満のため投稿しません。",
  range_quality_wrong_location: "Jevが範囲をwrong_locationと判定したため投稿しません。",
  range_retry_exhausted: "範囲の再解決・再評価を行いましたが合格しなかったため投稿しません。",
};

export type GateDecision =
  | { kind: "publishable"; publishable: PublishableFinding }
  | { kind: "skip"; reason: GateSkipReason; message: string }
  | { kind: "retry_range"; quality: "too_narrow" | "too_wide" };

/**
 * Pure gate decision. skip precedence is supported, commentWorthy, then
 * rangeQuality: a finding that fails a content threshold is not worth a range
 * retry. `rangeRetryUsed` must be true after the one allowed correction so a
 * failing range cannot loop.
 */
export function decideGate(input: {
  finding: Finding;
  resolved: ResolvedRange;
  validation: ValidationResult;
  thresholds: ReviewThresholds;
  rangeRetryUsed: boolean;
}): GateDecision {
  const { finding, resolved, validation, thresholds, rangeRetryUsed } = input;
  if (publishableGate({ finding, resolved, validation, deterministicRangeChecksPassed: true }, thresholds)) {
    return { kind: "publishable", publishable: toPublishableFinding(finding, resolved) };
  }
  const skip = (reason: GateSkipReason): GateDecision => ({
    kind: "skip",
    reason,
    message: gateSkipMessages[reason],
  });
  if (validation.supported < thresholds.supported) {
    return skip("below_supported");
  }
  if (validation.commentWorthy < thresholds.commentWorthy) {
    return skip("below_comment_worthy");
  }
  if (validation.rangeQuality === "wrong_location") {
    return skip("range_quality_wrong_location");
  }
  if (validation.rangeQuality !== "too_narrow" && validation.rangeQuality !== "too_wide") {
    // Unreachable while the gate above is the only pass condition; keeps the
    // decision total instead of guessing a retryable quality.
    return skip("range_retry_exhausted");
  }
  if (rangeRetryUsed) {
    return skip("range_retry_exhausted");
  }
  return { kind: "retry_range", quality: validation.rangeQuality };
}

// --- Jev (TypeSafe System One via OpenCode Zen) ----------------------------

// Request models this Action may ask for (decisions.md D20). The response
// `model` is an echo and is recorded, not gated: any non-empty string passes.
export const jevRequestModelSchema = v.picklist(["jev-1.13-free", "jev-1.13"]);
export type JevRequestModel = v.InferOutput<typeof jevRequestModelSchema>;

const noulAnswerSchema = v.strictObject({
  type: v.literal("noul"),
  noul: probabilitySchema,
});

// Choice answer is lenient about additional fields, matching the Phase 0
// hand-rolled contract (test/jev/contract.test.mjs). Score fields are not
// expected anywhere.
const choiceAnswerSchema = v.object({
  type: v.literal("choice"),
  choice: rangeQualitySchema,
  probabilities: v.optional(
    v.strictObject({
      correct: probabilitySchema,
      too_narrow: probabilitySchema,
      too_wide: probabilitySchema,
      wrong_location: probabilitySchema,
    }),
  ),
  confidence: v.optional(probabilitySchema),
});

// `cost` is an undocumented Zen field (string / number) kept for compatibility.
// Listing it here is equivalent to parse-stripping it before a strict parse:
// every other unknown top-level field is rejected.
export const jevResponseSchema = v.strictObject({
  model: nonEmptyStringSchema,
  answers: v.strictObject({
    supported: noulAnswerSchema,
    commentWorthy: noulAnswerSchema,
    rangeQuality: choiceAnswerSchema,
  }),
  usage: v.optional(
    v.object({
      input_tokens: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0)),
      output_tokens: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0)),
    }),
  ),
  cost: v.optional(v.union([v.string(), v.number()])),
});
export type JevResponse = v.InferOutput<typeof jevResponseSchema>;

export function validationResultFromJev(response: JevResponse): ValidationResult {
  return {
    supported: response.answers.supported.noul,
    commentWorthy: response.answers.commentWorthy.noul,
    rangeQuality: response.answers.rangeQuality.choice,
  };
}

export type JevSkillCriteria = {
  name: string;
  criteria: string;
};

/**
 * Skill-criteria excerpt cap in UTF-16 code units. The full SKILL.md body is
 * bounded before the state is built so one huge skill cannot push every finding
 * to `evidence_overflow`; the marker keeps the truncation visible in the state.
 */
export const MAX_SKILL_CRITERIA_CODE_UNITS = 8000;

export function skillCriteriaExcerpt(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_SKILL_CRITERIA_CODE_UNITS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SKILL_CRITERIA_CODE_UNITS)}\n[skill criteria truncated]`;
}

// Shape produced by the Range Resolver in Phase 3. Values are already-shaped
// evidence parts: buildJevState only orders, degrades and measures them.
export type JevEvidence = {
  contextBefore: string[];
  contextAfter: string[];
  diffHunks: string[];
  evidenceTruncated: boolean;
};

export type JevState = {
  skill: { name: string; criteria: string };
  finding: { path: string; severity: Severity; title: string; body: string };
  range: {
    commitId: string;
    path: string;
    startLine: number;
    endLine: number;
    side: "RIGHT";
    code: string[];
  };
  evidence: JevEvidence;
};

export type JevQuestions = {
  supported: { type: "noul"; instructions: string; criteria: { true: string; false: string } };
  commentWorthy: { type: "noul"; instructions: string; criteria: { true: string; false: string } };
  rangeQuality: {
    type: "choice";
    instructions: string;
    criteria: { correct: null; too_narrow: string; too_wide: string; wrong_location: string };
  };
};

// Program-fixed question text (Phase 4). It matches the captured contract in
// test/jev/fixtures/request-expected.json and is never edited by finding data;
// the AI body is only a value inside `state`, not instructions.
export const jevQuestions: JevQuestions = {
  supported: {
    type: "noul",
    instructions: "Does the presented HEAD code and evidence in `range` and `evidence` support the claim in `finding`?",
    criteria: {
      true: "The quoted code shows the claimed behavior without further inference.",
      false: "The quoted code contradicts the claim, or the claim needs code that is not presented.",
    },
  },
  commentWorthy: {
    type: "noul",
    instructions: "According to `skill.criteria`, does `finding` describe a concrete harm that warrants an inline review comment?",
    criteria: {
      true: "A concrete defect or harm with a real trigger and impact.",
      false: "A style preference, speculation, or harmlessness.",
    },
  },
  rangeQuality: {
    type: "choice",
    instructions: "Does `range` contain exactly the code lines needed to support `finding`?",
    criteria: {
      correct: null,
      too_narrow: "The range omits lines the finding depends on.",
      too_wide: "The range includes unrelated lines beyond what the finding needs.",
      wrong_location: "The range points at code unrelated to the finding.",
    },
  },
};

export type JevRequest = {
  model: JevRequestModel;
  state: JevState;
  questions: JevQuestions;
};

export type JevRequestInput = {
  model: JevRequestModel;
  finding: Finding;
  resolved: ResolvedRange;
  skillCriteria: JevSkillCriteria;
  evidence: JevEvidence;
};

function codeLines(code: string): string[] {
  if (code.length === 0) {
    return [];
  }
  const lines = code.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// Key insertion order is part of the contract: skill -> finding -> range ->
// evidence. The finding is projected because id/skill/candidateRange are Core
// bookkeeping; the resolved range replaces the candidate range.
export function buildJevState(input: Omit<JevRequestInput, "model">): JevState {
  return {
    skill: { name: input.skillCriteria.name, criteria: input.skillCriteria.criteria },
    finding: {
      path: input.finding.path,
      severity: input.finding.severity,
      title: input.finding.title,
      body: input.finding.body,
    },
    range: {
      commitId: input.resolved.commitId,
      path: input.resolved.path,
      startLine: input.resolved.startLine,
      endLine: input.resolved.endLine,
      side: input.resolved.side,
      code: codeLines(input.resolved.code),
    },
    evidence: input.evidence,
  };
}

export function jevRequestBody(input: JevRequestInput): JevRequest {
  return {
    model: input.model,
    state: buildJevState(input),
    questions: jevQuestions,
  };
}

// --- State size ladder (provisional until Phase 4 calibration) -------------

export const JEV_STATE_LIMIT_CODE_UNITS = 24000;

export function jevStateSize(state: JevState): number {
  return JSON.stringify(state).length;
}

// L0 keeps everything. L1-L4 are provisional deterministic truncations of the
// evidence parts; the concrete ladder is calibrated in Phase 4
// (docs/architecture.md, docs/decisions.md "state上限 ... 劣化はしごL0-L4").
const evidenceLadder = [
  { contextBefore: Number.POSITIVE_INFINITY, contextAfter: Number.POSITIVE_INFINITY, diffHunks: Number.POSITIVE_INFINITY },
  { contextBefore: 5, contextAfter: 5, diffHunks: Number.POSITIVE_INFINITY },
  { contextBefore: 3, contextAfter: 3, diffHunks: 24 },
  { contextBefore: 0, contextAfter: 0, diffHunks: 12 },
  { contextBefore: 0, contextAfter: 0, diffHunks: 0 },
];

export type JevStateLevel = 0 | 1 | 2 | 3 | 4;

export function degradeJevState(state: JevState, level: JevStateLevel): JevState {
  const limits = evidenceLadder[level]!;
  const contextBefore = limits.contextBefore === Number.POSITIVE_INFINITY
    ? state.evidence.contextBefore
    : state.evidence.contextBefore.slice(-limits.contextBefore);
  const contextAfter = limits.contextAfter === Number.POSITIVE_INFINITY
    ? state.evidence.contextAfter
    : state.evidence.contextAfter.slice(0, limits.contextAfter);
  const diffHunks = limits.diffHunks === Number.POSITIVE_INFINITY
    ? state.evidence.diffHunks
    : state.evidence.diffHunks.slice(0, limits.diffHunks);
  return {
    ...state,
    evidence: {
      contextBefore,
      contextAfter,
      diffHunks,
      evidenceTruncated: state.evidence.evidenceTruncated || level > 0,
    },
  };
}

export type JevStateFit =
  | { kind: "fits"; state: JevState; level: JevStateLevel }
  | { kind: "evidence_overflow" };

export function fitJevState(state: JevState): JevStateFit {
  const levels: JevStateLevel[] = [0, 1, 2, 3, 4];
  for (const level of levels) {
    const candidate = degradeJevState(state, level);
    if (jevStateSize(candidate) <= JEV_STATE_LIMIT_CODE_UNITS) {
      return { kind: "fits", state: candidate, level };
    }
  }
  return { kind: "evidence_overflow" };
}
