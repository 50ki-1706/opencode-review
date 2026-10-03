// Manual live harness for Phase 5 publication against a real scratch PR.
// NOT part of the unit suite: the file name does not match the Node test-runner
// patterns and it needs the pinned OpenCode CLI plus real GitHub/Jev network.
//
// Run with the pinned toolchain:
//   vp env exec node test/live/phase5-live.mjs
//
// Required environment (values are never printed by this harness):
//   LIVE_REPO            owner/repo of the scratch repository
//   LIVE_PR              pull request number
//   LIVE_WORKSPACE       checkout of the PR head commit
//   LIVE_EVENT           pull_request event JSON path
//   LIVE_RUNNER_TEMP     fresh runner temp directory
//   LIVE_GITHUB_TOKEN    token with repo scope (pass via $(gh auth token))
//   LIVE_DRY_RUN         "true" or "false"
//   OPENCODE_CLI         path to the pinned @opencode/cli binary
//
// Jev: production requires a TypeSafe JEV_API_KEY and this project has none, so
// this harness injects a test-only fetch that STRIPS the Authorization header
// and uses the anonymous jev-1.13-free path (real service, Phase-4 live fact).
// Everything else — event/context validation, OpenCode producer, range
// resolution and GitHub publication — is the production pipeline.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultPipelineDependencies, run } from "../../src/main.ts";
import { createJevClient } from "../../src/jev.ts";

const required = [
  "LIVE_REPO",
  "LIVE_PR",
  "LIVE_WORKSPACE",
  "LIVE_EVENT",
  "LIVE_RUNNER_TEMP",
  "LIVE_GITHUB_TOKEN",
  "LIVE_DRY_RUN",
];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
}

const anonymousJevFetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  return fetch(input, { ...init, headers });
};

const env = {
  ...process.env,
  INPUT_SKILL: "off-by-one",
  INPUT_MODEL: process.env.LIVE_MODEL ?? "opencode/space-bunny-free",
  "INPUT_DRY-RUN": process.env.LIVE_DRY_RUN,
  "INPUT_GITHUB-TOKEN": process.env.LIVE_GITHUB_TOKEN,
  "INPUT_JEV-MODEL": "jev-1.13-free",
  "INPUT_SUPPORTED-THRESHOLD": "0.7",
  "INPUT-COMMENT-WORTHY-THRESHOLD": "0.6",
  "INPUT_TIMEOUT-SECONDS": process.env.LIVE_TIMEOUT_SECONDS ?? "600",
  "INPUT_MAX-FINDINGS": "10",
  JEV_API_KEY: "anonymous-live-harness",
  GITHUB_EVENT_PATH: process.env.LIVE_EVENT,
  RUNNER_TEMP: process.env.LIVE_RUNNER_TEMP,
  GITHUB_OUTPUT: join(process.env.LIVE_RUNNER_TEMP, "output.txt"),
  GITHUB_REPOSITORY: process.env.LIVE_REPO,
  GITHUB_WORKSPACE: process.env.LIVE_WORKSPACE,
};

const jevClient = createJevClient({
  token: "anonymous",
  model: "jev-1.13-free",
  fetchImpl: anonymousJevFetch,
});

const result = await run(env, defaultPipelineDependencies({ jevClient }));
console.log(JSON.stringify({ run: result }));

try {
  const resultFile = JSON.parse(await readFile(join(process.env.LIVE_RUNNER_TEMP, "review-result.json"), "utf8"));
  console.log(
    JSON.stringify(
      {
        status: resultFile.status,
        counts: resultFile.counts,
        dedup: resultFile.dedup,
        publishables: resultFile.publishables.map((entry) => ({
          findingId: entry.findingId,
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          stage: entry.stage,
          commentId: entry.commentId,
          url: entry.url,
          payload: entry.payload,
        })),
        findings: resultFile.findings.map((finding) => ({
          id: finding.id,
          path: finding.path,
          severity: finding.severity,
          title: finding.title,
          stage: finding.stage,
          reason: finding.reason,
          range: finding.range,
          validation: finding.validation,
          jevCalls: finding.jevCalls,
          retryUsed: finding.retryUsed,
          publish: finding.publish,
        })),
        publishFailure: resultFile.publish.failure,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(`result file unavailable: ${error instanceof Error ? error.message : "unknown"}`);
}
