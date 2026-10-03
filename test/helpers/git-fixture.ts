// Git fixture repository shared by producer tests. Not named *.test.* so the
// Node test runner never executes it directly.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message}`);
  }
  return result.stdout.trim();
}

export type FixtureRepo = {
  root: string;
  baseSha: string;
  headSha: string;
  changedPaths: string[];
};

/**
 * Two commits: the base adds files (source, skill assets, PR-side config that
 * must be excluded later), the head changes counter.ts so the diff is real.
 */
export async function createFixtureRepo(options: { skillName?: string; skillSkillMd?: string; symlinkSkillFile?: boolean } = {}): Promise<FixtureRepo> {
  const skillName = options.skillName ?? "fixture-skill";
  const root = await mkdtemp(join(tmpdir(), "opencode-review-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "fixture");

  await writeFile(join(root, "counter.ts"), "export function increment(n: number) {\n  return n + 1;\n}\n", "utf8");
  await writeFile(join(root, "AGENTS.md"), "Fixture project instructions.\n", "utf8");
  await writeFile(join(root, "opencode.json"), "{}\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=fixture\n", "utf8");

  const skillDir = join(root, ".opencode", "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    options.skillSkillMd ?? `---\nname: ${skillName}\ndescription: Fixture review skill\n---\nReport concrete defects only.\n`,
    "utf8",
  );
  await writeFile(join(skillDir, "notes.md"), "Sibling skill asset for relative references.\n", "utf8");
  if (options.symlinkSkillFile) {
    await symlink("notes.md", join(skillDir, "linked.md"));
  }

  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "counter.ts"), "export function increment(n: number) {\n  return n - 1;\n}\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const headSha = git(root, "rev-parse", "HEAD");
  return { root, baseSha, headSha, changedPaths: ["counter.ts"] };
}

export function fixtureContext(repo: FixtureRepo, overrides: Record<string, unknown> = {}) {
  return {
    repository: "example/repo",
    pullNumber: 1,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    skill: "fixture-skill",
    model: "opencode/space-bunny-free",
    thresholds: { supported: 0.7, commentWorthy: 0.6 },
    limits: { timeoutSeconds: 30, maxFindings: 10 },
    ...overrides,
  };
}

export function fixturePrInfo(repo: FixtureRepo) {
  return {
    number: 1,
    state: "open" as const,
    draft: false,
    head: { sha: repo.headSha, ref: "feature", repo: { full_name: "example/repo" } },
    base: { sha: repo.baseSha },
  };
}

export function fixtureDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-review-test-"));
}
