// Action entrypoint: the complete review pipeline — input validation, event
// validation, ReviewContext (GitHub metadata + local git), the staged OpenCode
// producer, canonical Finding validation, range resolution, the Jev publish
// gate, and the publisher or dry-run. Result artifacts and Action outputs are
// written on every terminal path; nothing is published from a partial pipeline
// (docs/architecture.md failure table).
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import {
  decideGate,
  gateSkipMessages,
  type Finding,
  type GateSkipReason,
  type JevRequestModel,
  type JevSkillCriteria,
  type PublishableFinding,
  type ResolvedRange,
  type ReviewContext,
  type ReviewThresholds,
  type ValidationResult,
} from "./finding.ts";
import { GitHubError, HeadChangedError, buildInlinePayload, postInlineComment, verifyHeadCurrent, type InlineCommentPayload, type PostedComment } from "./github.ts";
import { createJevClient, JevRunError, type JevClient } from "./jev.ts";
import {
  prepareReviewContext,
  runFindingProducer,
  ReviewRunError,
  type PreparedReview,
  type ProducerOutcome,
  type ReviewFailureKind,
} from "./opencode.ts";
import {
  buildDiffModel,
  buildJevEvidence,
  RangeRunError,
  readHeadBlob,
  reResolveForCorrection,
  resolveFindings,
  type DiffModel,
  type FindingResolution,
  type RangeSkipReason,
} from "./range.ts";

export { reportFindingTemplate } from "./templates.ts";

// Kept in sync with package.json; the result file records which bundle ran.
export const RUN_VERSION = "0.0.0";

type Env = Record<string, string | undefined>;

// --- Action inputs ---------------------------------------------------------

// `github-token` is declared `required: false` in action.yml because dry-run is
// allowed, but metadata reads still need it; the validator treats it as required.
const skillNameSchema = v.pipe(
  v.string(),
  v.check(
    (value) => value.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+){0,63}$/.test(value),
    "must match ^[a-z0-9]+(-[a-z0-9]+){0,63}$ within 64 characters",
  ),
);

const modelSchema = v.pipe(
  v.string(),
  v.check((value) => /^[^\/\s]+\/[^\/\s#]+(#[^\s]+)?$/.test(value), "must be provider/model with an optional #variant"),
);

const githubTokenSchema = v.pipe(v.string(), v.minLength(1));

function optionalTrimmed(defaultValue: string) {
  return v.optional(v.pipe(v.string(), v.trim()), defaultValue);
}

// Trim is allowed, but only the exact lowercase words "true" / "false" parse;
// "True" and "1" are rejected instead of guessed.
function booleanInput(defaultValue: string) {
  return v.pipe(
    optionalTrimmed(defaultValue),
    v.check((raw) => raw === "true" || raw === "false", 'must be exactly "true" or "false"'),
    v.transform((raw) => raw === "true"),
  );
}

function numberInput(defaultValue: string, min: number, max: number, integer: boolean) {
  return v.pipe(
    optionalTrimmed(defaultValue),
    v.check((raw) => raw.length > 0 && Number.isFinite(Number(raw)), "must be a finite number"),
    v.transform((raw) => Number(raw)),
    v.check(
      (value) => (!integer || Number.isInteger(value)) && value >= min && value <= max,
      `must be ${integer ? "an integer" : "a number"} in ${min}..${max}`,
    ),
  );
}

const actionInputsSchema = v.object({
  skill: skillNameSchema,
  model: modelSchema,
  dryRun: booleanInput("false"),
  githubToken: githubTokenSchema,
  jevModel: v.optional(v.picklist(["jev-1.13-free", "jev-1.13"]), "jev-1.13-free"),
  supportedThreshold: numberInput("0.7", 0, 1, false),
  commentWorthyThreshold: numberInput("0.6", 0, 1, false),
  timeoutSeconds: numberInput("600", 1, 3600, true),
  maxFindings: numberInput("100", 1, 1000, true),
});
export type ActionInputs = v.InferOutput<typeof actionInputsSchema>;

// GitHub passes input names uppercased; spaces become underscores but hyphens
// stay as written (INPUT_DRY-RUN, INPUT_GITHUB-TOKEN, ...).
const actionInputEnvNames = {
  skill: "INPUT_SKILL",
  model: "INPUT_MODEL",
  dryRun: "INPUT_DRY-RUN",
  githubToken: "INPUT_GITHUB-TOKEN",
  jevModel: "INPUT_JEV-MODEL",
  supportedThreshold: "INPUT_SUPPORTED-THRESHOLD",
  commentWorthyThreshold: "INPUT_COMMENT-WORTHY-THRESHOLD",
  timeoutSeconds: "INPUT_TIMEOUT-SECONDS",
  maxFindings: "INPUT_MAX-FINDINGS",
} as const;

export class ActionInputError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid Action inputs: ${fields.join(", ")}`);
    this.name = "ActionInputError";
    this.fields = fields;
  }
}

export function readActionInputs(env: Env): ActionInputs {
  const parsed = v.safeParse(actionInputsSchema, {
    skill: env["INPUT_SKILL"],
    model: env["INPUT_MODEL"],
    dryRun: env["INPUT_DRY-RUN"],
    githubToken: env["INPUT_GITHUB-TOKEN"],
    jevModel: env["INPUT_JEV-MODEL"],
    supportedThreshold: env["INPUT_SUPPORTED-THRESHOLD"],
    commentWorthyThreshold: env["INPUT_COMMENT-WORTHY-THRESHOLD"],
    timeoutSeconds: env["INPUT_TIMEOUT-SECONDS"],
    maxFindings: env["INPUT_MAX-FINDINGS"],
  });
  if (!parsed.success) {
    // Only input names are reported; values (including the token) never are.
    const names = parsed.issues.map((issue) => {
      const key = issue.path?.[0]?.key;
      return typeof key === "string" ? actionInputEnvNames[key as keyof typeof actionInputEnvNames] : "INPUT_?";
    });
    throw new ActionInputError([...new Set(names)]);
  }
  return parsed.output;
}

// --- Runner environment ----------------------------------------------------

const requiredEnvironmentNames = ["GITHUB_EVENT_PATH", "RUNNER_TEMP", "GITHUB_OUTPUT", "GITHUB_REPOSITORY"] as const;

export type RunnerEnvironment = {
  eventPath: string;
  runnerTemp: string;
  outputPath: string;
  repository: string;
  /** Checkout root; GitHub-hosted runners always set GITHUB_WORKSPACE. */
  workspace: string;
};

export class EnvironmentError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Missing required environment variables: ${fields.join(", ")}`);
    this.name = "EnvironmentError";
    this.fields = fields;
  }
}

export function readRunnerEnvironment(env: Env): RunnerEnvironment {
  const missing = requiredEnvironmentNames.filter((name) => (env[name] ?? "").trim().length === 0);
  if (missing.length > 0) {
    throw new EnvironmentError([...missing]);
  }
  return {
    eventPath: env["GITHUB_EVENT_PATH"]!,
    runnerTemp: env["RUNNER_TEMP"]!,
    outputPath: env["GITHUB_OUTPUT"]!,
    repository: env["GITHUB_REPOSITORY"]!,
    workspace: env["GITHUB_WORKSPACE"] ?? process.cwd(),
  };
}

/**
 * D24 (variable name per D28): the authenticated Jev path is mandatory. The
 * anonymous free probe is a calibration fact, never a production fallback, so a
 * missing OPENCODE_API_KEY (the shared OpenCode credential) fails the run
 * before any producer work or network call.
 */
export function readJevToken(env: Env): string {
  const token = (env["OPENCODE_API_KEY"] ?? "").trim();
  if (token.length === 0) {
    throw new EnvironmentError(["OPENCODE_API_KEY"]);
  }
  return token;
}

// --- pull_request event ----------------------------------------------------

const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const fullNameSchema = v.pipe(v.string(), v.minLength(1));

export const pullRequestEventSchema = v.object({
  action: v.picklist(["opened", "synchronize", "reopened", "ready_for_review"]),
  number: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
  pull_request: v.object({
    draft: v.optional(v.boolean(), false),
    head: v.object({
      sha: shaSchema,
      repo: v.object({ full_name: fullNameSchema }),
    }),
    base: v.object({ sha: shaSchema }),
  }),
  repository: v.object({
    full_name: fullNameSchema,
    private: v.optional(v.boolean()),
  }),
});
export type PullRequestEvent = v.InferOutput<typeof pullRequestEventSchema>;

export class EventError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid GitHub event payload: ${fields.join(", ")}`);
    this.name = "EventError";
    this.fields = fields;
  }
}

export function parsePullRequestEvent(json: unknown): PullRequestEvent {
  const parsed = v.safeParse(pullRequestEventSchema, json);
  if (!parsed.success) {
    const fields = parsed.issues.map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join(".");
      return path && path.length > 0 ? path : "event";
    });
    throw new EventError([...new Set(fields)]);
  }
  return parsed.output;
}

async function readEventFile(eventPath: string): Promise<PullRequestEvent> {
  let text: string;
  try {
    text = await readFile(eventPath, "utf8");
  } catch {
    throw new EventError(["GITHUB_EVENT_PATH"]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EventError(["JSON"]);
  }
  return parsePullRequestEvent(json);
}

export function isSameRepository(event: PullRequestEvent): boolean {
  return event.pull_request.head.repo.full_name === event.repository.full_name;
}

export function buildReviewContext(inputs: ActionInputs, event: PullRequestEvent): ReviewContext {
  return {
    repository: event.repository.full_name,
    pullNumber: event.number,
    baseSha: event.pull_request.base.sha.toLowerCase(),
    headSha: event.pull_request.head.sha.toLowerCase(),
    skill: inputs.skill,
    model: inputs.model,
    thresholds: {
      supported: inputs.supportedThreshold,
      commentWorthy: inputs.commentWorthyThreshold,
    },
    limits: {
      timeoutSeconds: inputs.timeoutSeconds,
      maxFindings: inputs.maxFindings,
    },
  };
}

// --- Run -------------------------------------------------------------------

export type RunErrorStage =
  | "input"
  | "environment"
  | "event"
  | "repository"
  | "context"
  | "config"
  | "producer"
  | "results"
  | "jev"
  | "publisher"
  | "pipeline";

export type RunError = {
  class: "run_error";
  stage: RunErrorStage;
  message: string;
  fields: string[];
};

export type RunResult =
  | { code: 0; context: ReviewContext }
  | { code: 1; error: RunError };

export type RunCounts = {
  accepted: number;
  publishable: number;
  published: number;
  skipped: number;
  /**
   * Findings collapsed into an earlier exact duplicate inside this invocation
   * (D17). Included in `skipped`; kept separately as the result-file note.
   */
  deduped: number;
};

export type ProduceStageOptions = {
  runnerTemp: string;
  model: string;
  timeoutMs: number;
  maxFindings: number;
  parentEnv: Env;
  protectedValues: readonly string[];
  signal?: AbortSignal;
};

export type ResolveStageOptions = {
  context: ReviewContext;
  prepared: PreparedReview;
  token: string;
  findings: readonly Finding[];
  signal?: AbortSignal;
};

/** Reason recorded for a finding rejected after range resolution. */
export type ValidationSkipReason = GateSkipReason | RangeSkipReason;

export type FindingGateOutcome = {
  finding: Finding;
  range: ResolvedRange;
  stage: "publishable" | "skipped";
  /** Last Jev values; null when no Jev call happened (overflow / blob skip). */
  validation: ValidationResult | null;
  /** Jev evaluations performed: 0, 1 or 2 (one range correction at most). */
  jevCalls: number;
  /** True when the one allowed range re-resolution was attempted. */
  rangeRetryUsed: boolean;
  reason: { code: ValidationSkipReason; message: string } | null;
  publishable: PublishableFinding | null;
};

export type ValidateStageOptions = {
  context: ReviewContext;
  prepared: PreparedReview;
  resolutions: readonly FindingResolution[];
  skillCriteria: JevSkillCriteria;
  jevModel: JevRequestModel;
  jevToken: string;
  signal?: AbortSignal;
};

// --- Publisher (phase 5) ---------------------------------------------------

/**
 * One planned inline comment. `stage` is "planned" until the publish loop runs;
 * dry-run keeps "planned" for every entry, while publication marks each entry
 * "posted" or (on failure) "unposted".
 */
export type PublishEntry = {
  findingId: string;
  path: string;
  startLine: number;
  endLine: number;
  severity: Finding["severity"];
  title: string;
  payload: InlineCommentPayload;
  stage: "planned" | "posted" | "unposted";
  commentId: number | null;
  url: string | null;
  /** True when an unposted POST outcome is unknown (network failure, D18). */
  ambiguous: boolean;
};

export type PublishFailure = {
  class: "mid-run failure";
  /** "head_recheck" | "post" */
  step: "head_recheck" | "post";
  findingId: string;
  message: string;
  fields: string[];
  ambiguous: boolean;
};

export type PublishOutcome = {
  entries: PublishEntry[];
  posted: number;
  failure: PublishFailure | null;
};

export type PublishStageOptions = {
  context: ReviewContext;
  /** Gate-passed, deduplicated findings in evaluation order. */
  publishables: readonly PublishableFinding[];
  token: string;
  dryRun: boolean;
  signal?: AbortSignal;
};

export type PublishTransport = {
  verifyHead: () => Promise<void>;
  postComment: (payload: InlineCommentPayload) => Promise<PostedComment>;
};

export type PublishableDedup = {
  unique: PublishableFinding[];
  duplicates: Array<{ finding: PublishableFinding; duplicateOf: string }>;
};

/**
 * D17: collapse exact duplicates inside one invocation. Two publishables match
 * when path, resolved range, side, severity, title and body are all identical;
 * the first occurrence is kept and evaluation order is preserved. No cross-run
 * or cross-step dedup state exists.
 */
export function dedupePublishables(publishables: readonly PublishableFinding[]): PublishableDedup {
  const firstByKey = new Map<string, string>();
  const unique: PublishableFinding[] = [];
  const duplicates: Array<{ finding: PublishableFinding; duplicateOf: string }> = [];
  for (const finding of publishables) {
    const key = [
      finding.commitId.toLowerCase(),
      finding.path,
      finding.startLine,
      finding.endLine,
      finding.side,
      finding.severity,
      finding.title,
      finding.body,
    ].join("\u0000");
    const first = firstByKey.get(key);
    if (first !== undefined) {
      duplicates.push({ finding, duplicateOf: first });
      continue;
    }
    firstByKey.set(key, finding.id);
    unique.push(finding);
  }
  return { unique, duplicates };
}

function planPublishEntries(publishables: readonly PublishableFinding[]): PublishEntry[] {
  return publishables.map((finding) => ({
    findingId: finding.id,
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    severity: finding.severity,
    title: finding.title,
    payload: buildInlinePayload(finding),
    stage: "planned" as const,
    commentId: null,
    url: null,
    ambiguous: false,
  }));
}

function publishFailureDetail(error: unknown): { message: string; fields: string[]; ambiguous: boolean } {
  if (error instanceof HeadChangedError) {
    return { message: "PR head changed before posting the next comment", fields: ["head.sha"], ambiguous: false };
  }
  if (error instanceof GitHubError) {
    return { message: error.message, fields: error.fields, ambiguous: error.status === 0 };
  }
  return { message: "unexpected publisher failure", fields: [], ambiguous: false };
}

/**
 * Sequential publisher loop. Every post is preceded by a fresh HEAD check; any
 * failure (HEAD moved, 403/422, 5xx, network/ambiguous timeout, unexpected
 * status) stops the remaining posts and records what was and was not posted.
 * Nothing is ever resent after an ambiguous outcome (D18).
 */
export async function publishFindings(
  options: PublishStageOptions,
  transport: PublishTransport,
): Promise<PublishOutcome> {
  const entries = planPublishEntries(options.publishables);
  if (options.dryRun) {
    return { entries, posted: 0, failure: null };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const fail = (step: "head_recheck" | "post", error: unknown): PublishOutcome => {
      for (let pending = index; pending < entries.length; pending += 1) {
        entries[pending]!.stage = "unposted";
      }
      const detail = publishFailureDetail(error);
      entries[index]!.ambiguous = detail.ambiguous;
      return {
        entries,
        posted: index,
        failure: {
          class: "mid-run failure",
          step,
          findingId: entry.findingId,
          message: detail.message,
          fields: detail.fields,
          ambiguous: detail.ambiguous,
        },
      };
    };
    try {
      await transport.verifyHead();
    } catch (error) {
      return fail("head_recheck", error);
    }
    try {
      const posted = await transport.postComment(entry.payload);
      entry.stage = "posted";
      entry.commentId = posted.id;
      entry.url = posted.url;
    } catch (error) {
      return fail("post", error);
    }
  }
  return { entries, posted: entries.length, failure: null };
}

/**
 * Dry-run stdout contract: the same payloads the publisher would POST, plus the
 * per-finding skip reasons, as one JSON object. No secret values are included.
 */
export function formatDryRunPlan(entries: readonly PublishEntry[], skipped: ReadonlyArray<{ id: string; stage: string; reason: { code: string; message: string } | null }>): string {
  return JSON.stringify({
    stage: "dry-run",
    publishables: entries.map((entry) => ({ findingId: entry.findingId, payload: entry.payload })),
    skipped: skipped.map((finding) => ({ id: finding.id, stage: finding.stage, reason: finding.reason })),
  });
}

/**
 * The four swappable pipeline stages plus publication. Tests replace them with
 * deterministic fakes; the Action bundle uses the OpenCode producer, the
 * git-backed range resolver, the Zen Jev client and the GitHub publisher.
 */
export type PipelineDependencies = {
  prepareReview: (
    context: ReviewContext,
    token: string,
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<PreparedReview>;
  produceFindings: (prepared: PreparedReview, options: ProduceStageOptions) => Promise<ProducerOutcome>;
  resolveRanges: (options: ResolveStageOptions) => Promise<FindingResolution[]>;
  validateFindings: (options: ValidateStageOptions) => Promise<FindingGateOutcome[]>;
  publishFindings: (options: PublishStageOptions) => Promise<PublishOutcome>;
};

export type DefaultDependenciesOptions = {
  /** Test seam: replaces the Zen transport; production leaves it unset. */
  jevClient?: JevClient;
  /** @internal Test seam: GitHub API base URL for a local mock server. */
  githubBaseUrl?: string;
  /** @internal Test seam: GitHub fetch implementation for a local mock server. */
  githubFetchImpl?: typeof fetch;
};

export function defaultPipelineDependencies(options: DefaultDependenciesOptions = {}): PipelineDependencies {
  const githubOptions = { baseUrl: options.githubBaseUrl, fetchImpl: options.githubFetchImpl };
  return {
    prepareReview: (context, token, workspace, signal) =>
      prepareReviewContext(
        { context, token, workspace, signal },
        { baseUrl: options.githubBaseUrl, fetchImpl: options.githubFetchImpl },
      ),
    produceFindings: (prepared, options) =>
      runFindingProducer({
        runnerTemp: options.runnerTemp,
        prepared,
        model: options.model,
        timeoutMs: options.timeoutMs,
        maxFindings: options.maxFindings,
        parentEnv: options.parentEnv,
        protectedValues: options.protectedValues,
        signal: options.signal,
      }),
    resolveRanges: (options) =>
      resolveFindings(
        {
          workspace: options.prepared.workspace,
          mergeBase: options.prepared.mergeBase,
          headSha: options.context.headSha,
          changedPaths: options.prepared.changedPaths,
          findings: options.findings,
        },
        {
          verifyHead: async () => {
            try {
              await verifyHeadCurrent(
                options.token,
                options.context.repository,
                options.context.pullNumber,
                options.context.headSha,
                { signal: options.signal, ...githubOptions },
              );
            } catch (error) {
              if (error instanceof HeadChangedError) {
                throw new RangeRunError("head_changed", "PR head changed before range resolution", ["head.sha"]);
              }
              if (error instanceof GitHubError) {
                throw new RangeRunError("github", `verifying the PR head failed: ${error.message}`, error.fields);
              }
              throw error;
            }
          },
        },
      ),
    validateFindings: (stage) =>
      validateResolvedFindings(stage, {
        jevClient:
          options.jevClient ??
          createJevClient({ token: stage.jevToken, model: stage.jevModel }),
      }),
    publishFindings: (stage) =>
      publishFindings(stage, {
        verifyHead: async () => {
          await verifyHeadCurrent(
            stage.token,
            stage.context.repository,
            stage.context.pullNumber,
            stage.context.headSha,
            { signal: stage.signal, ...githubOptions },
          );
        },
        postComment: (payload) =>
          postInlineComment(
            stage.token,
            stage.context.repository,
            stage.context.pullNumber,
            payload,
            { signal: stage.signal, ...githubOptions },
          ),
      }),
  };
}

// --- Jev validation stage (phase 4) ----------------------------------------

function skippedGateOutcome(input: {
  finding: Finding;
  range: ResolvedRange;
  validation: ValidationResult | null;
  jevCalls: number;
  rangeRetryUsed: boolean;
  reason: { code: ValidationSkipReason; message: string };
}): FindingGateOutcome {
  return {
    finding: input.finding,
    range: input.range,
    stage: "skipped",
    validation: input.validation,
    jevCalls: input.jevCalls,
    rangeRetryUsed: input.rangeRetryUsed,
    reason: input.reason,
    publishable: null,
  };
}

async function validateResolvedFinding(input: {
  finding: Finding;
  range: ResolvedRange;
  diff: DiffModel;
  workspace: string;
  headSha: string;
  skillCriteria: JevSkillCriteria;
  thresholds: ReviewThresholds;
  jevClient: JevClient;
  signal?: AbortSignal;
}): Promise<FindingGateOutcome> {
  const { finding, skillCriteria, thresholds, jevClient } = input;
  const blob = readHeadBlob(input.workspace, input.headSha, input.range.path);
  if (blob.kind === "skipped") {
    // Deterministic HEAD content cannot change between two reads; keep the
    // finding rather than aborting the batch if this invariant is ever broken.
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: null,
      jevCalls: 0,
      rangeRetryUsed: false,
      reason: { code: blob.reason, message: blob.message },
    });
  }

  const evidence = buildJevEvidence({
    diff: input.diff,
    path: input.range.path,
    blobLines: blob.lines,
    range: input.range,
  });
  const first = await jevClient.validateFinding({ finding, resolved: input.range, skillCriteria, evidence, signal: input.signal });
  if (first.kind === "evidence_overflow") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: null,
      jevCalls: 0,
      rangeRetryUsed: false,
      reason: { code: "evidence_overflow", message: gateSkipMessages.evidence_overflow },
    });
  }

  const firstGate = decideGate({ finding, resolved: input.range, validation: first.validation, thresholds, rangeRetryUsed: false });
  if (firstGate.kind === "publishable") {
    return {
      finding,
      range: input.range,
      stage: "publishable",
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: false,
      reason: null,
      publishable: firstGate.publishable,
    };
  }
  if (firstGate.kind === "skip") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: false,
      reason: { code: firstGate.reason, message: firstGate.message },
    });
  }

  // Only range quality failed: one deterministic correction, one re-evaluation.
  const correction = reResolveForCorrection({
    finding,
    previous: input.range,
    quality: firstGate.quality,
    diff: input.diff,
    blobLines: blob.lines,
    attempt: 0,
  });
  if (correction.kind === "skipped") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: true,
      reason: { code: correction.reason, message: correction.message },
    });
  }
  const corrected = correction.range;
  const correctedEvidence = buildJevEvidence({
    diff: input.diff,
    path: corrected.path,
    blobLines: blob.lines,
    range: corrected,
  });
  const second = await jevClient.validateFinding({ finding, resolved: corrected, skillCriteria, evidence: correctedEvidence, signal: input.signal });
  if (second.kind === "evidence_overflow") {
    return skippedGateOutcome({
      finding,
      range: corrected,
      validation: null,
      jevCalls: 1,
      rangeRetryUsed: true,
      reason: { code: "evidence_overflow", message: gateSkipMessages.evidence_overflow },
    });
  }
  const secondGate = decideGate({ finding, resolved: corrected, validation: second.validation, thresholds, rangeRetryUsed: true });
  if (secondGate.kind === "publishable") {
    return {
      finding,
      range: corrected,
      stage: "publishable",
      validation: second.validation,
      jevCalls: 2,
      rangeRetryUsed: true,
      reason: null,
      publishable: secondGate.publishable,
    };
  }
  if (secondGate.kind === "skip") {
    return skippedGateOutcome({
      finding,
      range: corrected,
      validation: second.validation,
      jevCalls: 2,
      rangeRetryUsed: true,
      reason: { code: secondGate.reason, message: secondGate.message },
    });
  }
  // decideGate cannot ask for another retry once rangeRetryUsed is true.
  return skippedGateOutcome({
    finding,
    range: corrected,
    validation: second.validation,
    jevCalls: 2,
    rangeRetryUsed: true,
    reason: { code: "range_retry_exhausted", message: gateSkipMessages.range_retry_exhausted },
  });
}

/**
 * Validate every resolved finding, in order, before anything is published
 * (docs/architecture.md "全findingの検証後に投稿する"). A Jev transport or
 * response failure throws JevRunError and stops the run; per-finding gate
 * failures become skips with fixed reason codes.
 */
export async function validateResolvedFindings(
  options: ValidateStageOptions,
  deps: { jevClient: JevClient },
): Promise<FindingGateOutcome[]> {
  const resolved = options.resolutions.filter(
    (resolution): resolution is Extract<FindingResolution, { kind: "resolved" }> => resolution.kind === "resolved",
  );
  if (resolved.length === 0) {
    return [];
  }
  const diff = buildDiffModel(options.prepared.workspace, options.prepared.mergeBase, options.context.headSha);
  const outcomes: FindingGateOutcome[] = [];
  for (const resolution of resolved) {
    outcomes.push(
      await validateResolvedFinding({
        finding: resolution.finding,
        range: resolution.range,
        diff,
        workspace: options.prepared.workspace,
        headSha: options.context.headSha,
        skillCriteria: options.skillCriteria,
        thresholds: options.context.thresholds,
        jevClient: deps.jevClient,
        signal: options.signal,
      }),
    );
  }
  return outcomes;
}

// Producer failure kinds map to the run error stage reported to the workflow.
export function stageForFailure(kind: ReviewFailureKind): RunErrorStage {
  switch (kind) {
    case "github":
    case "head_changed":
    case "workspace":
    case "changed_paths":
    case "skill":
      return "context";
    case "config":
      return "config";
    case "spawn":
    case "timeout":
    case "cancelled":
    case "producer":
      return "producer";
    case "ndjson_missing":
    case "ndjson_corrupt":
    case "ndjson_too_large":
    case "limit_exceeded":
      return "results";
  }
}

function failure(stage: RunErrorStage, fields: string[], message: string): RunResult {
  return { code: 1, error: { class: "run_error", stage, message, fields } };
}

/**
 * Result-file status. `staged` is the gate plan written before publication;
 * the terminal statuses are `dry_run`, `success` and `publisher_error`.
 */
export type ResultStatus = "staged" | "dry_run" | "success" | "publisher_error";

export type ResultFinding = {
  id: string;
  path: string;
  severity: string;
  title: string;
  stage: string;
  transitions: Array<{ stage: string }>;
  reason: { code: string; message: string } | null;
  range: ResolvedRange | null;
  validation: ValidationResult | null;
  jevCalls: number;
  retryUsed: boolean;
  publish: { stage: string; commentId: number | null; url: string | null; ambiguous: boolean } | null;
  duplicateOf?: string;
};

export type RunArtifactsInput = {
  runnerTemp: string;
  prepared: PreparedReview;
  produced: ProducerOutcome;
  resolutions: readonly FindingResolution[];
  gateOutcomes: readonly FindingGateOutcome[];
  dedup: PublishableDedup;
  publish: PublishOutcome;
  status: ResultStatus;
  dryRun: boolean;
};

export type RunArtifacts = {
  result: Record<string, unknown>;
  counts: RunCounts;
  resultPath: string;
  findings: ResultFinding[];
};

/** D17 duplicate message recorded for collapsed findings. */
export const duplicateFindingMessage = "同一invocation内の完全一致findingのため、先に検出された指摘へ統合しました。";

/**
 * Build the JSON result file. It survives workspace cleanup; it records
 * Core-generated ids, per-finding stages (including Jev values and gate
 * outcome), fixed reason codes, resolved ranges, dedup notes and the publisher
 * plan/results with payloads and comment ids, but never child environment
 * values or full OpenCode traces.
 */
export function buildRunArtifacts(input: RunArtifactsInput): RunArtifacts {
  const { produced, resolutions, gateOutcomes, dedup, publish } = input;
  if (resolutions.length !== produced.findings.length) {
    throw new Error("range resolution count does not match the accepted findings");
  }
  const resolvedCount = resolutions.filter((resolution) => resolution.kind === "resolved").length;
  if (resolvedCount !== gateOutcomes.length) {
    throw new Error("gate outcome count does not match the resolved findings");
  }
  const gateById = new Map(gateOutcomes.map((outcome) => [outcome.finding.id, outcome]));
  if (gateById.size !== gateOutcomes.length) {
    throw new Error("duplicate gate outcomes");
  }
  const duplicateById = new Map(dedup.duplicates.map((duplicate) => [duplicate.finding.id, duplicate.duplicateOf]));
  const entryByFindingId = new Map(publish.entries.map((entry) => [entry.findingId, entry]));
  const skippedByRange = resolutions.filter((resolution) => resolution.kind === "skipped").length;
  const skippedByGate = gateOutcomes.filter((outcome) => outcome.stage === "skipped").length;
  const counts: RunCounts = {
    accepted: produced.findings.length,
    publishable: dedup.unique.length,
    published: publish.posted,
    skipped: produced.rejected.length + skippedByRange + skippedByGate + dedup.duplicates.length,
    deduped: dedup.duplicates.length,
  };
  const resultPath = join(input.runnerTemp, "review-result.json");
  const findings: ResultFinding[] = produced.findings.map((finding: Finding, index: number) => {
    const resolution = resolutions[index]!;
    const base = {
      id: finding.id,
      path: finding.path,
      severity: finding.severity,
      title: finding.title,
    };
    if (resolution.kind === "skipped") {
      return {
        ...base,
        stage: "skipped",
        transitions: [{ stage: "accepted" }, { stage: "skipped" }],
        reason: { code: resolution.reason, message: resolution.message },
        range: null,
        validation: null,
        jevCalls: 0,
        retryUsed: false,
        publish: null,
      };
    }
    const outcome = gateById.get(finding.id);
    if (outcome === undefined) {
      throw new Error("resolved finding is missing a gate outcome");
    }
    const transitions: Array<{ stage: string }> = [{ stage: "accepted" }, { stage: "resolved" }];
    if (outcome.validation !== null) {
      transitions.push({ stage: "validated" });
    }
    const duplicateOf = duplicateById.get(finding.id);
    if (outcome.stage === "publishable" && duplicateOf !== undefined) {
      transitions.push({ stage: "skipped" });
      return {
        ...base,
        stage: "skipped",
        transitions,
        reason: { code: "duplicate_finding", message: duplicateFindingMessage },
        range: outcome.range,
        validation: outcome.validation,
        jevCalls: outcome.jevCalls,
        retryUsed: outcome.rangeRetryUsed,
        publish: null,
        duplicateOf,
      };
    }
    transitions.push({ stage: outcome.stage });
    let publishRecord: ResultFinding["publish"] = null;
    if (outcome.stage === "publishable") {
      const entry = entryByFindingId.get(finding.id);
      if (entry === undefined) {
        throw new Error("publishable finding is missing a publisher entry");
      }
      transitions.push({ stage: entry.stage });
      publishRecord = {
        stage: entry.stage,
        commentId: entry.commentId,
        url: entry.url,
        ambiguous: entry.ambiguous,
      };
    }
    return {
      ...base,
      stage: outcome.stage,
      transitions,
      reason: outcome.reason,
      range: outcome.range,
      validation: outcome.validation,
      jevCalls: outcome.jevCalls,
      retryUsed: outcome.rangeRetryUsed,
      publish: publishRecord,
    };
  });
  const result = {
    runVersion: RUN_VERSION,
    status: input.status,
    dryRun: input.dryRun,
    repository: input.prepared.context.repository,
    pullNumber: input.prepared.context.pullNumber,
    skill: input.prepared.context.skill,
    model: input.prepared.context.model,
    baseSha: input.prepared.context.baseSha,
    headSha: input.prepared.context.headSha,
    mergeBase: input.prepared.mergeBase,
    counts,
    dedup: {
      count: dedup.duplicates.length,
      entries: dedup.duplicates.map((duplicate) => ({
        findingId: duplicate.finding.id,
        duplicateOf: duplicate.duplicateOf,
      })),
    },
    publish: { failure: publish.failure },
    publishables: publish.entries,
    findings,
    rejected: produced.rejected,
  };
  return { result, counts, resultPath, findings };
}

export async function writeRunArtifacts(input: RunArtifactsInput): Promise<RunArtifacts> {
  const artifacts = buildRunArtifacts(input);
  await writeFile(artifacts.resultPath, `${JSON.stringify(artifacts.result, null, 2)}\n`, "utf8");
  return artifacts;
}

/**
 * Action outputs. Written best-effort on every terminal path (including run
 * errors, where unknown counts are reported as 0 and result-path as empty), so
 * a failing workflow can still inspect what the run knew. A failure to append
 * outputs never masks the original run result.
 */
export async function appendOutputs(
  outputPath: string | null,
  counts: RunCounts,
  resultPath: string | null,
): Promise<void> {
  if (outputPath === null || outputPath.trim().length === 0) {
    return;
  }
  const outputs = [
    `accepted-count=${counts.accepted}`,
    `publishable-count=${counts.publishable}`,
    `published-count=${counts.published}`,
    `skipped-count=${counts.skipped}`,
    `result-path=${resultPath ?? ""}`,
  ];
  try {
    await appendFile(outputPath, `${outputs.join("\n")}\n`, "utf8");
  } catch {
    // Documented best-effort: GITHUB_OUTPUT may be unavailable on early errors.
  }
}

export const ZERO_COUNTS: RunCounts = { accepted: 0, publishable: 0, published: 0, skipped: 0, deduped: 0 };

export async function run(
  env: Env,
  dependencies: PipelineDependencies = defaultPipelineDependencies(),
  signal?: AbortSignal,
): Promise<RunResult> {
  let outputPath: string | null = (env["GITHUB_OUTPUT"] ?? "").trim() || null;
  try {
    const inputs = readActionInputs(env);
    const environment = readRunnerEnvironment(env);
    outputPath = environment.outputPath;
    const jevToken = readJevToken(env);
    const event = await readEventFile(environment.eventPath);
    if (!isSameRepository(event)) {
      await appendOutputs(outputPath, ZERO_COUNTS, null);
      return failure(
        "repository",
        ["pull_request.head.repo.full_name"],
        "fork pull requests are not supported by this Action",
      );
    }
    const context = buildReviewContext(inputs, event);
    const prepared = await dependencies.prepareReview(context, inputs.githubToken, environment.workspace, signal);
    const produced = await dependencies.produceFindings(prepared, {
      runnerTemp: environment.runnerTemp,
      model: context.model,
      timeoutMs: context.limits.timeoutSeconds * 1000,
      maxFindings: context.limits.maxFindings,
      parentEnv: env,
      protectedValues: [inputs.githubToken],
      signal,
    });
    const resolutions = await dependencies.resolveRanges({
      context,
      prepared,
      token: inputs.githubToken,
      findings: produced.findings,
      signal,
    });
    // Validate every resolved finding before anything could be published
    // (docs/architecture.md "正常実行の順序"). A Jev failure throws and stops
    // the run; only per-finding gate failures become skips.
    const gateOutcomes = await dependencies.validateFindings({
      context,
      prepared,
      resolutions,
      skillCriteria: produced.skillCriteria,
      jevModel: inputs.jevModel,
      jevToken,
      signal,
    });
    // D17: collapse exact duplicates only after every finding was validated.
    const dedup = dedupePublishables(
      gateOutcomes
        .filter((outcome) => outcome.stage === "publishable" && outcome.publishable !== null)
        .map((outcome) => outcome.publishable!),
    );
    const plan: PublishOutcome = { entries: planPublishEntries(dedup.unique), posted: 0, failure: null };
    // Stage the gate plan in the result file before any POST (D18).
    let artifacts: RunArtifacts;
    try {
      artifacts = await writeRunArtifacts({
        runnerTemp: environment.runnerTemp,
        prepared,
        produced,
        resolutions,
        gateOutcomes,
        dedup,
        publish: plan,
        status: "staged",
        dryRun: inputs.dryRun,
      });
    } catch {
      await appendOutputs(outputPath, ZERO_COUNTS, null);
      return failure("results", [], "failed to write the run result file");
    }

    if (inputs.dryRun) {
      // Same validation and payloads as publication, zero POST calls (D11).
      console.log(
        formatDryRunPlan(
          plan.entries,
          artifacts.findings
            .filter((finding) => finding.stage === "skipped")
            .map((finding) => ({ id: finding.id, stage: finding.stage, reason: finding.reason })),
        ),
      );
      try {
        artifacts = await writeRunArtifacts({
          runnerTemp: environment.runnerTemp,
          prepared,
          produced,
          resolutions,
          gateOutcomes,
          dedup,
          publish: plan,
          status: "dry_run",
          dryRun: true,
        });
      } catch {
        await appendOutputs(outputPath, ZERO_COUNTS, artifacts.resultPath);
        return failure("results", [], "failed to write the run result file");
      }
      await appendOutputs(outputPath, artifacts.counts, artifacts.resultPath);
      return { code: 0, context };
    }

    const outcome = await dependencies.publishFindings({
      context,
      publishables: dedup.unique,
      token: inputs.githubToken,
      dryRun: false,
      signal,
    });
    const status: ResultStatus = outcome.failure === null ? "success" : "publisher_error";
    try {
      artifacts = await writeRunArtifacts({
        runnerTemp: environment.runnerTemp,
        prepared,
        produced,
        resolutions,
        gateOutcomes,
        dedup,
        publish: outcome,
        status,
        dryRun: false,
      });
    } catch {
      await appendOutputs(outputPath, ZERO_COUNTS, artifacts.resultPath);
      return failure("results", [], "failed to write the run result file after publishing");
    }
    await appendOutputs(outputPath, artifacts.counts, artifacts.resultPath);
    if (outcome.failure !== null) {
      return failure(
        "publisher",
        outcome.failure.fields,
        `publisher mid-run failure (${outcome.failure.step}): ${outcome.failure.message} (posted ${outcome.posted})`,
      );
    }
    return { code: 0, context };
  } catch (error) {
    await appendOutputs(outputPath, ZERO_COUNTS, null);
    if (error instanceof ActionInputError) {
      return failure("input", error.fields, "invalid Action inputs");
    }
    if (error instanceof EnvironmentError) {
      return failure("environment", error.fields, "missing required environment variables");
    }
    if (error instanceof EventError) {
      return failure("event", error.fields, "invalid GitHub event payload");
    }
    if (error instanceof JevRunError) {
      return failure("jev", error.fields, error.message);
    }
    if (error instanceof RangeRunError) {
      return failure("context", error.fields, error.message);
    }
    if (error instanceof ReviewRunError) {
      return failure(stageForFailure(error.kind), error.fields, error.message);
    }
    return failure("pipeline", [], "unexpected run failure");
  }
}

export async function main(env: Env = process.env): Promise<number> {
  const result = await run(env);
  if (result.code !== 0) {
    console.error(JSON.stringify(result.error));
  }
  return result.code;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await main();
}
