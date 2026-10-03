import assert from "node:assert/strict";
import { readFile, rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ReviewRunError, parseSkillFrontmatter, stageSkillFromHead } from "../src/opencode.ts";
import { createFixtureRepo, git } from "./helpers/git-fixture.ts";

async function tempDir(t: TestContext, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("parseSkillFrontmatter reads a valid frontmatter block", () => {
  const parsed = parseSkillFrontmatter("---\nname: fixture-skill\ndescription: Review fixture code\n---\nBody.\n");
  assert.deepEqual(parsed, { name: "fixture-skill", description: "Review fixture code" });
});

test("parseSkillFrontmatter accepts quoted values and CRLF", () => {
  const parsed = parseSkillFrontmatter('---\r\nname: "fixture-skill"\r\ndescription: \'Quoted description\'\r\n---\r\nBody.\r\n');
  assert.deepEqual(parsed, { name: "fixture-skill", description: "Quoted description" });
});

test("parseSkillFrontmatter rejects missing, blank and malformed fields", () => {
  const cases: Array<[string, string]> = [
    ["no frontmatter", "Body only.\n"],
    ["unterminated", "---\nname: fixture-skill\n"],
    ["missing name", "---\ndescription: Something\n---\n"],
    ["invalid name", "---\nname: Bad_Name\ndescription: Something\n---\n"],
    ["missing description", "---\nname: fixture-skill\n---\n"],
    ["blank description", "---\nname: fixture-skill\ndescription:   \n---\n"],
    ["block scalar description", "---\nname: fixture-skill\ndescription: >\n  folded\n---\n"],
    ["too long description", `---\nname: fixture-skill\ndescription: ${"x".repeat(1025)}\n---\n`],
  ];
  for (const [name, text] of cases) {
    assert.throws(() => parseSkillFrontmatter(text), (error: unknown) => error instanceof ReviewRunError && error.kind === "skill", name);
  }
});

test("stageSkillFromHead copies the whole skill directory from the fixed HEAD", async (t) => {
  const repo = await createFixtureRepo();
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  const staged = await stageSkillFromHead({
    workspace: repo.root,
    headSha: repo.headSha,
    skillName: "fixture-skill",
    skillsRoot,
  });
  assert.equal(staged.name, "fixture-skill");
  assert.equal(staged.description, "Fixture review skill");
  assert.equal(staged.fileCount, 2);
  const expected = git(repo.root, "show", `${repo.headSha}:.opencode/skills/fixture-skill/SKILL.md`);
  assert.equal(await readFile(join(staged.stagedDir, "SKILL.md"), "utf8"), `${expected}\n`);
  assert.equal(await readFile(join(staged.stagedDir, "notes.md"), "utf8"), "Sibling skill asset for relative references.\n");
});

test("stageSkillFromHead rejects a missing skill directory", async (t) => {
  const repo = await createFixtureRepo();
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  await assert.rejects(
    stageSkillFromHead({ workspace: repo.root, headSha: repo.headSha, skillName: "missing-skill", skillsRoot }),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "skill",
  );
});

test("stageSkillFromHead rejects a frontmatter name mismatch", async (t) => {
  const repo = await createFixtureRepo({
    skillSkillMd: "---\nname: other-skill\ndescription: Mismatch\n---\nBody.\n",
  });
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  await assert.rejects(
    stageSkillFromHead({ workspace: repo.root, headSha: repo.headSha, skillName: "fixture-skill", skillsRoot }),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "skill" && error.message.includes("other-skill"),
  );
});

test("stageSkillFromHead rejects a symlink inside the skill directory", async (t) => {
  const repo = await createFixtureRepo({ symlinkSkillFile: true });
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  await assert.rejects(
    stageSkillFromHead({ workspace: repo.root, headSha: repo.headSha, skillName: "fixture-skill", skillsRoot }),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "skill",
  );
});

test("stageSkillFromHead rejects an invalid skill name before touching git", async (t) => {
  const repo = await createFixtureRepo();
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  await assert.rejects(
    stageSkillFromHead({ workspace: repo.root, headSha: repo.headSha, skillName: "../escape", skillsRoot }),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "skill",
  );
});

test("stageSkillFromHead validates the skill at the requested SHA, not the working tree", async (t) => {
  const repo = await createFixtureRepo();
  // The file exists in the working tree; a bogus SHA must still fail.
  const skillsRoot = await tempDir(t, "opencode-review-skills-");
  await assert.rejects(
    stageSkillFromHead({ workspace: repo.root, headSha: "f".repeat(40), skillName: "fixture-skill", skillsRoot }),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "skill",
  );
});

test("a skill directory containing only SKILL.md is accepted", async (t) => {
  const root = await tempDir(t, "opencode-review-empty-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "fixture");
  await mkdir(join(root, ".opencode", "skills", "fixture-skill"), { recursive: true });
  await writeFile(join(root, ".opencode", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: empty skill\n---\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "only skill file");
  const headSha = git(root, "rev-parse", "HEAD");
  const skillsRoot = join(root, "staged");
  const staged = await stageSkillFromHead({ workspace: root, headSha, skillName: "fixture-skill", skillsRoot });
  assert.equal(staged.fileCount, 1);
});
