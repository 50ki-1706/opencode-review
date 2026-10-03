import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildEnvironment,
  buildOpenCodeCommand,
  buildReviewerPrompt,
  providerFromModel,
  ReviewRunError,
  type ChildEnvironmentInput,
} from "../src/opencode.ts";

type Env = Record<string, string | undefined>;

function input(overrides: Partial<ChildEnvironmentInput> = {}): ChildEnvironmentInput {
  return {
    parentEnv: { PATH: "/usr/bin", LANG: "C.UTF-8", OPENAI_API_KEY: "sk-provider" },
    model: "openai/gpt-5",
    homeDir: "/tmp/review-home",
    tempDir: "/tmp/review-temp",
    ndjsonPath: "/tmp/review-temp/findings.ndjson",
    changedPathsPath: "/tmp/review-temp/changed-paths.json",
    canaryMarkerPath: "/tmp/review-temp/canary.marker",
    maxFindings: 100,
    recordLimitBytes: 32768,
    protectedValues: ["ghp_action_token"],
    ...overrides,
  };
}

test("providerFromModel strips the variant and takes the provider", () => {
  assert.equal(providerFromModel("openai/gpt-5"), "openai");
  assert.equal(providerFromModel("opencode/space-bunny-free#free"), "opencode");
  assert.equal(providerFromModel("opencode-go/some-model"), "opencode-go");
});

test("the child environment is exactly the allowlist plus the provider key", () => {
  const result = buildChildEnvironment(input());
  assert.equal(result.providerKeyName, "OPENAI_API_KEY");
  assert.deepEqual(Object.keys(result.env).sort(), [
    "HOME",
    "LANG",
    "OPENAI_API_KEY",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "PATH",
    "REVIEW_CANARY_MARKER",
    "REVIEW_CHANGED_PATHS",
    "REVIEW_MAX_FINDINGS",
    "REVIEW_NDJSON_PATH",
    "REVIEW_RECORD_LIMIT_BYTES",
    "TMPDIR",
    "XDG_CONFIG_HOME",
  ].sort());
  assert.equal(result.env["HOME"], "/tmp/review-home");
  assert.equal(result.env["XDG_CONFIG_HOME"], "/tmp/review-home/.config");
  assert.equal(result.env["TMPDIR"], "/tmp/review-temp");
  assert.equal(result.env["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
  assert.equal(result.env["REVIEW_MAX_FINDINGS"], "100");
  assert.equal(result.env["REVIEW_RECORD_LIMIT_BYTES"], "32768");
  assert.equal(result.env["OPENAI_API_KEY"], "sk-provider");
});

test("LC_ALL is passed only when the parent has it", () => {
  const without = buildChildEnvironment(input());
  assert.equal("LC_ALL" in without.env, false);
  const withLc = buildChildEnvironment(input({ parentEnv: { PATH: "/usr/bin", LC_ALL: "en_US.UTF-8" } }));
  assert.equal(withLc.env["LC_ALL"], "en_US.UTF-8");
});

test("google prefers GEMINI_API_KEY and falls back to GOOGLE_API_KEY", () => {
  const gemini = buildChildEnvironment(input({ model: "google/gemini-3", parentEnv: { PATH: "/usr/bin", GEMINI_API_KEY: "g1" } }));
  assert.equal(gemini.providerKeyName, "GEMINI_API_KEY");
  const google = buildChildEnvironment(input({ model: "google/gemini-3", parentEnv: { PATH: "/usr/bin", GOOGLE_API_KEY: "g2" } }));
  assert.equal(google.providerKeyName, "GOOGLE_API_KEY");
  assert.equal(google.env["GOOGLE_API_KEY"], "g2");
});

test("the anonymous opencode provider adds no credential", () => {
  const result = buildChildEnvironment(input({ model: "opencode/space-bunny-free", parentEnv: { PATH: "/usr/bin" } }));
  assert.equal(result.providerKeyName, null);
  assert.equal(Object.keys(result.env).some((name) => name.endsWith("_API_KEY")), false);
});

test("an unknown provider adds no credential", () => {
  const result = buildChildEnvironment(input({ model: "unknown-provider/model", parentEnv: { PATH: "/usr/bin", OPENAI_API_KEY: "sk" } }));
  assert.equal(result.providerKeyName, null);
  assert.equal("OPENAI_API_KEY" in result.env, false);
});

test("a child value equal to a protected secret refuses to spawn", () => {
  const secret = "ghp_collision_value";
  assert.throws(
    () => buildChildEnvironment(input({ parentEnv: { PATH: "/usr/bin", OPENAI_API_KEY: secret }, protectedValues: [secret] })),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRunError);
      assert.equal(error.kind, "config");
      assert.deepEqual(error.fields, ["OPENAI_API_KEY"]);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("JEV_API_KEY and GitHub token values are refused when inherited", () => {
  assert.throws(
    () => buildChildEnvironment(input({ parentEnv: { PATH: "/usr/bin", OPENAI_API_KEY: "jev-secret", JEV_API_KEY: "jev-secret" } })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "config",
  );
  assert.throws(
    () => buildChildEnvironment(input({ parentEnv: { PATH: "/usr/bin", OPENAI_API_KEY: "gh-secret", GITHUB_TOKEN: "gh-secret" } })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "config",
  );
});

test("protected environment names never appear in the child environment", () => {
  const result = buildChildEnvironment(input({
    parentEnv: {
      PATH: "/usr/bin",
      JEV_API_KEY: "jev",
      TYPESAFE_API_KEY: "typesafe",
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
    },
  }));
  const forbidden = /^(JEV_API_KEY|TYPESAFE_[A-Z0-9_]*|GITHUB_TOKEN|GH_TOKEN)$/;
  assert.equal(Object.keys(result.env).some((name) => forbidden.test(name)), false);
});

test("a missing PATH is a configuration run error", () => {
  assert.throws(
    () => buildChildEnvironment(input({ parentEnv: {} })),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "config" && error.fields.includes("PATH"),
  );
});

test("buildOpenCodeCommand produces the fixed argument array", () => {
  const command = buildOpenCodeCommand({
    cliPath: "/usr/local/bin/opencode",
    model: "opencode/space-bunny-free",
    agent: "reviewer",
    prompt: "review this",
  });
  assert.deepEqual(command, {
    command: "/usr/local/bin/opencode",
    args: ["run", "--standalone", "--format", "json", "--agent", "reviewer", "--model", "opencode/space-bunny-free", "review this"],
  });
});

test("buildReviewerPrompt carries the skill, changed paths and output contract", () => {
  const prompt = buildReviewerPrompt("fixture-skill", ["src/a.ts", "src/b.ts"]);
  assert.ok(prompt.includes('Load the "fixture-skill" skill'));
  assert.ok(prompt.includes("- src/a.ts"));
  assert.ok(prompt.includes("- src/b.ts"));
  assert.ok(prompt.includes("report_finding"));
  assert.ok(prompt.includes("1-based inclusive"));
  assert.ok(prompt.includes("anchor"));
  assert.ok(prompt.includes("copied verbatim from the read tool output"));
  assert.ok(prompt.includes('correct "  return n - 1;"'), "prompt shows a leading-whitespace-correct anchor example");
  assert.ok(prompt.includes('wrong "return n - 1;"'), "prompt shows the trimmed-anchor counterexample");
});

test("buildReviewerPrompt truncates very large changed path lists", () => {
  const paths = Array.from({ length: 510 }, (_, index) => `src/file-${index}.ts`);
  const prompt = buildReviewerPrompt("fixture-skill", paths);
  assert.ok(prompt.includes("... and 10 more changed files"));
  assert.ok(!prompt.includes("src/file-509.ts"));
});
