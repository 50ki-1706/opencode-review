// Manual live smoke for the Phase 2 producer. NOT part of the unit suite:
// the file name does not match the Node test-runner patterns and it needs a
// real OpenCode CLI plus provider network access.
//
// Run with the pinned toolchain:
//   vp env exec node test/live/live-smoke.ts
//
// Environment:
//   OPENCODE_CLI       path to the pinned @opencode/cli binary
//   LIVE_MODEL         provider/model (default: opencode/space-bunny-free)
//   LIVE_TIMEOUT_MS    producer timeout (default: 300000)
//
// The harness keeps staging artifacts to print the raw findings.ndjson, then
// removes them itself; the automatic cleanup path is covered by unit tests.
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFindingProducer, type PreparedReview } from "../../src/opencode.ts";
import { createFixtureRepo } from "../helpers/git-fixture.ts";

const pinnedCli = "/private/var/folders/_d/vk9xglzd6vnfs_xx64xspf7r0000gn/T/opencode/p0-verify/cli/node_modules/.bin/opencode";
const cliPath = process.env["OPENCODE_CLI"] ?? pinnedCli;
const model = process.env["LIVE_MODEL"] ?? "opencode/space-bunny-free";
const timeoutMs = Number.parseInt(process.env["LIVE_TIMEOUT_MS"] ?? "300000", 10);
const runnerTemp = process.env["RUNNER_TEMP"] ?? tmpdir();

const repo = await createFixtureRepo();
const prepared: PreparedReview = {
  context: {
    repository: "example/live-smoke",
    pullNumber: 1,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    skill: "fixture-skill",
    model,
    thresholds: { supported: 0.7, commentWorthy: 0.6 },
    limits: { timeoutSeconds: Math.ceil(timeoutMs / 1000), maxFindings: 5 },
  },
  mergeBase: repo.baseSha,
  changedPaths: repo.changedPaths,
  workspace: repo.root,
};

console.log(`live smoke: cli=${cliPath} model=${model} head=${repo.headSha}`);
let stagingDir: string | null = null;
try {
  const outcome = await runFindingProducer({
    runnerTemp,
    prepared,
    model,
    timeoutMs,
    maxFindings: 5,
    parentEnv: process.env,
    cliPath,
    keepArtifacts: true,
  });
  stagingDir = outcome.stagingDir;
  console.log(JSON.stringify({
    exit: outcome.exit.kind,
    exitCode: outcome.exit.code,
    canaryPresent: outcome.canaryPresent,
    findings: outcome.findings,
    rejected: outcome.rejected,
  }, null, 2));
  const ndjson = await readFile(join(outcome.stagingDir, "findings.ndjson"), "utf8");
  console.log("--- findings.ndjson ---");
  console.log(ndjson.trim().length > 0 ? ndjson.trim() : "(empty)");
  console.log("--- stderr tail (redacted sizes only) ---");
  console.log(`stderr tail bytes: ${Buffer.byteLength(outcome.exit.stderrTail, "utf8")}`);
} finally {
  if (stagingDir) {
    await rm(stagingDir, { recursive: true, force: true });
    console.log(`cleanup: removed ${stagingDir}`);
  }
  await rm(repo.root, { recursive: true, force: true });
}
