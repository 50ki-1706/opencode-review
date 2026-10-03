import assert from "node:assert/strict";
import { stat, readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ReviewRunError,
  applyWorkspaceExclusions,
  crossCheckChangedPaths,
  extractHeadArchive,
  parseNameStatusZ,
  prepareReviewContext,
  runFindingProducer,
  runOpenCodeSession,
  type OpenCodeCommand,
  type PreparedReview,
  type ProducerOptions,
} from "../src/opencode.ts";
import { createFixtureRepo, fixtureContext, fixturePrInfo } from "./helpers/git-fixture.ts";

const fakeCliPath = new URL("./helpers/fake-opencode.mjs", import.meta.url).pathname;

function fakeCommandWith(flags: Record<string, string> = {}): OpenCodeCommand {
  return {
    command: process.execPath,
    args: [fakeCliPath, ...Object.entries(flags).map(([key, value]) => `--fake-${key}=${value}`)],
  };
}

const fakeCommand = fakeCommandWith();

async function tempDir(t: TestContext, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sessionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin",
    ...overrides,
  };
}

test("runOpenCodeSession captures exit code and bounded stderr", async (t) => {
  const directory = await tempDir(t, "opencode-review-session-");
  const outcome = await runOpenCodeSession({
    command: fakeCommandWith({ stderr: "exploded for the test" }),
    cwd: directory,
    env: sessionEnv(),
    timeoutMs: 10_000,
  });
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.code, 0);
  assert.ok(outcome.stderrTail.includes("exploded for the test"));
});

test("runOpenCodeSession reports a non-zero exit code", async (t) => {
  const directory = await tempDir(t, "opencode-review-session-");
  const outcome = await runOpenCodeSession({
    command: fakeCommandWith({ exit: "3" }),
    cwd: directory,
    env: sessionEnv(),
    timeoutMs: 10_000,
  });
  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.code, 3);
});

test("a timed-out child is terminated and classified as timeout", async (t) => {
  const directory = await tempDir(t, "opencode-review-session-");
  const started = Date.now();
  const outcome = await runOpenCodeSession({
    command: fakeCommandWith({ mode: "hang" }),
    cwd: directory,
    env: sessionEnv(),
    timeoutMs: 150,
    killGraceMs: 150,
  });
  assert.equal(outcome.kind, "timeout");
  assert.ok(Date.now() - started < 5000, "the KILL fallback must end the session promptly");
});

test("an aborted child is classified as cancelled", async (t) => {
  const directory = await tempDir(t, "opencode-review-session-");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const outcome = await runOpenCodeSession({
    command: fakeCommandWith({ mode: "sleep", sleep: "10000" }),
    cwd: directory,
    env: sessionEnv(),
    timeoutMs: 10_000,
    signal: controller.signal,
    killGraceMs: 150,
  });
  assert.equal(outcome.kind, "cancelled");
});

test("a missing binary is classified as spawn-error", async (t) => {
  const directory = await tempDir(t, "opencode-review-session-");
  const outcome = await runOpenCodeSession({
    command: { command: "/nonexistent/opencode-binary-for-tests", args: ["run"] },
    cwd: directory,
    env: sessionEnv(),
    timeoutMs: 1000,
  });
  assert.equal(outcome.kind, "spawn-error");
});

test("parseNameStatusZ splits status records including renames", () => {
  assert.deepEqual(parseNameStatusZ("M\0src/a.ts\0A\0src/b.ts\0"), [
    { status: "M", path: "src/a.ts" },
    { status: "A", path: "src/b.ts" },
  ]);
  assert.deepEqual(parseNameStatusZ("R100\0old.ts\0new.ts\0"), [
    { status: "R100", path: "new.ts", previousPath: "old.ts" },
  ]);
  assert.throws(() => parseNameStatusZ("R100\0old.ts\0"));
});

test("crossCheckChangedPaths normalizes GitHub renames against local add+delete", () => {
  const ok = crossCheckChangedPaths(
    [
      { status: "A", path: "new.ts" },
      { status: "D", path: "old.ts" },
    ],
    [{ filename: "new.ts", status: "renamed", previous_filename: "old.ts" }],
  );
  assert.deepEqual(ok, { ok: true, paths: ["new.ts"] });
  const mismatch = crossCheckChangedPaths(
    [{ status: "M", path: "a.ts" }],
    [{ filename: "b.ts", status: "modified" }],
  );
  assert.equal(mismatch.ok, false);
});

test("prepareReviewContext verifies the live head, workspace and changed paths", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const prepared = await prepareReviewContext(
    { context: fixtureContext(repo), token: "token", workspace: repo.root },
    {
      getPullRequest: async () => fixturePrInfo(repo),
      listChangedFiles: async () => [{ filename: "counter.ts", status: "modified" }],
    },
  );
  assert.equal(prepared.mergeBase, repo.baseSha);
  assert.deepEqual(prepared.changedPaths, ["counter.ts"]);
  assert.equal(prepared.workspace, repo.root);
});

test("prepareReviewContext fails when the live head moved", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await assert.rejects(
    prepareReviewContext(
      { context: fixtureContext(repo), token: "token", workspace: repo.root },
      {
        getPullRequest: async () => ({ ...fixturePrInfo(repo), head: { ...fixturePrInfo(repo).head, sha: "f".repeat(40) } }),
        listChangedFiles: async () => [{ filename: "counter.ts", status: "modified" }],
      },
    ),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "head_changed",
  );
});

test("prepareReviewContext fails when GitHub and local changed path sets differ", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await assert.rejects(
    prepareReviewContext(
      { context: fixtureContext(repo), token: "token", workspace: repo.root },
      {
        getPullRequest: async () => fixturePrInfo(repo),
        listChangedFiles: async () => [{ filename: "other.ts", status: "modified" }],
      },
    ),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "changed_paths",
  );
});

test("prepareReviewContext fails when the workspace is not at the PR head", async (t) => {
  const repo = await createFixtureRepo();
  const other = await tempDir(t, "opencode-review-other-");
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await assert.rejects(
    prepareReviewContext(
      { context: fixtureContext(repo), token: "token", workspace: other },
      {
        getPullRequest: async () => fixturePrInfo(repo),
        listChangedFiles: async () => [{ filename: "counter.ts", status: "modified" }],
      },
    ),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "workspace",
  );
});

test("extractHeadArchive strips PR runtime config and .env files after extraction", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const destination = await tempDir(t, "opencode-review-workspace-");
  await extractHeadArchive({ workspace: repo.root, headSha: repo.headSha, destDir: destination });
  await applyWorkspaceExclusions(destination);
  const entries = (await readdir(destination, { recursive: true })).sort();
  assert.ok(entries.includes("counter.ts"));
  assert.ok(entries.includes("AGENTS.md"), "AGENTS.md stays: project config discovery is disabled by env");
  assert.ok(!entries.some((entry) => entry.startsWith(".opencode")));
  assert.ok(!entries.includes("opencode.json"));
  assert.ok(!entries.some((entry) => entry.includes(".env")));
});

function producerOptions(
  repo: Awaited<ReturnType<typeof createFixtureRepo>>,
  runnerTemp: string,
  overrides: Partial<ProducerOptions> = {},
): ProducerOptions {
  const prepared: PreparedReview = {
    context: fixtureContext(repo),
    mergeBase: repo.baseSha,
    changedPaths: repo.changedPaths,
    workspace: repo.root,
  };
  return {
    runnerTemp,
    prepared,
    model: "opencode/space-bunny-free",
    timeoutMs: 10_000,
    maxFindings: 10,
    parentEnv: { PATH: process.env["PATH"] ?? "/usr/bin" },
    command: fakeCommand,
    ...overrides,
  };
}

test("runFindingProducer stages, runs, reads canonical findings and cleans up", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  const outcome = await runFindingProducer(producerOptions(repo, runnerTemp));
  assert.equal(outcome.canaryPresent, true);
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]?.skill, "fixture-skill");
  assert.equal(outcome.findings[0]?.severity, "high");
  assert.equal(outcome.rejected.length, 0);
  await assert.rejects(stat(outcome.stagingDir), "staging must be removed after the run");
});

test("runFindingProducer surfaces per-record rejects from the NDJSON file", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  const injected = {
    path: "counter.ts",
    candidateStart: 2,
    candidateEnd: 2,
    anchor: "  return n - 1;",
    severity: "high",
    title: "Injected id",
    body: "Model-controlled fields must be rejected.",
    id: "model-chosen",
  };
  const options = producerOptions(repo, runnerTemp, {
    command: fakeCommandWith({ findings: JSON.stringify([injected]) }),
  });
  const outcome = await runFindingProducer(options);
  assert.equal(outcome.findings.length, 0);
  assert.equal(outcome.rejected.length, 1);
});

test("runFindingProducer keeps staging when keepArtifacts is set", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  const outcome = await runFindingProducer(producerOptions(repo, runnerTemp, { keepArtifacts: true }));
  const entries = await readdir(outcome.stagingDir);
  assert.ok(entries.includes("home"));
  assert.ok(entries.includes("workspace"));
  assert.ok(entries.includes("findings.ndjson"));
  const workspace = await readFile(join(outcome.stagingDir, "workspace", "counter.ts"), "utf8");
  assert.ok(workspace.includes("return n - 1;"));
  const skill = await readFile(
    join(outcome.stagingDir, "home", ".config", "opencode", "skills", "fixture-skill", "SKILL.md"),
    "utf8",
  );
  assert.ok(skill.includes("name: fixture-skill"));
});

test("runFindingProducer refuses a session without the canary marker", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  await assert.rejects(
    runFindingProducer(producerOptions(repo, runnerTemp, { command: fakeCommandWith({ marker: "0" }) })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "config" && error.fields.includes("canary"),
  );
});

test("runFindingProducer never uses leftovers from a failed process", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  await assert.rejects(
    runFindingProducer(producerOptions(repo, runnerTemp, { command: fakeCommandWith({ exit: "42" }) })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "producer" && error.message.includes("42"),
  );
  assert.deepEqual(await readdir(runnerTemp), [], "failed runs must clean their staging");
});

test("runFindingProducer maps a hanging session to a timeout error", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  await assert.rejects(
    runFindingProducer(producerOptions(repo, runnerTemp, {
      timeoutMs: 150,
      killGraceMs: 150,
      command: fakeCommandWith({ mode: "hang" }),
    })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "timeout",
  );
});

test("two consecutive runs use distinct staging directories", async (t) => {
  const repo = await createFixtureRepo();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const runnerTemp = await tempDir(t, "opencode-review-producer-");
  const first = await runFindingProducer(producerOptions(repo, runnerTemp, { keepArtifacts: true }));
  const second = await runFindingProducer(producerOptions(repo, runnerTemp, { keepArtifacts: true }));
  assert.notEqual(first.stagingDir, second.stagingDir);
  assert.equal((await readdir(runnerTemp)).length, 2);
});
