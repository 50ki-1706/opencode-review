import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CANARY_PLUGIN_FILE,
  REPORT_FINDING_PLUGIN_FILE,
  canaryPluginText,
  reviewerPermissions,
  stageManagedConfigDir,
} from "../src/opencode.ts";
import { reportFindingTemplate } from "../src/templates.ts";

async function tempHome(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-review-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const skillName = "fixture-skill";

test("reportFindingTemplate resolves to the exact template file bytes", async () => {
  const fileText = await readFile(new URL("../templates/report-finding.plugin.ts", import.meta.url), "utf8");
  assert.equal(reportFindingTemplate, fileText);
});

test("reviewerPermissions denies everything first and opens only the review tools", () => {
  const permissions = reviewerPermissions(skillName, "/tmp/home/.config/opencode/skills/fixture-skill");
  assert.deepEqual(permissions[0], { action: "*", resource: "*", effect: "deny" });
  assert.deepEqual(permissions.at(-1), {
    action: "external_directory",
    resource: "/tmp/home/.config/opencode/skills/fixture-skill/*",
    effect: "allow",
  });
  const actions = permissions.map((rule) => rule.action);
  assert.deepEqual(actions, ["*", "read", "glob", "grep", "skill", "report_finding", "external_directory"]);
  const skill = permissions.find((rule) => rule.action === "skill");
  assert.equal(skill?.resource, skillName);
  assert.equal(permissions.some((rule) => rule.action === "shell"), false);
  assert.equal(permissions.some((rule) => rule.action === "edit"), false);
});

test("stageManagedConfigDir writes only the managed files with verbatim plugins", async (t) => {
  const home = await tempHome(t);
  const skillDir = join(home, ".config", "opencode", "skills", skillName);
  const config = await stageManagedConfigDir({
    tempHome: home,
    skillName,
    skillDir,
    prompt: "PROMPT-BODY",
  });

  const configDirEntries = (await readdir(config.configDir)).sort();
  assert.deepEqual(configDirEntries, ["agents", "opencode.json", "plugins", "skills"]);
  const pluginEntries = (await readdir(join(config.configDir, "plugins"))).sort();
  assert.deepEqual(pluginEntries, [CANARY_PLUGIN_FILE, REPORT_FINDING_PLUGIN_FILE]);

  const json = JSON.parse(await readFile(join(config.configDir, "opencode.json"), "utf8")) as {
    $schema: string;
    permissions: Array<{ action: string; resource: string; effect: string }>;
  };
  assert.equal(json.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(json.permissions, reviewerPermissions(skillName, skillDir));

  const agent = await readFile(config.agentPath, "utf8");
  assert.ok(agent.startsWith("---\n"));
  assert.ok(agent.includes("mode: primary"));
  assert.ok(agent.includes('resource: "fixture-skill"'));
  assert.ok(agent.includes("permissions:"));
  assert.ok(agent.endsWith(`PROMPT-BODY\n`));

  assert.equal(await readFile(config.reportFindingPluginPath, "utf8"), reportFindingTemplate);
  assert.equal(await readFile(config.canaryPluginPath, "utf8"), canaryPluginText);
});

test("the canary plugin writes the environment-provided marker only", () => {
  assert.ok(canaryPluginText.includes("REVIEW_CANARY_MARKER"));
  assert.ok(canaryPluginText.includes("export default"));
  assert.ok(!canaryPluginText.includes("REVIEW_NDJSON_PATH"));
});

test("stageManagedConfigDir is idempotent and leaves no stray files", async (t) => {
  const home = await tempHome(t);
  const skillDir = join(home, ".config", "opencode", "skills", skillName);
  await stageManagedConfigDir({ tempHome: home, skillName, skillDir, prompt: "one" });
  const config = await stageManagedConfigDir({ tempHome: home, skillName, skillDir, prompt: "two" });
  const agent = await readFile(config.agentPath, "utf8");
  assert.ok(agent.endsWith("two\n"));
  assert.equal(agent.includes("one\n"), false);
  const all = await readdir(home, { recursive: true });
  assert.deepEqual(all.sort(), [
    ".config",
    join(".config", "opencode"),
    join(".config", "opencode", "agents"),
    join(".config", "opencode", "agents", "reviewer.md"),
    join(".config", "opencode", "opencode.json"),
    join(".config", "opencode", "plugins"),
    join(".config", "opencode", "plugins", CANARY_PLUGIN_FILE),
    join(".config", "opencode", "plugins", REPORT_FINDING_PLUGIN_FILE),
    join(".config", "opencode", "skills"),
  ].sort());
});
