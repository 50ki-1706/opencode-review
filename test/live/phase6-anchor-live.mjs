// Manual live harness for the Phase 6 anchor-verbatim prompt check. NOT part of
// the unit suite: the file name does not match the Node test-runner patterns,
// and it needs the pinned OpenCode CLI plus provider network access.
//
// Run with the pinned toolchain:
//   vp env exec node test/live/phase6-anchor-live.mjs
//
// Environment:
//   OPENCODE_CLI     path to the pinned @opencode/cli binary
//   LIVE_MODEL       provider/model (default: opencode/space-bunny-free)
//   LIVE_TIMEOUT_MS  producer timeout (default: 300000)
//
// The fixture mirrors the Phase 5 scratch PR head (increment returns n-1, NaN
// clamp returns min) plus the off-by-one skill. Everything is a local git
// fixture: nothing is posted. Findings from the real model are then passed
// through the production Range Resolver (verifyHead is a no-op for the local
// fixture) so a "resolved" outcome proves the anchor matched HEAD byte-for-byte.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFindingProducer } from "../../src/opencode.ts";
import { resolveFindings } from "../../src/range.ts";

const pinnedCli = "/private/var/folders/_d/vk9xglzd6vnfs_xx64xspf7r0000gn/T/opencode/p0-verify/cli/node_modules/.bin/opencode";
const cliPath = process.env["OPENCODE_CLI"] ?? pinnedCli;
const model = process.env["LIVE_MODEL"] ?? "opencode/space-bunny-free";
const timeoutMs = Number.parseInt(process.env["LIVE_TIMEOUT_MS"] ?? "300000", 10);
const runnerTemp = process.env["RUNNER_TEMP"] ?? tmpdir();

const skillMd = `---
name: off-by-one
description: Review arithmetic and boundary conditions for off-by-one and incorrect-operator defects.
---

# Off-by-one and incorrect-operator review

Review only the lines changed by this pull request. Report only concrete code defects where
arithmetic, comparison, or boundary conditions are wrong, such as:

- an operator that produces the wrong direction or magnitude
- a loop or range bound that includes or excludes one element incorrectly
- a boundary or special-value (for example NaN) branch that returns the wrong result

Do not report style preferences, naming, or speculation without a concrete trigger and impact.
`;

const counterBase = `export function increment(n: number): number {
  return n + 1;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
`;

const counterHead = `export function increment(n: number): number {
  return n - 1;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  if (value !== value) {
    return min;
  }
  return value;
}
`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message}`);
  }
  return result.stdout.trim();
}

const root = await mkdtemp(join(tmpdir(), "opencode-review-anchor-"));
try {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "fixture");
  await mkdir(join(root, ".opencode", "skills", "off-by-one"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".opencode", "skills", "off-by-one", "SKILL.md"), skillMd, "utf8");
  await writeFile(join(root, "src", "counter.ts"), counterBase, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "src", "counter.ts"), counterHead, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const headSha = git(root, "rev-parse", "HEAD");

  const prepared = {
    context: {
      repository: "example/phase6-anchor",
      pullNumber: 1,
      baseSha,
      headSha,
      skill: "off-by-one",
      model,
      thresholds: { supported: 0.7, commentWorthy: 0.6 },
      limits: { timeoutSeconds: Math.ceil(timeoutMs / 1000), maxFindings: 5 },
    },
    mergeBase: baseSha,
    changedPaths: ["src/counter.ts"],
    workspace: root,
  };

  console.log(`phase6 anchor live: cli=${cliPath} model=${model} head=${headSha}`);
  const outcome = await runFindingProducer({
    runnerTemp,
    prepared,
    model,
    timeoutMs,
    maxFindings: 5,
    parentEnv: process.env,
    cliPath,
    keepArtifacts: false,
  });

  const resolutions = await resolveFindings(
    { workspace: root, mergeBase: baseSha, headSha, changedPaths: ["src/counter.ts"], findings: outcome.findings },
    { verifyHead: async () => undefined },
  );

  const resolved = resolutions.filter((resolution) => resolution.kind === "resolved");
  const skipped = resolutions.filter((resolution) => resolution.kind === "skipped");
  console.log(
    JSON.stringify(
      {
        exit: outcome.exit.kind,
        exitCode: outcome.exit.code,
        canaryPresent: outcome.canaryPresent,
        counts: { findings: outcome.findings.length, resolved: resolved.length, skipped: skipped.length },
        findings: outcome.findings.map((finding) => ({
          path: finding.path,
          candidateRange: finding.candidateRange,
          severity: finding.severity,
          title: finding.title,
        })),
        resolutions: resolutions.map((resolution) =>
          resolution.kind === "resolved"
            ? { kind: resolution.kind, path: resolution.range.path, startLine: resolution.range.startLine, endLine: resolution.range.endLine, anchorStartLine: resolution.range.anchorStartLine, code: resolution.range.code }
            : { kind: resolution.kind, path: resolution.finding.path, reason: resolution.reason, message: resolution.message },
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
