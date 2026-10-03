import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ActionInputError,
  buildReviewContext,
  defaultPipelineDependencies,
  EnvironmentError,
  isSameRepository,
  parsePullRequestEvent,
  publishFindings,
  readActionInputs,
  readJevToken,
  run,
  validateResolvedFindings,
  type ActionInputs,
  type FindingGateOutcome,
  type PipelineDependencies,
} from "../src/main.ts";
import { gateSkipMessages, toPublishableFinding, type Finding, type ResolvedRange } from "../src/finding.ts";
import { JevRunError, type JevClient, type JevValidateInput } from "../src/jev.ts";
import { ReviewRunError, type PreparedReview, type ReviewFailureKind } from "../src/opencode.ts";
import { RangeRunError, resolveFindings, type FindingResolution } from "../src/range.ts";
import { createFixtureRepo, fixtureContext, fixturePrInfo } from "./helpers/git-fixture.ts";
import { createRangeRepo, type RangeFixtureRepo } from "./helpers/range-fixture.ts";

type Env = Record<string, string | undefined>;

const validEnv = (overrides: Env = {}): Env => ({
  "INPUT_SKILL": "pr-review",
  "INPUT_MODEL": "openai/gpt-5",
  "INPUT_DRY-RUN": "false",
  "INPUT_GITHUB-TOKEN": "test-token-1234567890",
  "INPUT_JEV-MODEL": "jev-1.13-free",
  "INPUT_SUPPORTED-THRESHOLD": "0.7",
  "INPUT_COMMENT-WORTHY-THRESHOLD": "0.6",
  "INPUT_TIMEOUT-SECONDS": "600",
  "INPUT_MAX-FINDINGS": "100",
  "JEV_API_KEY": "jev-test-token-1234567890",
  ...overrides,
});

const inputFields = (overrides: Env): string[] => {
  try {
    readActionInputs(validEnv(overrides));
  } catch (error) {
    if (error instanceof ActionInputError) {
      return error.fields;
    }
    throw error;
  }
  throw new Error("expected ActionInputError");
};

test("readActionInputs parses the documented minimal inputs", () => {
  const inputs: ActionInputs = readActionInputs(validEnv());
  assert.deepEqual(inputs, {
    skill: "pr-review",
    model: "openai/gpt-5",
    dryRun: false,
    githubToken: "test-token-1234567890",
    jevModel: "jev-1.13-free",
    supportedThreshold: 0.7,
    commentWorthyThreshold: 0.6,
    timeoutSeconds: 600,
    maxFindings: 100,
  });
});

test("readActionInputs applies defaults when optional INPUT_* are absent", () => {
  const inputs = readActionInputs(validEnv({
    "INPUT_DRY-RUN": undefined,
    "INPUT_JEV-MODEL": undefined,
    "INPUT_SUPPORTED-THRESHOLD": undefined,
    "INPUT_COMMENT-WORTHY-THRESHOLD": undefined,
    "INPUT_TIMEOUT-SECONDS": undefined,
    "INPUT_MAX-FINDINGS": undefined,
  }));
  assert.equal(inputs.dryRun, false);
  assert.equal(inputs.jevModel, "jev-1.13-free");
  assert.equal(inputs.supportedThreshold, 0.7);
  assert.equal(inputs.commentWorthyThreshold, 0.6);
  assert.equal(inputs.timeoutSeconds, 600);
  assert.equal(inputs.maxFindings, 100);
});

test("the hyphenated INPUT_DRY-RUN name is the one that is read", () => {
  assert.equal(readActionInputs(validEnv({ "INPUT_DRY-RUN": "true" })).dryRun, true);
  assert.equal(readActionInputs(validEnv({ "INPUT_DRY-RUN": " false " })).dryRun, false);
});

test("boolean inputs accept only exact lowercase true or false", () => {
  for (const value of ["TRUE", "True", "1", "", "yes"]) {
    assert.deepEqual(inputFields({ "INPUT_DRY-RUN": value }), ["INPUT_DRY-RUN"], `dry-run=${JSON.stringify(value)}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_DRY-RUN": "false" })).dryRun, false);
});

test("threshold inputs require a finite number inside 0..1", () => {
  for (const value of ["abc", "NaN", "Infinity", "1.5", "-0.1", ""]) {
    assert.deepEqual(inputFields({ "INPUT_SUPPORTED-THRESHOLD": value }), ["INPUT_SUPPORTED-THRESHOLD"], `supported=${value}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_SUPPORTED-THRESHOLD": "0" })).supportedThreshold, 0);
  assert.equal(readActionInputs(validEnv({ "INPUT_SUPPORTED-THRESHOLD": "1" })).supportedThreshold, 1);
});

test("timeout-seconds must be an integer inside 1..3600", () => {
  for (const value of ["600.5", "0", "3601", "-1", "abc", ""]) {
    assert.deepEqual(inputFields({ "INPUT_TIMEOUT-SECONDS": value }), ["INPUT_TIMEOUT-SECONDS"], `timeout=${value}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_TIMEOUT-SECONDS": "1" })).timeoutSeconds, 1);
  assert.equal(readActionInputs(validEnv({ "INPUT_TIMEOUT-SECONDS": "3600" })).timeoutSeconds, 3600);
});

test("max-findings must be an integer inside 1..1000", () => {
  for (const value of ["0", "1001", "1.5", "abc", ""]) {
    assert.deepEqual(inputFields({ "INPUT_MAX-FINDINGS": value }), ["INPUT_MAX-FINDINGS"], `max=${value}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_MAX-FINDINGS": "1" })).maxFindings, 1);
  assert.equal(readActionInputs(validEnv({ "INPUT_MAX-FINDINGS": "1000" })).maxFindings, 1000);
});

test("skill names are restricted to the documented kebab-case pattern", () => {
  for (const value of ["Bad_Name", "-x", "x--y", "a".repeat(65), "", "x/y"]) {
    assert.deepEqual(inputFields({ "INPUT_SKILL": value }), ["INPUT_SKILL"], `skill=${value}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_SKILL": "pr-review" })).skill, "pr-review");
  assert.equal(readActionInputs(validEnv({ "INPUT_SKILL": "a" })).skill, "a");
});

test("model must be provider/model with an optional variant", () => {
  for (const value of ["gpt4", "a/b/c", "a b/c", "openai/"]) {
    assert.deepEqual(inputFields({ "INPUT_MODEL": value }), ["INPUT_MODEL"], `model=${value}`);
  }
  assert.equal(readActionInputs(validEnv({ "INPUT_MODEL": "openai/gpt-5" })).model, "openai/gpt-5");
  assert.equal(readActionInputs(validEnv({ "INPUT_MODEL": "openai/gpt-5#free" })).model, "openai/gpt-5#free");
});

test("github-token is required even for dry-run and never appears in errors", () => {
  assert.deepEqual(inputFields({ "INPUT_GITHUB-TOKEN": undefined }), ["INPUT_GITHUB-TOKEN"]);
  assert.deepEqual(inputFields({ "INPUT_GITHUB-TOKEN": "" }), ["INPUT_GITHUB-TOKEN"]);

  const secret = "ghp_secret_value_1234567890";
  try {
    readActionInputs(validEnv({ "INPUT_MODEL": "not-a-model", "INPUT_GITHUB-TOKEN": secret }));
    assert.fail("expected ActionInputError");
  } catch (error) {
    assert.ok(error instanceof ActionInputError);
    assert.deepEqual(error.fields, ["INPUT_MODEL"]);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes("not-a-model"));
  }
});

test("readJevToken requires JEV_API_KEY and reports only the name", () => {
  for (const value of [undefined, "", "   "]) {
    try {
      readJevToken({ "JEV_API_KEY": value });
      assert.fail("expected EnvironmentError");
    } catch (error) {
      assert.ok(error instanceof EnvironmentError);
      assert.deepEqual(error.fields, ["JEV_API_KEY"]);
      assert.ok(!error.message.includes("undefined"));
    }
  }
  const secret = "tsk_live_secret_value";
  assert.equal(readJevToken({ "JEV_API_KEY": ` ${secret} ` }), secret);
});

test("several invalid inputs are reported together by name", () => {
  const fields = inputFields({ "INPUT_SKILL": "Bad_Name", "INPUT_MAX-FINDINGS": "0" });
  assert.deepEqual([...fields].sort(), ["INPUT_MAX-FINDINGS", "INPUT_SKILL"]);
});

test("parsePullRequestEvent accepts the fixture and rejects wrong action or SHA", () => {
  const opened = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const event = parsePullRequestEvent(opened);
  assert.equal(event.action, "opened");
  assert.equal(event.pull_request.draft, false);

  const withoutDraft = structuredClone(opened);
  delete (withoutDraft["pull_request"] as Record<string, unknown>)["draft"];
  assert.equal(parsePullRequestEvent(withoutDraft).pull_request.draft, false);

  const wrongAction = structuredClone(opened);
  wrongAction["action"] = "closed";
  assert.throws(() => parsePullRequestEvent(wrongAction), (error: unknown) => error instanceof Error && error.name === "EventError" && error.message.includes("action"));

  const badSha = structuredClone(opened) as { pull_request: { head: { sha: string } } };
  badSha.pull_request.head.sha = "not-a-sha";
  assert.throws(() => parsePullRequestEvent(badSha), (error: unknown) => error instanceof Error && error.name === "EventError" && error.message.includes("pull_request.head.sha"));
});

test("isSameRepository detects fork events", () => {
  const opened = parsePullRequestEvent(JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8")));
  const fork = parsePullRequestEvent(JSON.parse(readFileSync(new URL("./fixtures/event-fork.json", import.meta.url), "utf8")));
  assert.equal(isSameRepository(opened), true);
  assert.equal(isSameRepository(fork), false);
});

test("buildReviewContext lifts the validated event and inputs", () => {
  const event = parsePullRequestEvent(JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8")));
  const context = buildReviewContext(readActionInputs(validEnv()), event);
  assert.equal(context.repository, "example/opencode-review");
  assert.equal(context.pullNumber, 42);
  assert.equal(context.baseSha, "2222222222222222222222222222222222222222");
  assert.equal(context.headSha, "1111111111111111111111111111111111111111");
  assert.equal(context.skill, "pr-review");
  assert.equal(context.model, "openai/gpt-5");
  assert.deepEqual(context.thresholds, { supported: 0.7, commentWorthy: 0.6 });
  assert.deepEqual(context.limits, { timeoutSeconds: 600, maxFindings: 100 });
});

async function runnerEnv(t: TestContext, event: unknown, overrides: Env = {}): Promise<Env> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-review-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify(event));
  return validEnv({
    GITHUB_EVENT_PATH: eventPath,
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "output.txt"),
    GITHUB_REPOSITORY: "example/opencode-review",
    ...overrides,
  });
}

function fakePrepared(context: Parameters<PipelineDependencies["prepareReview"]>[0]): PreparedReview {
  return {
    context,
    mergeBase: "a".repeat(40),
    changedPaths: ["src/counter.ts"],
    workspace: "/nonexistent-workspace",
  };
}

function fakeDependencies(
  produce: PipelineDependencies["produceFindings"] = async (prepared) => ({
    findings: [
      {
        id: "00000000-0000-4000-8000-000000000000",
        skill: prepared.context.skill,
        path: "src/counter.ts",
        candidateRange: { start: 2, end: 2, anchor: "  return n + 1;" },
        severity: "medium",
        title: "Fixture finding",
        body: "A fixture finding for the pipeline test.",
      },
    ],
    rejected: [],
    canaryPresent: true,
    stagingDir: "/nonexistent-staging",
    exit: { kind: "exit", code: 0, signal: null, stdoutTail: "", stderrTail: "" },
    skillCriteria: { name: prepared.context.skill, criteria: "Report concrete defects only." },
  }),
  resolve: PipelineDependencies["resolveRanges"] = async (options) =>
    options.findings.map((finding): FindingResolution => ({
      finding,
      kind: "resolved",
      range: {
        path: finding.path,
        commitId: options.context.headSha,
        startLine: finding.candidateRange.start,
        endLine: finding.candidateRange.end,
        anchorStartLine: finding.candidateRange.start,
        side: "RIGHT",
        code: finding.candidateRange.anchor,
      },
    })),
  validate: PipelineDependencies["validateFindings"] = async (options) =>
    options.resolutions.flatMap((resolution): FindingGateOutcome[] => {
      if (resolution.kind !== "resolved") {
        return [];
      }
      return [
        {
          finding: resolution.finding,
          range: resolution.range,
          stage: "publishable",
          validation: { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct" },
          jevCalls: 1,
          rangeRetryUsed: false,
          reason: null,
          publishable: toPublishableFinding(resolution.finding, resolution.range),
        },
      ];
    }),
  publish: PipelineDependencies["publishFindings"] = async (options) => {
    let commentId = 9000;
    return publishFindings(options, {
      verifyHead: async () => undefined,
      postComment: async (payload) => {
        commentId += 1;
        assert.equal(payload.body.startsWith("["), true);
        return { id: commentId, url: `https://github.com/example/repo/pull/1#discussion_r${commentId}` };
      },
    });
  },
): PipelineDependencies {
  return {
    prepareReview: async (context) => fakePrepared(context),
    produceFindings: produce,
    resolveRanges: resolve,
    validateFindings: validate,
    publishFindings: publish,
  };
}

test("a fully valid run publishes findings and records posted comment ids", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event);
  const result = await run(env, fakeDependencies());
  assert.equal(result.code, 0);

  const resultFile = JSON.parse(readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8")) as {
    runVersion: string;
    status: string;
    dryRun: boolean;
    skill: string;
    model: string;
    headSha: string;
    counts: Record<string, number>;
    publish: { failure: unknown };
    publishables: Array<{
      findingId: string;
      path: string;
      startLine: number;
      endLine: number;
      stage: string;
      commentId: number | null;
      url: string | null;
      payload: { commit_id: string; path: string; line: number; side: string; body: string; start_line?: number };
    }>;
    findings: Array<{
      id: string;
      stage: string;
      transitions: unknown[];
      reason: { code: string; message: string } | null;
      range?: { commitId: string; startLine: number; endLine: number; anchorStartLine: number; side: string };
      validation?: { supported: number; commentWorthy: number; rangeQuality: string } | null;
      jevCalls?: number;
      retryUsed?: boolean;
      publish?: { stage: string; commentId: number | null; url: string | null } | null;
    }>;
  };
  assert.equal(resultFile.runVersion, "0.0.0");
  assert.equal(resultFile.status, "success");
  assert.equal(resultFile.dryRun, false);
  assert.equal(resultFile.skill, "pr-review");
  assert.equal(resultFile.model, "openai/gpt-5");
  assert.equal(resultFile.headSha, "1111111111111111111111111111111111111111");
  assert.deepEqual(resultFile.counts, { accepted: 1, publishable: 1, published: 1, skipped: 0, deduped: 0 });
  assert.equal(resultFile.publish.failure, null);
  assert.equal(resultFile.publishables.length, 1);
  assert.equal(resultFile.publishables[0]?.findingId, "00000000-0000-4000-8000-000000000000");
  assert.equal(resultFile.publishables[0]?.stage, "posted");
  assert.equal(resultFile.publishables[0]?.commentId, 9001);
  assert.equal(resultFile.publishables[0]?.payload.commit_id, "1111111111111111111111111111111111111111");
  assert.equal(resultFile.publishables[0]?.payload.line, 2);
  assert.equal(resultFile.publishables[0]?.payload.side, "RIGHT");
  assert.equal(resultFile.publishables[0]?.payload.start_line, undefined);
  assert.equal(resultFile.publishables[0]?.payload.body, "[medium] Fixture finding\n\nA fixture finding for the pipeline test.");
  assert.equal(resultFile.findings.length, 1);
  assert.equal(resultFile.findings[0]?.stage, "publishable");
  assert.equal(resultFile.findings[0]?.reason, null);
  assert.equal(resultFile.findings[0]?.range?.commitId, "1111111111111111111111111111111111111111");
  assert.deepEqual(resultFile.findings[0]?.range?.startLine, 2);
  assert.deepEqual(resultFile.findings[0]?.range?.anchorStartLine, 2);
  assert.deepEqual(resultFile.findings[0]?.validation, { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct" });
  assert.equal(resultFile.findings[0]?.jevCalls, 1);
  assert.equal(resultFile.findings[0]?.retryUsed, false);
  assert.deepEqual(resultFile.findings[0]?.publish, {
    stage: "posted",
    commentId: 9001,
    url: "https://github.com/example/repo/pull/1#discussion_r9001",
    ambiguous: false,
  });
  assert.deepEqual(resultFile.findings[0]?.transitions, [
    { stage: "accepted" },
    { stage: "resolved" },
    { stage: "validated" },
    { stage: "publishable" },
    { stage: "posted" },
  ]);

  const outputs = readFileSync(env["GITHUB_OUTPUT"]!, "utf8");
  assert.ok(outputs.includes("accepted-count=1"));
  assert.ok(outputs.includes("publishable-count=1"));
  assert.ok(outputs.includes("published-count=1"));
  assert.ok(outputs.includes("skipped-count=0"));
  assert.ok(outputs.includes(`result-path=${join(env["RUNNER_TEMP"]!, "review-result.json")}`));
});

test("range skips are recorded per finding and counted as skipped", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event);
  const dependencies = fakeDependencies(undefined, async (options) =>
    options.findings.map((finding): FindingResolution => ({
      finding,
      kind: "skipped",
      reason: "anchor_not_found",
      message: "anchorと完全一致する行がHEADに存在しません。",
    })),
  );
  const result = await run(env, dependencies);
  assert.equal(result.code, 0);

  const resultFile = JSON.parse(readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8")) as {
    status: string;
    counts: Record<string, number>;
    findings: Array<{ stage: string; transitions: unknown[]; reason: { code: string; message: string } | null }>;
  };
  assert.equal(resultFile.status, "success");
  assert.deepEqual(resultFile.counts, { accepted: 1, publishable: 0, published: 0, skipped: 1, deduped: 0 });
  assert.equal(resultFile.findings[0]?.stage, "skipped");
  assert.deepEqual(resultFile.findings[0]?.transitions, [{ stage: "accepted" }, { stage: "skipped" }]);
  assert.equal(resultFile.findings[0]?.reason?.code, "anchor_not_found");

  const outputs = readFileSync(env["GITHUB_OUTPUT"]!, "utf8");
  assert.ok(outputs.includes("skipped-count=1"));
  assert.ok(outputs.includes("published-count=0"));
});

test("range context-integrity failures map to the context stage and write no result", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event);
  const dependencies = fakeDependencies(undefined, async () => {
    throw new RangeRunError("changed_paths", "fixture changed-path mismatch", ["changed_paths"]);
  });
  const result = await run(env, dependencies);
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "context");
  assert.deepEqual(result.error.fields, ["changed_paths"]);
  assert.throws(() => readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8"));
});

test("the default range stage re-verifies HEAD over GitHub and resolves with local git", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const prepared: PreparedReview = {
    context: fixtureContext(repo),
    mergeBase: repo.baseSha,
    changedPaths: ["counter.ts"],
    workspace: repo.root,
  };
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requested.push(String(input));
    return new Response(JSON.stringify(fixturePrInfo(repo)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const results = await defaultPipelineDependencies().resolveRanges({
    context: prepared.context,
    prepared,
    token: "test-token",
    findings: [
      {
        id: "00000000-0000-4000-8000-000000000000",
        skill: "fixture-skill",
        path: "counter.ts",
        candidateRange: { start: 2, end: 2, anchor: "  return n - 1;" },
        severity: "high",
        title: "Fixture finding",
        body: "A fixture finding for the default range test.",
      },
    ],
  });
  assert.equal(results.length, 1);
  const result = results[0]!;
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") {
    return;
  }
  assert.equal(result.range.path, "counter.ts");
  assert.equal(result.range.commitId, repo.headSha);
  assert.equal(result.range.code, "  return n - 1;");
  assert.deepEqual(requested, ["https://api.github.com/repos/example/repo/pulls/1"]);
});

test("producer failure kinds map to the documented run error stages", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const cases: Array<{ kind: ReviewFailureKind; stage: string }> = [
    { kind: "head_changed", stage: "context" },
    { kind: "skill", stage: "context" },
    { kind: "config", stage: "config" },
    { kind: "timeout", stage: "producer" },
    { kind: "producer", stage: "producer" },
    { kind: "ndjson_corrupt", stage: "results" },
    { kind: "limit_exceeded", stage: "results" },
  ];
  for (const testCase of cases) {
    const env = await runnerEnv(t, event);
    const dependencies = fakeDependencies(async () => {
      throw new ReviewRunError(testCase.kind, `fixture ${testCase.kind}`);
    });
    const result = await run(env, dependencies);
    assert.equal(result.code, 1, testCase.kind);
    if (result.code !== 1) {
      continue;
    }
    assert.equal(result.error.stage, testCase.stage, testCase.kind);
  }
});

test("missing runner environment variables are reported by name", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event, { RUNNER_TEMP: undefined });
  const result = await run(env);
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "environment");
  assert.deepEqual(result.error.fields, ["RUNNER_TEMP"]);
});

test("a missing JEV_API_KEY fails fast with the environment stage (D24)", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event, { JEV_API_KEY: undefined });
  const result = await run(env);
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "environment");
  assert.deepEqual(result.error.fields, ["JEV_API_KEY"]);
  // Fail-fast: no result file and no producer work happened.
  assert.throws(() => readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8"));
});

test("a Jev run failure stops the run with the jev stage and writes no result", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  const env = await runnerEnv(t, event);
  const dependencies = fakeDependencies(undefined, undefined, async () => {
    throw new JevRunError("auth", "Jev authentication failed (401 AuthError)", ["jev", "auth"]);
  });
  const result = await run(env, dependencies);
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "jev");
  assert.deepEqual(result.error.fields, ["jev", "auth"]);
  assert.ok(!result.error.message.includes(env["JEV_API_KEY"]!));
  assert.throws(() => readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8"));
});

test("an unsupported event action fails before any pipeline work", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-opened.json", import.meta.url), "utf8"));
  event.action = "closed";
  const result = await run(await runnerEnv(t, event));
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "event");
});

test("fork pull requests are rejected as a repository error", async (t) => {
  const event = JSON.parse(readFileSync(new URL("./fixtures/event-fork.json", import.meta.url), "utf8"));
  const result = await run(await runnerEnv(t, event));
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "repository");
});

test("input errors win over missing environment", async () => {
  const result = await run({ "INPUT_SKILL": "Bad_Name" });
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "input");
  assert.ok(result.error.fields.includes("INPUT_SKILL"));
});

// --- Phase 4 validation stage integration ----------------------------------

const jevValidated = (
  supported: number,
  commentWorthy: number,
  rangeQuality: "correct" | "too_narrow" | "too_wide" | "wrong_location",
) => ({
  kind: "validated" as const,
  validation: { supported, commentWorthy, rangeQuality },
  stateLevel: 0 as const,
  model: "jev-1.13-free",
});

function fakeJevClient(
  answers: Array<ReturnType<typeof jevValidated> | { kind: "evidence_overflow"; message: string }>,
): { client: JevClient; calls: JevValidateInput[] } {
  const calls: JevValidateInput[] = [];
  const client: JevClient = {
    model: "jev-1.13-free",
    async validateFinding(input) {
      calls.push(input);
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    },
  };
  return { client, calls };
}

const LOGIC_HEAD = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
const LOGIC_LINES = LOGIC_HEAD.trimEnd().split("\n");

async function logicRepo(): Promise<RangeFixtureRepo> {
  return createRangeRepo({
    base: [{ path: "logic.ts", content: "const a = 1;\nconst b = 2;\n" }],
    head: [{ path: "logic.ts", content: LOGIC_HEAD }],
  });
}

function logicFinding(id: string, title: string): Finding {
  return {
    id,
    skill: "fixture-skill",
    path: "logic.ts",
    candidateRange: { start: 4, end: 4, anchor: "const d = 4;" },
    severity: "high",
    title,
    body: `${title}: the constant is wrong.`,
  };
}

function logicRange(repo: RangeFixtureRepo, startLine: number, endLine: number, anchorStartLine: number): ResolvedRange {
  return {
    path: "logic.ts",
    commitId: repo.headSha,
    startLine,
    endLine,
    anchorStartLine,
    side: "RIGHT",
    code: LOGIC_LINES.slice(startLine - 1, endLine).join("\n"),
  };
}

function stageInput(
  repo: RangeFixtureRepo,
  resolutions: FindingResolution[],
  criteria = "Report concrete defects only.",
): Parameters<PipelineDependencies["validateFindings"]>[0] {
  const context = fixtureContext({ ...repo, changedPaths: ["logic.ts"] });
  const prepared: PreparedReview = {
    context,
    mergeBase: repo.baseSha,
    changedPaths: ["logic.ts"],
    workspace: repo.root,
  };
  return {
    context,
    prepared,
    resolutions,
    skillCriteria: { name: "fixture-skill", criteria },
    jevModel: "jev-1.13-free",
    jevToken: "test-token-1234567890",
  };
}

test("a too_wide verdict on the resolver's minimal range gives up without re-evaluating", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000001", "No-op correction");
  const resolutions = await resolveFindings(
    { workspace: repo.root, mergeBase: repo.baseSha, headSha: repo.headSha, changedPaths: ["logic.ts"], findings: [finding] },
    { verifyHead: async () => undefined },
  );
  assert.equal(resolutions[0]?.kind, "resolved");
  const { client, calls } = fakeJevClient([jevValidated(0.9, 0.9, "too_wide")]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  assert.equal(calls.length, 1, "identical input must not be re-evaluated");
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "skipped");
  assert.equal(outcome.reason?.code, "range_retry_exhausted");
  assert.equal(outcome.jevCalls, 1);
  assert.equal(outcome.rangeRetryUsed, true);
});

test("a correctable too_wide range is re-resolved and re-evaluated exactly once", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000002", "Correctable wide");
  const resolutions: FindingResolution[] = [
    { finding, kind: "resolved", range: logicRange(repo, 2, 4, 4) },
  ];
  const { client, calls } = fakeJevClient([jevValidated(0.9, 0.9, "too_wide"), jevValidated(0.8, 0.7, "correct")]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  assert.equal(calls.length, 2, "exactly one re-evaluation");
  assert.equal(calls[0]!.resolved.startLine, 2);
  assert.equal(calls[1]!.resolved.startLine, 3, "shrink keeps the anchor and its added run");
  assert.notEqual(JSON.stringify(calls[0]!.resolved), JSON.stringify(calls[1]!.resolved));
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "publishable");
  assert.equal(outcome.jevCalls, 2);
  assert.equal(outcome.rangeRetryUsed, true);
  assert.equal(outcome.range.startLine, 3);
  assert.equal(outcome.range.endLine, 4);
  assert.equal(outcome.publishable?.startLine, 3);
  assert.deepEqual(outcome.validation, { supported: 0.8, commentWorthy: 0.7, rangeQuality: "correct" });
});

test("a correctable too_narrow range expands within the hunk and re-evaluates once", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000003", "Correctable narrow");
  const resolutions: FindingResolution[] = [
    { finding, kind: "resolved", range: logicRange(repo, 4, 4, 4) },
  ];
  const { client, calls } = fakeJevClient([jevValidated(0.9, 0.9, "too_narrow"), jevValidated(0.75, 0.65, "correct")]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.resolved.startLine, 3);
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "publishable");
  assert.equal(outcome.range.startLine, 3);
  assert.equal(outcome.range.endLine, 4);
});

test("wrong_location is a final skip with a single Jev call", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000004", "Wrong place");
  const resolutions: FindingResolution[] = [
    { finding, kind: "resolved", range: logicRange(repo, 3, 4, 4) },
  ];
  const { client, calls } = fakeJevClient([jevValidated(0.9, 0.9, "wrong_location")]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  assert.equal(calls.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "skipped");
  assert.equal(outcome.reason?.code, "range_quality_wrong_location");
  assert.equal(outcome.reason?.message, gateSkipMessages.range_quality_wrong_location);
  assert.equal(outcome.rangeRetryUsed, false);
});

test("a second failing range verdict stops after two calls, never three", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000005", "Still wrong");
  const resolutions: FindingResolution[] = [
    { finding, kind: "resolved", range: logicRange(repo, 2, 4, 4) },
  ];
  const { client, calls } = fakeJevClient([jevValidated(0.9, 0.9, "too_wide"), jevValidated(0.9, 0.9, "too_wide")]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  assert.equal(calls.length, 2);
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "skipped");
  assert.equal(outcome.reason?.code, "range_retry_exhausted");
  assert.equal(outcome.jevCalls, 2);
});

test("evidence_overflow is recorded as a skip with zero Jev calls", async (t) => {
  const repo = await logicRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const finding = logicFinding("00000000-0000-4000-8000-000000000006", "Too big");
  const resolutions: FindingResolution[] = [
    { finding, kind: "resolved", range: logicRange(repo, 3, 4, 4) },
  ];
  const { client } = fakeJevClient([{ kind: "evidence_overflow", message: "fixture overflow" }]);
  const outcomes = await validateResolvedFindings(stageInput(repo, resolutions), { jevClient: client });
  const outcome = outcomes[0]!;
  assert.equal(outcome.stage, "skipped");
  assert.equal(outcome.reason?.code, "evidence_overflow");
  assert.equal(outcome.validation, null);
  assert.equal(outcome.jevCalls, 0);
  assert.equal(outcome.rangeRetryUsed, false);
});

test("run validates every finding, keeps order and stages publishables before the phase 5 stub", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  // A real context: the event points at the fixture repo HEAD so the default
  // range stage can verify and read git.
  const event = {
    action: "opened",
    number: 1,
    pull_request: {
      draft: false,
      head: { sha: repo.headSha, repo: { full_name: "example/repo" } },
      base: { sha: repo.baseSha },
    },
    repository: { full_name: "example/repo", private: true },
  };
  const env = await runnerEnv(t, event);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(fixturePrInfo(repo)), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const context = fixtureContext(repo);
  const findings: Finding[] = [
    {
      id: "00000000-0000-4000-8000-000000000011",
      skill: context.skill,
      path: "counter.ts",
      candidateRange: { start: 2, end: 2, anchor: "  return n - 1;" },
      severity: "high",
      title: "Real defect",
      body: "The increment helper now decrements.",
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      skill: context.skill,
      path: "counter.ts",
      candidateRange: { start: 1, end: 1, anchor: "export function increment(n: number) {" },
      severity: "low",
      title: "Style nit",
      body: "A preference without a defect.",
    },
  ];
  const observed: string[] = [];
  const jevClient: JevClient = {
    model: "jev-1.13-free",
    async validateFinding(input) {
      observed.push(input.finding.title);
      return input.finding.title === "Real defect" ? jevValidated(0.9, 0.9, "correct") : jevValidated(0.95, 0.2, "correct");
    },
  };
  const dependencies: PipelineDependencies = {
    ...defaultPipelineDependencies({ jevClient }),
    prepareReview: async (reviewContext) => ({
      context: reviewContext,
      mergeBase: repo.baseSha,
      changedPaths: repo.changedPaths,
      workspace: repo.root,
    }),
    produceFindings: async (prepared) => ({
      findings,
      rejected: [],
      canaryPresent: true,
      stagingDir: "/nonexistent-staging",
      exit: { kind: "exit", code: 0, signal: null, stdoutTail: "", stderrTail: "" },
      skillCriteria: { name: prepared.context.skill, criteria: "Report concrete defects only." },
    }),
    publishFindings: (stage) =>
      publishFindings(stage, {
        verifyHead: async () => undefined,
        postComment: async () => ({ id: 4242, url: "https://github.com/example/repo/pull/1#discussion_r4242" }),
      }),
  };

  const result = await run(env, dependencies);
  assert.equal(result.code, 0);
  assert.deepEqual(observed, ["Real defect", "Style nit"], "findings are validated in order");

  const resultFile = JSON.parse(readFileSync(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8")) as {
    status: string;
    counts: Record<string, number>;
    publishables: Array<{ findingId: string; path: string; payload: { commit_id: string }; stage: string; commentId: number | null }>;
    findings: Array<{
      id: string;
      stage: string;
      reason: { code: string; message: string } | null;
      transitions: unknown[];
      retryUsed: boolean;
    }>;
  };
  assert.equal(resultFile.status, "success");
  assert.deepEqual(resultFile.counts, { accepted: 2, publishable: 1, published: 1, skipped: 1, deduped: 0 });
  assert.equal(resultFile.publishables.length, 1);
  assert.equal(resultFile.publishables[0]?.findingId, "00000000-0000-4000-8000-000000000011");
  assert.equal(resultFile.publishables[0]?.payload.commit_id, repo.headSha);
  assert.equal(resultFile.publishables[0]?.stage, "posted");
  assert.equal(resultFile.publishables[0]?.commentId, 4242);
  assert.equal(resultFile.findings[0]?.stage, "publishable");
  assert.deepEqual(resultFile.findings[0]?.transitions, [
    { stage: "accepted" },
    { stage: "resolved" },
    { stage: "validated" },
    { stage: "publishable" },
    { stage: "posted" },
  ]);
  assert.equal(resultFile.findings[1]?.stage, "skipped");
  assert.equal(resultFile.findings[1]?.reason?.code, "below_comment_worthy");
  assert.equal(resultFile.findings[1]?.reason?.message, gateSkipMessages.below_comment_worthy);
  assert.deepEqual(resultFile.findings[1]?.transitions, [
    { stage: "accepted" },
    { stage: "resolved" },
    { stage: "validated" },
    { stage: "skipped" },
  ]);

  const outputs = readFileSync(env["GITHUB_OUTPUT"]!, "utf8");
  assert.ok(outputs.includes("publishable-count=1"));
  assert.ok(outputs.includes("skipped-count=1"));
});
