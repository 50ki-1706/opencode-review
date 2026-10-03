// Two-commit git fixture repository for Range Resolver tests. Builds real
// repositories (including binary, symlink and gitlink entries) so the resolver
// is exercised through actual `git diff` / `ls-tree` / `show` output.
// Not named *.test.* so the Node test runner never executes it directly.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git-fixture.ts";

export type FixtureFile = {
  path: string;
  content?: string;
  binary?: Buffer;
  /** Creates a symlink; the path is staged with mode 120000. */
  symlink?: string;
  /** Creates a gitlink index entry (mode 160000) with this commit id. */
  submodule?: string;
};

export type FixtureDelete = { path: string; delete: true };

export type FixtureEntry = FixtureFile | FixtureDelete;

export type RangeFixtureRepo = {
  root: string;
  baseSha: string;
  headSha: string;
};

async function applyEntries(root: string, entries: readonly FixtureEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = join(root, entry.path);
    if ("delete" in entry) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (entry.symlink !== undefined) {
      await rm(target, { recursive: true, force: true });
      await symlink(entry.symlink, target);
      continue;
    }
    if (entry.binary !== undefined) {
      await writeFile(target, entry.binary);
      continue;
    }
    await writeFile(target, entry.content ?? "", "utf8");
  }
}

function stageSubmodules(root: string, entries: readonly FixtureEntry[]): void {
  for (const entry of entries) {
    if ("delete" in entry || entry.submodule === undefined) {
      continue;
    }
    git(root, "update-index", "--add", "--cacheinfo", `160000,${entry.submodule},${entry.path}`);
  }
}

export async function createRangeRepo(input: {
  base: readonly FixtureEntry[];
  head: readonly FixtureEntry[];
}): Promise<RangeFixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), "opencode-review-range-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "range@example.com");
  git(root, "config", "user.name", "range fixture");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.quotepath", "false");

  await applyEntries(root, input.base);
  git(root, "add", "-A");
  stageSubmodules(root, input.base);
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");

  await applyEntries(root, input.head);
  git(root, "add", "-A");
  stageSubmodules(root, input.head);
  git(root, "commit", "-q", "--allow-empty", "-m", "head");
  const headSha = git(root, "rev-parse", "HEAD");
  return { root, baseSha, headSha };
}
