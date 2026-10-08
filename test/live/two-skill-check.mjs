// Deterministic two-skill separation check (phase-6-02). NOT part of the unit
// suite: the file name does not match the Node test-runner patterns. It imports
// the BUILT dist bundle and runs the real `run()` entrypoint twice, sequentially,
// with different skills, different local git fixture repositories, different
// runner temp directories and a deterministic fake producer CLI. A local HTTP
// mock replaces the GitHub API and a stub replaces Jev, so the check is offline
// and reproducible in CI.
//
// Run after `vp run build` with the pinned toolchain:
//   vp env exec node test/live/two-skill-check.mjs
//
// Assertions:
//   - both runs exit 0 and write their own result file (distinct paths);
//   - each result file contains only its own skill and finding title;
//   - the two GITHUB_OUTPUT files are distinct and do not share values;
//   - no staging directory is left behind in either RUNNER_TEMP.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPipelineDependencies, run } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(here, "two-skill-fake-cli.mjs");
await chmod(fakeCli, 0o755);

const baseValue = "export const value = 1;\n";
const headValue = "export const value = 0;\nexport const doubled = value + value;\n";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message}`);
  }
  return result.stdout.trim();
}

async function createSkillFixture(skill) {
  const root = await mkdtemp(join(tmpdir(), `opencode-review-${skill}-`));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "fixture");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".opencode", "skills", skill), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), baseValue, "utf8");
  await writeFile(
    join(root, ".opencode", "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Deterministic fixture skill for separation checks.\n---\nReport only concrete defects.\n`,
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "src", "value.ts"), headValue, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const headSha = git(root, "rev-parse", "HEAD");
  return { root, baseSha, headSha };
}

function startGitHubMock(prByRepo) {
  const requests = [];
  const server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      const path = request.url ?? "/";
      requests.push(`${request.method ?? "GET"} ${path}`);
      const pullMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path);
      if (pullMatch) {
        const repo = `${pullMatch[1]}/${pullMatch[2]}`;
        const pr = prByRepo.get(repo);
        if (!pr) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(pr));
        return;
      }
      if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files/.test(path)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ filename: "src/value.ts", status: "modified" }]));
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `unexpected mock request ${request.method} ${path}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const fakeJev = {
  model: "jev-1.13-free",
  async validateFinding() {
    return {
      kind: "validated",
      validation: { supported: 0.95, commentWorthy: 0.95, rangeQuality: "correct" },
      stateLevel: "L0",
      model: "jev-1.13-free",
    };
  },
};

const skills = ["skill-a", "skill-b"];
const findingTitleBySkill = { "skill-a": "Skill A finding", "skill-b": "Skill B finding" };
const fixtures = new Map();
const prByRepo = new Map();
for (const skill of skills) {
  const fixture = await createSkillFixture(skill);
  const repoFullName = `example/two-skill-check-${skill}`;
  fixtures.set(skill, { ...fixture, repoFullName });
  prByRepo.set(repoFullName, {
    number: 1,
    state: "open",
    draft: false,
    head: { sha: fixture.headSha, ref: "feature", repo: { full_name: repoFullName } },
    base: { sha: fixture.baseSha },
  });
}

const mock = await startGitHubMock(prByRepo);
const results = [];
try {
  for (const [index, skill] of skills.entries()) {
    const fixture = fixtures.get(skill);
    const runnerTemp = await mkdtemp(join(tmpdir(), `opencode-review-runner-${index}-`));
    const outputPath = join(runnerTemp, "output.txt");
    const eventPath = join(runnerTemp, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "opened",
        number: 1,
        pull_request: {
          draft: false,
          head: { sha: fixture.headSha, repo: { full_name: fixture.repoFullName } },
          base: { sha: fixture.baseSha },
        },
        repository: { full_name: fixture.repoFullName },
      }),
      "utf8",
    );
    const env = {
      PATH: process.env.PATH,
      INPUT_SKILL: skill,
      INPUT_MODEL: "fake/model",
      "INPUT_DRY-RUN": "true",
      "INPUT_GITHUB-TOKEN": "two-skill-check-token",
      "INPUT_JEV-MODEL": "jev-1.13-free",
      "INPUT_SUPPORTED-THRESHOLD": "0.7",
      "INPUT-COMMENT-WORTHY-THRESHOLD": "0.6",
      "INPUT-TIMEOUT-SECONDS": "60",
      "INPUT-MAX-FINDINGS": "5",
      OPENCODE_API_KEY: "two-skill-check-jeV-token",
      OPENCODE_CLI: fakeCli,
      GITHUB_EVENT_PATH: eventPath,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: fixture.repoFullName,
      GITHUB_WORKSPACE: fixture.root,
    };
    const result = await run(
      env,
      defaultPipelineDependencies({ githubBaseUrl: mock.baseUrl, jevClient: fakeJev }),
    );
    if (result.code !== 0) {
      throw new Error(`${skill}: separated run failed: ${JSON.stringify(result)} (requests: ${JSON.stringify(mock.requests)})`);
    }
    const resultFile = JSON.parse(await readFile(join(runnerTemp, "review-result.json"), "utf8"));
    const output = await readFile(outputPath, "utf8");
    const leftovers = (await readdir(runnerTemp)).filter(
      (name) => name.startsWith("review-") && name !== "review-result.json",
    );
    results.push({
      skill,
      code: result.code,
      runnerTemp,
      resultPath: join(runnerTemp, "review-result.json"),
      resultFile,
      output,
      leftovers,
    });
  }

  for (const entry of results) {
    const other = results.find((candidate) => candidate !== entry);
    assert.equal(entry.code, 0, `${entry.skill}: run must exit 0 (${JSON.stringify(entry.resultFile)})`);
    assert.equal(entry.resultFile.status, "dry_run");
    assert.equal(entry.resultFile.skill, entry.skill);
    assert.equal(entry.resultFile.findings.length, 1);
    assert.equal(entry.resultFile.counts.publishable, 1);
    assert.equal(entry.resultFile.counts.published, 0);
    assert.deepEqual(entry.leftovers, [], `${entry.skill}: staging must be cleaned up`);
    assert.notEqual(entry.runnerTemp, other.runnerTemp, "runner temp dirs must differ");
    assert.notEqual(entry.resultPath, other.resultPath, "result paths must differ");
    assert.ok(entry.output.includes(`result-path=${entry.resultPath}`));
    assert.ok(!entry.output.includes(other.runnerTemp), `${entry.skill}: output must not reference the other run`);
    const mine = JSON.stringify(entry.resultFile);
    const theirs = JSON.stringify(other.resultFile);
    assert.ok(mine.includes(findingTitleBySkill[entry.skill]), `${entry.skill}: own finding must be present`);
    assert.ok(!mine.includes(findingTitleBySkill[other.skill]), `${entry.skill}: other skill's finding must be absent`);
    assert.ok(!mine.includes(other.runnerTemp), `${entry.skill}: result must not reference the other run`);
    assert.ok(!theirs.includes(entry.runnerTemp));
  }
} finally {
  await mock.close();
  for (const fixture of fixtures.values()) {
    await rm(fixture.root, { recursive: true, force: true });
  }
  for (const entry of results) {
    await rm(entry.runnerTemp, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      check: "two-skill separation (dist bundle)",
      runs: results.map((entry) => ({
        skill: entry.skill,
        code: entry.code,
        resultPath: entry.resultPath,
        status: entry.resultFile.status,
        findingTitle: entry.resultFile.findings[0].title,
        publishable: entry.resultFile.counts.publishable,
        stagingLeftovers: entry.leftovers,
      })),
      githubRequests: mock.requests,
    },
    null,
    2,
  ),
);
