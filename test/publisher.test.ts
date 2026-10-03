// Phase 5 publisher integration tests. The GitHub side is a local HTTP mock
// (test/helpers/github-mock.ts); range resolution is real git; Jev is an
// injected deterministic client; the producer is a fake dependency. The
// pipeline under test is the production one wired by defaultPipelineDependencies.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  dedupePublishables,
  defaultPipelineDependencies,
  duplicateFindingMessage,
  publishFindings,
  run,
  type PipelineDependencies,
  type RunResult,
} from "../src/main.ts";
import { HeadChangedError, buildInlinePayload } from "../src/github.ts";
import type { Finding, PublishableFinding, ReviewContext } from "../src/finding.ts";
import type { JevClient, JevValidateInput, JevValidationOutcome } from "../src/jev.ts";
import type { PreparedReview, ProducerOutcome } from "../src/opencode.ts";
import { createRangeRepo, type RangeFixtureRepo } from "./helpers/range-fixture.ts";
import { githubMockServer, type GitHubMock, type MockRequest, type MockResponse } from "./helpers/github-mock.ts";

type Env = Record<string, string | undefined>;

const CHANGED_PATH = "src/example.ts";
const STALE_SHA = "f".repeat(40);

const BASE_FILE = [
  "export function increment(n: number): number {",
  "  return n + 1;",
  "}",
  "",
  "export function clamp(value: number, min: number, max: number): number {",
  "  if (value < min) {",
  "    return min;",
  "  }",
  "  if (value > max) {",
  "    return max;",
  "  }",
  "  return value;",
  "}",
  "",
].join("\n");

// Two planted defects in separate hunks: a single-line changed operator
// (line 2) and a three-line added block (lines 12-14).
const HEAD_FILE = [
  "export function increment(n: number): number {",
  "  return n - 1;",
  "}",
  "",
  "export function clamp(value: number, min: number, max: number): number {",
  "  if (value < min) {",
  "    return min;",
  "  }",
  "  if (value > max) {",
  "    return max;",
  "  }",
  "  if (value !== value) {",
  "    return min;",
  "  }",
  "  return value;",
  "}",
  "",
].join("\n");

const SINGLE_ID = "00000000-0000-4000-8000-000000000101";
const MULTI_ID = "00000000-0000-4000-8000-000000000102";
const DUPLICATE_ID = "00000000-0000-4000-8000-000000000103";
const LOW_ID = "00000000-0000-4000-8000-000000000104";

function singleFinding(id: string): Finding {
  return {
    id,
    skill: "fixture-skill",
    path: CHANGED_PATH,
    candidateRange: { start: 2, end: 2, anchor: "  return n - 1;" },
    severity: "high",
    title: "Increment decrements",
    body: "The increment helper now subtracts one.",
  };
}

function multiFinding(id: string): Finding {
  return {
    id,
    skill: "fixture-skill",
    path: CHANGED_PATH,
    candidateRange: {
      start: 12,
      end: 14,
      anchor: "  if (value !== value) {\n    return min;\n  }",
    },
    severity: "medium",
    title: "NaN clamps to min",
    body: "NaN is silently clamped to min instead of propagating.",
  };
}

function lowFinding(id: string): Finding {
  return {
    id,
    skill: "fixture-skill",
    path: CHANGED_PATH,
    candidateRange: { start: 2, end: 2, anchor: "  return n - 1;" },
    severity: "low",
    title: "Naming preference",
    body: "A style preference without a concrete defect.",
  };
}

async function repoFixture(t: TestContext): Promise<RangeFixtureRepo> {
  const repo = await createRangeRepo({
    base: [{ path: CHANGED_PATH, content: BASE_FILE }],
    head: [{ path: CHANGED_PATH, content: HEAD_FILE }],
  });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  return repo;
}

async function publisherEnv(t: TestContext, headSha: string): Promise<Env> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-review-publisher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "opened",
      number: 1,
      pull_request: {
        draft: false,
        head: { sha: headSha, repo: { full_name: "example/repo" } },
        base: { sha: "b".repeat(40) },
      },
      repository: { full_name: "example/repo", private: true },
    }),
  );
  return {
    "INPUT_SKILL": "fixture-skill",
    "INPUT_MODEL": "opencode/space-bunny-free",
    "INPUT_DRY-RUN": "false",
    "INPUT_GITHUB-TOKEN": "ghp_fixture_token_1234567890",
    "INPUT_JEV-MODEL": "jev-1.13-free",
    "INPUT_SUPPORTED-THRESHOLD": "0.7",
    "INPUT-COMMENT-WORTHY-THRESHOLD": "0.6",
    "INPUT_TIMEOUT-SECONDS": "30",
    "INPUT_MAX-FINDINGS": "10",
    "JEV_API_KEY": "jev_fixture_token_1234567890",
    GITHUB_EVENT_PATH: eventPath,
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "output.txt"),
    GITHUB_REPOSITORY: "example/repo",
  };
}

function prBody(repo: RangeFixtureRepo): MockResponse["body"] {
  return {
    number: 1,
    state: "open",
    draft: false,
    head: { sha: repo.headSha, ref: "feature", repo: { full_name: "example/repo" } },
    base: { sha: repo.baseSha },
  };
}

function headOk(repo: RangeFixtureRepo): (request: MockRequest) => MockResponse | null {
  return (request) => {
    if (request.method === "GET" && request.path === "/repos/example/repo/pulls/1") {
      return { status: 200, body: prBody(repo) };
    }
    return null;
  };
}

function route(parts: Array<(request: MockRequest) => MockResponse | null>): (request: MockRequest) => MockResponse {
  return (request) => {
    for (const part of parts) {
      const response = part(request);
      if (response !== null) {
        return response;
      }
    }
    return { status: 500, body: { message: "unexpected mock request" } };
  };
}

function postRoute(handler: (request: MockRequest) => MockResponse): (request: MockRequest) => MockResponse | null {
  return (request) => (request.method === "POST" && request.path === "/repos/example/repo/pulls/1/comments" ? handler(request) : null);
}

type ResultFile = {
  status: string;
  dryRun: boolean;
  counts: { accepted: number; publishable: number; published: number; skipped: number; deduped: number };
  dedup: { count: number; entries: Array<{ findingId: string; duplicateOf: string }> };
  publish: {
    failure:
      | null
      | { class: string; step: string; findingId: string; message: string; fields: string[]; ambiguous: boolean };
  };
  publishables: Array<{
    findingId: string;
    path: string;
    startLine: number;
    endLine: number;
    stage: string;
    commentId: number | null;
    url: string | null;
    ambiguous: boolean;
    payload: {
      commit_id: string;
      path: string;
      line: number;
      side: string;
      start_line?: number;
      start_side?: string;
      body: string;
    };
  }>;
  findings: Array<{
    id: string;
    stage: string;
    transitions: Array<{ stage: string }>;
    reason: { code: string; message: string } | null;
    range: { startLine: number; endLine: number } | null;
    publish: { stage: string; commentId: number | null; url: string | null; ambiguous: boolean } | null;
    duplicateOf?: string;
  }>;
};

type RunFixture = {
  repo: RangeFixtureRepo;
  mock: GitHubMock;
  env: Env;
  jevCalls: JevValidateInput[];
  execute: () => Promise<RunResult>;
  resultFile: () => Promise<ResultFile>;
  outputs: () => Promise<string>;
};

async function createRun(
  t: TestContext,
  repo: RangeFixtureRepo,
  findings: Finding[],
  mockRoute: (request: MockRequest) => MockResponse,
  options: { dryRun?: boolean; jevAnswer?: (finding: Finding) => JevValidationOutcome } = {},
): Promise<RunFixture> {
  const mock = await githubMockServer(t, mockRoute);
  const env = await publisherEnv(t, repo.headSha);
  if (options.dryRun === true) {
    env["INPUT_DRY-RUN"] = "true";
  }
  const jevCalls: JevValidateInput[] = [];
  const jevClient: JevClient = {
    model: "jev-1.13-free",
    async validateFinding(input) {
      jevCalls.push(input);
      if (options.jevAnswer) {
        return options.jevAnswer(input.finding);
      }
      return {
        kind: "validated",
        validation: { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct" },
        stateLevel: 0,
        model: "jev-1.13-free",
      };
    },
  };
  const context: ReviewContext = {
    repository: "example/repo",
    pullNumber: 1,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    skill: "fixture-skill",
    model: "opencode/space-bunny-free",
    thresholds: { supported: 0.7, commentWorthy: 0.6 },
    limits: { timeoutSeconds: 30, maxFindings: 10 },
  };
  const prepared: PreparedReview = {
    context,
    mergeBase: repo.baseSha,
    changedPaths: [CHANGED_PATH],
    workspace: repo.root,
  };
  const dependencies: PipelineDependencies = {
    ...defaultPipelineDependencies({ jevClient, githubBaseUrl: mock.baseUrl }),
    prepareReview: async () => prepared,
    produceFindings: async (): Promise<ProducerOutcome> => ({
      findings,
      rejected: [],
      canaryPresent: true,
      stagingDir: "/nonexistent-staging",
      exit: { kind: "exit", code: 0, signal: null, stdoutTail: "", stderrTail: "" },
      skillCriteria: { name: "fixture-skill", criteria: "Report concrete defects only." },
    }),
  };
  return {
    repo,
    mock,
    env,
    jevCalls,
    execute: () => run(env, dependencies),
    resultFile: async () =>
      JSON.parse(await readFile(join(env["RUNNER_TEMP"]!, "review-result.json"), "utf8")) as ResultFile,
    outputs: () => readFile(env["GITHUB_OUTPUT"]!, "utf8"),
  };
}

function publishableFor(repo: { headSha: string }, finding: Finding, startLine: number, endLine: number): PublishableFinding {
  return {
    id: finding.id,
    skill: finding.skill,
    path: finding.path,
    commitId: repo.headSha,
    startLine,
    endLine,
    side: "RIGHT",
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
  };
}

// --- Unit level ------------------------------------------------------------

test("dedupePublishables keeps the first exact duplicate and preserves order", () => {
  const repo = { headSha: "a".repeat(40) };
  const first = publishableFor(repo, singleFinding(SINGLE_ID), 2, 2);
  const duplicate = { ...publishableFor(repo, singleFinding(DUPLICATE_ID), 2, 2) };
  const multi = publishableFor(repo, multiFinding(MULTI_ID), 12, 14);
  const nearly = { ...first, id: LOW_ID, body: `${first.body} ` };
  const result = dedupePublishables([first, duplicate, multi, nearly]);
  assert.deepEqual(result.unique.map((finding) => finding.id), [SINGLE_ID, MULTI_ID, LOW_ID]);
  assert.deepEqual(result.duplicates, [{ finding: duplicate, duplicateOf: SINGLE_ID }]);
});

test("dedupePublishables treats a different resolved range as a different finding", () => {
  const repo = { headSha: "a".repeat(40) };
  const oneLine = publishableFor(repo, singleFinding(SINGLE_ID), 2, 2);
  const sameClaimWider = publishableFor(repo, singleFinding(DUPLICATE_ID), 2, 3);
  const result = dedupePublishables([oneLine, sameClaimWider]);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test("publishFindings re-checks HEAD before every post and stops on a moved head", async () => {
  const context: ReviewContext = {
    repository: "example/repo",
    pullNumber: 1,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    skill: "fixture-skill",
    model: "opencode/space-bunny-free",
    thresholds: { supported: 0.7, commentWorthy: 0.6 },
    limits: { timeoutSeconds: 30, maxFindings: 10 },
  };
  const repo = { headSha: context.headSha };
  const publishables = [
    publishableFor(repo, singleFinding(SINGLE_ID), 2, 2),
    publishableFor(repo, multiFinding(MULTI_ID), 12, 14),
  ];
  let headChecks = 0;
  const payloads: unknown[] = [];
  const outcome = await publishFindings(
    { context, publishables, token: "token", dryRun: false },
    {
      verifyHead: async () => {
        headChecks += 1;
        if (headChecks === 2) {
          throw new HeadChangedError(context.headSha, STALE_SHA);
        }
      },
      postComment: async (payload) => {
        payloads.push(payload);
        return { id: 99, url: "https://example.invalid/99" };
      },
    },
  );
  assert.equal(headChecks, 2, "one check before each attempted post");
  assert.equal(payloads.length, 1, "the second post is never attempted");
  assert.equal(outcome.posted, 1);
  assert.equal(outcome.entries[0]?.stage, "posted");
  assert.equal(outcome.entries[0]?.commentId, 99);
  assert.equal(outcome.entries[1]?.stage, "unposted");
  assert.equal(outcome.entries[1]?.commentId, null);
  assert.equal(outcome.failure?.class, "mid-run failure");
  assert.equal(outcome.failure?.step, "head_recheck");
  assert.deepEqual(outcome.failure?.fields, ["head.sha"]);
  assert.equal(outcome.failure?.ambiguous, false);
});

test("publishFindings in dry-run builds the same entries without touching the transport", async () => {
  const context: ReviewContext = {
    repository: "example/repo",
    pullNumber: 1,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    skill: "fixture-skill",
    model: "opencode/space-bunny-free",
    thresholds: { supported: 0.7, commentWorthy: 0.6 },
    limits: { timeoutSeconds: 30, maxFindings: 10 },
  };
  const repo = { headSha: context.headSha };
  const publishables = [publishableFor(repo, singleFinding(SINGLE_ID), 2, 2), publishableFor(repo, multiFinding(MULTI_ID), 12, 14)];
  let transportCalls = 0;
  const outcome = await publishFindings(
    { context, publishables, token: "token", dryRun: true },
    {
      verifyHead: async () => {
        transportCalls += 1;
      },
      postComment: async () => {
        transportCalls += 1;
        return { id: 1, url: "u" };
      },
    },
  );
  assert.equal(transportCalls, 0);
  assert.equal(outcome.posted, 0);
  assert.equal(outcome.failure, null);
  assert.deepEqual(outcome.entries.map((entry) => entry.stage), ["planned", "planned"]);
  assert.deepEqual(outcome.entries[0]?.payload, buildInlinePayload(publishables[0]!));
  assert.deepEqual(outcome.entries[1]?.payload, buildInlinePayload(publishables[1]!));
});

// --- Integration through run() ---------------------------------------------

test("dry-run emits planned payloads and skip reasons, validates everything and never POSTs", async (t) => {
  const repo = await repoFixture(t);
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), multiFinding(MULTI_ID), lowFinding(LOW_ID)],
    route([headOk(repo)]),
    {
      dryRun: true,
      jevAnswer: (finding) =>
        finding.title === "Naming preference"
          ? {
              kind: "validated",
              validation: { supported: 0.95, commentWorthy: 0.2, rangeQuality: "correct" },
              stateLevel: 0,
              model: "jev-1.13-free",
            }
          : {
              kind: "validated",
              validation: { supported: 0.9, commentWorthy: 0.9, rangeQuality: "correct" },
              stateLevel: 0,
              model: "jev-1.13-free",
            },
    },
  );
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  const result = await fixture.execute();
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(fixture.mock.posts().length, 0, "dry-run must never POST");
  assert.equal(fixture.jevCalls.length, 3, "every resolved finding is validated");
  assert.deepEqual(fixture.jevCalls.map((call) => call.finding.id), [SINGLE_ID, MULTI_ID, LOW_ID]);

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.status, "dry_run");
  assert.equal(resultFile.dryRun, true);
  assert.equal(resultFile.publish.failure, null);
  assert.deepEqual(resultFile.counts, { accepted: 3, publishable: 2, published: 0, skipped: 1, deduped: 0 });
  assert.equal(resultFile.publishables.length, 2);
  const singlePayload = resultFile.publishables[0]!.payload;
  const multiPayload = resultFile.publishables[1]!.payload;
  assert.equal(singlePayload.commit_id, repo.headSha);
  assert.equal(singlePayload.path, CHANGED_PATH);
  assert.equal(singlePayload.line, 2);
  assert.equal(singlePayload.side, "RIGHT");
  assert.equal(singlePayload.start_line, undefined);
  assert.equal(singlePayload.body, "[high] Increment decrements\n\nThe increment helper now subtracts one.");
  assert.equal(multiPayload.start_line, 12);
  assert.equal(multiPayload.start_side, "RIGHT");
  assert.equal(multiPayload.line, 14);
  assert.equal(resultFile.publishables[0]!.stage, "planned");
  assert.equal(resultFile.publishables[0]!.commentId, null);
  assert.equal(resultFile.findings[2]!.stage, "skipped");
  assert.equal(resultFile.findings[2]!.reason?.code, "below_comment_worthy");

  const plan = JSON.parse(logs[0]!) as {
    stage: string;
    publishables: Array<{ findingId: string; payload: unknown }>;
    skipped: Array<{ id: string; stage: string; reason: { code: string } | null }>;
  };
  assert.equal(plan.stage, "dry-run");
  assert.deepEqual(plan.publishables[0]!.payload, singlePayload);
  assert.deepEqual(plan.publishables[1]!.payload, multiPayload);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.id, LOW_ID);
  assert.equal(plan.skipped[0]!.stage, "skipped");
  assert.equal(plan.skipped[0]!.reason?.code, "below_comment_worthy");
  assert.equal(logs[0]!.includes(envToken(fixture.env)), false, "stdout must not contain the token");

  const outputs = await fixture.outputs();
  assert.match(outputs, /^accepted-count=3$/m);
  assert.match(outputs, /^publishable-count=2$/m);
  assert.match(outputs, /^published-count=0$/m);
  assert.match(outputs, /^skipped-count=1$/m);
  assert.ok(outputs.endsWith("\n"));
});

function envToken(env: Env): string {
  return env["INPUT_GITHUB-TOKEN"]!;
}

test("publication posts single-line and multi-line payloads with HEAD checked before each", async (t) => {
  const repo = await repoFixture(t);
  let commentId = 7000;
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), multiFinding(MULTI_ID)],
    route([
      headOk(repo),
      postRoute(() => {
        commentId += 1;
        return { status: 201, body: { id: commentId, url: `https://github.com/example/repo/pull/1#discussion_r${commentId}` } };
      }),
    ]),
  );

  const result = await fixture.execute();
  assert.equal(result.code, 0, JSON.stringify(result));

  // Request order proves the HEAD recheck: range verify, pre-post check, post, pre-post check, post.
  assert.deepEqual(
    fixture.mock.requests.map((request) => `${request.method} ${request.path}`),
    [
      "GET /repos/example/repo/pulls/1",
      "GET /repos/example/repo/pulls/1",
      "POST /repos/example/repo/pulls/1/comments",
      "GET /repos/example/repo/pulls/1",
      "POST /repos/example/repo/pulls/1/comments",
    ],
  );
  const posts = fixture.mock.posts();
  assert.deepEqual(posts[0]?.body, buildInlinePayload(publishableFor(repo, singleFinding(SINGLE_ID), 2, 2)));
  assert.deepEqual(posts[1]?.body, buildInlinePayload(publishableFor(repo, multiFinding(MULTI_ID), 12, 14)));
  assert.equal((posts[0]?.headers["content-type"] ?? "").includes("application/json"), true);
  assert.equal((posts[0]?.headers["authorization"] ?? ""), "Bearer ghp_fixture_token_1234567890");

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.status, "success");
  assert.deepEqual(resultFile.counts, { accepted: 2, publishable: 2, published: 2, skipped: 0, deduped: 0 });
  assert.equal(resultFile.publish.failure, null);
  assert.deepEqual(
    resultFile.publishables.map((entry) => ({ stage: entry.stage, id: entry.commentId, line: entry.payload.line })),
    [
      { stage: "posted", id: 7001, line: 2 },
      { stage: "posted", id: 7002, line: 14 },
    ],
  );
  assert.deepEqual(resultFile.findings[0]!.transitions.map((transition) => transition.stage), [
    "accepted",
    "resolved",
    "validated",
    "publishable",
    "posted",
  ]);
  assert.deepEqual(resultFile.findings[0]!.publish, {
    stage: "posted",
    commentId: 7001,
    url: "https://github.com/example/repo/pull/1#discussion_r7001",
    ambiguous: false,
  });

  const outputs = await fixture.outputs();
  assert.match(outputs, /^accepted-count=2$/m);
  assert.match(outputs, /^publishable-count=2$/m);
  assert.match(outputs, /^published-count=2$/m);
  assert.match(outputs, /^skipped-count=0$/m);
  assert.match(outputs, new RegExp(`^result-path=.*review-result\\.json$`, "m"));
});

test("exact duplicates are collapsed before posting and recorded in the result", async (t) => {
  const repo = await repoFixture(t);
  let commentId = 7100;
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), singleFinding(DUPLICATE_ID), multiFinding(MULTI_ID)],
    route([
      headOk(repo),
      postRoute(() => {
        commentId += 1;
        return { status: 201, body: { id: commentId, url: `https://github.com/example/repo/pull/1#discussion_r${commentId}` } };
      }),
    ]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 0);
  assert.equal(fixture.mock.posts().length, 2, "only unique findings are posted");

  const resultFile = await fixture.resultFile();
  assert.deepEqual(resultFile.counts, { accepted: 3, publishable: 2, published: 2, skipped: 1, deduped: 1 });
  assert.deepEqual(resultFile.dedup, { count: 1, entries: [{ findingId: DUPLICATE_ID, duplicateOf: SINGLE_ID }] });
  assert.deepEqual(resultFile.publishables.map((entry) => entry.findingId), [SINGLE_ID, MULTI_ID]);
  const duplicateFinding = resultFile.findings.find((finding) => finding.id === DUPLICATE_ID)!;
  assert.equal(duplicateFinding.stage, "skipped");
  assert.equal(duplicateFinding.reason?.code, "duplicate_finding");
  assert.equal(duplicateFinding.reason?.message, duplicateFindingMessage);
  assert.equal(duplicateFinding.duplicateOf, SINGLE_ID);
  assert.equal(duplicateFinding.publish, null);
  assert.deepEqual(duplicateFinding.transitions.map((transition) => transition.stage), [
    "accepted",
    "resolved",
    "validated",
    "skipped",
  ]);
  const outputs = await fixture.outputs();
  assert.match(outputs, /^publishable-count=2$/m);
  assert.match(outputs, /^published-count=2$/m);
  assert.match(outputs, /^skipped-count=1$/m);
});

test("a moved HEAD before the second post stops the run and records unposted candidates", async (t) => {
  const repo = await repoFixture(t);
  let headChecks = 0;
  let commentId = 7200;
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), multiFinding(MULTI_ID)],
    route([
      (request) => {
        if (request.method === "GET" && request.path === "/repos/example/repo/pulls/1") {
          headChecks += 1;
          // 1st: range verify, 2nd: before post 1, 3rd: before post 2 (stale).
          return { status: 200, body: headChecks >= 3 ? { ...(prBody(repo) as object), head: { sha: STALE_SHA, ref: "feature", repo: { full_name: "example/repo" } } } : prBody(repo) };
        }
        return null;
      },
      postRoute(() => {
        commentId += 1;
        return { status: 201, body: { id: commentId, url: `https://github.com/example/repo/pull/1#discussion_r${commentId}` } };
      }),
    ]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "publisher");
  assert.ok(result.error.message.includes("mid-run failure (head_recheck)"), result.error.message);
  assert.deepEqual(result.error.fields, ["head.sha"]);
  assert.equal(fixture.mock.posts().length, 1, "no post after the head moved");

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.status, "publisher_error");
  assert.deepEqual(resultFile.counts, { accepted: 2, publishable: 2, published: 1, skipped: 0, deduped: 0 });
  assert.equal(resultFile.publish.failure?.step, "head_recheck");
  assert.equal(resultFile.publish.failure?.ambiguous, false);
  assert.equal(resultFile.publishables[0]!.stage, "posted");
  assert.equal(resultFile.publishables[0]!.commentId, 7201);
  assert.equal(resultFile.publishables[1]!.stage, "unposted");
  assert.equal(resultFile.publishables[1]!.commentId, null);

  const outputs = await fixture.outputs();
  assert.match(outputs, /^published-count=1$/m);
  assert.match(outputs, /^publishable-count=2$/m);
});

test("a 403 mid-run stops remaining posts and keeps the successful comment id", async (t) => {
  const repo = await repoFixture(t);
  let posts = 0;
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), multiFinding(MULTI_ID)],
    route([
      headOk(repo),
      postRoute(() => {
        posts += 1;
        if (posts === 2) {
          return { status: 403, body: { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com" } };
        }
        return { status: 201, body: { id: 7301, url: "https://github.com/example/repo/pull/1#discussion_r7301" } };
      }),
    ]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "publisher");
  assert.ok(result.error.message.includes("403"), result.error.message);
  assert.ok(result.error.message.includes("Resource not accessible by integration"));
  assert.equal(fixture.mock.posts().length, 2, "the failing post is not retried");

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.status, "publisher_error");
  assert.equal(resultFile.publish.failure?.step, "post");
  assert.equal(resultFile.publish.failure?.ambiguous, false);
  assert.deepEqual(resultFile.publish.failure?.fields, ["message", "documentation_url"]);
  assert.equal(resultFile.publishables[0]!.stage, "posted");
  assert.equal(resultFile.publishables[0]!.commentId, 7301);
  assert.equal(resultFile.publishables[1]!.stage, "unposted");
  assert.equal(resultFile.publishables[1]!.commentId, null);
});

test("a 422 range failure stops with the GitHub validation body", async (t) => {
  const repo = await repoFixture(t);
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID)],
    route([
      headOk(repo),
      postRoute(() => ({
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ resource: "PullRequestReviewComment", code: "custom", field: "line", message: "line must be part of the diff" }],
          documentation_url: "https://docs.github.com/rest/pulls/comments",
        },
      })),
    ]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "publisher");
  assert.ok(result.error.message.includes("422"), result.error.message);
  assert.ok(result.error.message.includes("Validation Failed"));
  assert.equal(fixture.mock.posts().length, 1);

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.publish.failure?.step, "post");
  assert.equal(resultFile.publish.failure?.ambiguous, false);
  assert.deepEqual(resultFile.publish.failure?.fields, ["message", "documentation_url", "errors"]);
  assert.equal(resultFile.publishables[0]!.stage, "unposted");
  assert.equal(resultFile.counts.published, 0);
});

test("an ambiguous post failure is never resent and is flagged for the operator", async (t) => {
  const repo = await repoFixture(t);
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID), multiFinding(MULTI_ID)],
    route([headOk(repo), postRoute(() => ({ status: 0, destroy: true }))]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "publisher");
  assert.ok(result.error.message.includes("mid-run failure (post)"), result.error.message);
  assert.equal(fixture.mock.posts().length, 1, "an ambiguous post is never resent");

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.publish.failure?.ambiguous, true);
  assert.equal(resultFile.publishables[0]!.stage, "unposted");
  assert.equal(resultFile.publishables[0]!.ambiguous, true);
  assert.equal(resultFile.publishables[1]!.stage, "unposted");
  assert.equal(resultFile.counts.published, 0);
});

test("an invalid 201 body is a failure without resending", async (t) => {
  const repo = await repoFixture(t);
  const fixture = await createRun(
    t,
    repo,
    [singleFinding(SINGLE_ID)],
    route([headOk(repo), postRoute(() => ({ status: 201, body: { message: "created" } }))]),
  );
  const result = await fixture.execute();
  assert.equal(result.code, 1);
  if (result.code !== 1) {
    return;
  }
  assert.equal(result.error.stage, "publisher");
  assert.ok(result.error.message.includes("unexpected inline comment response shape"), result.error.message);
  assert.equal(fixture.mock.posts().length, 1);

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.publish.failure?.ambiguous, false);
  assert.equal(resultFile.publishables[0]!.stage, "unposted");
  assert.equal(resultFile.counts.published, 0);
});

test("zero findings is a success with zero published and written outputs", async (t) => {
  const repo = await repoFixture(t);
  const fixture = await createRun(t, repo, [], route([headOk(repo)]));
  const result = await fixture.execute();
  assert.equal(result.code, 0);
  assert.equal(fixture.mock.posts().length, 0);

  const resultFile = await fixture.resultFile();
  assert.equal(resultFile.status, "success");
  assert.equal(resultFile.dryRun, false, "a publish run with zero findings is not a dry-run");
  assert.deepEqual(resultFile.counts, { accepted: 0, publishable: 0, published: 0, skipped: 0, deduped: 0 });
  assert.deepEqual(resultFile.publishables, []);
  assert.deepEqual(resultFile.findings, []);
  assert.equal(resultFile.publish.failure, null);

  const outputs = await fixture.outputs();
  const lines = outputs.trimEnd().split("\n");
  assert.equal(lines.length, 5);
  const names = lines.map((line) => line.split("=", 1)[0]);
  assert.deepEqual(names, ["accepted-count", "publishable-count", "published-count", "skipped-count", "result-path"]);
  assert.ok(lines.every((line) => /^[a-z-]+=.*$/.test(line)));
  assert.match(outputs, /^accepted-count=0$/m);
  assert.match(outputs, /^publishable-count=0$/m);
  assert.match(outputs, /^published-count=0$/m);
  assert.match(outputs, /^skipped-count=0$/m);
  assert.match(outputs, /^result-path=.*review-result\.json$/m);
});
