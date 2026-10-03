import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Finding } from "../src/finding.ts";
import {
  MAX_BLOB_LINES,
  RangeRunError,
  buildDiffModel,
  buildJevEvidence,
  changedLineEvidence,
  changedPathsFromDiff,
  formatHunk,
  hunkOf,
  hunksOverlappingRange,
  isSafeRepoPath,
  parseUnifiedDiff,
  reResolveForCorrection,
  resolveFinding,
  resolveFindings,
  skipOutcome,
  splitBlobLines,
  type DiffModel,
  type FindingResolution,
  type RangeSkipReason,
} from "../src/range.ts";
import { git } from "./helpers/git-fixture.ts";
import { createRangeRepo } from "./helpers/range-fixture.ts";

// --- Shared helpers --------------------------------------------------------

const HEAD_SHA = "a".repeat(40);

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/range/${name}`, import.meta.url), "utf8");

function makeFinding(path: string, start: number, end: number, anchor: string): Finding {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    skill: "fixture-skill",
    path,
    candidateRange: { start, end, anchor },
    severity: "medium",
    title: "Fixture finding",
    body: "Fixture body.",
  };
}

function skipReason(result: FindingResolution): RangeSkipReason {
  assert.equal(result.kind, "skipped", `expected a skip, got ${result.kind}`);
  if (result.kind !== "skipped") {
    throw new Error("unreachable");
  }
  return result.reason;
}

function resolvedRange(result: FindingResolution) {
  assert.equal(result.kind, "resolved", `expected a resolve, got ${result.kind === "skipped" ? result.reason : ""}`);
  if (result.kind !== "resolved") {
    throw new Error("unreachable");
  }
  return result.range;
}

function cleanup(t: TestContext, root: string): void {
  t.after(() => rm(root, { recursive: true, force: true }));
}

function resolvePure(options: {
  diffText: string;
  blob: string;
  path: string;
  start: number;
  end: number;
  anchor: string;
}): FindingResolution {
  return resolveFinding({
    finding: makeFinding(options.path, options.start, options.end, options.anchor),
    diff: parseUnifiedDiff(options.diffText),
    headSha: HEAD_SHA,
    loadBlob: () => ({
      kind: "ok",
      byteLength: Buffer.byteLength(options.blob),
      binary: false,
      lines: splitBlobLines(options.blob),
    }),
  });
}

function multiHunkBlob(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 40; i += 1) {
    if (i === 3) {
      lines.push("line 03 changed");
    } else if (i === 38) {
      lines.push("line 38 changed");
    } else {
      lines.push(`line ${String(i).padStart(2, "0")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function diffLineCounts(model: DiffModel): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of model.files.values()) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") {
          added += 1;
        } else if (line.kind === "removed") {
          removed += 1;
        }
      }
    }
  }
  return { added, removed };
}

const ADDED_BLOB = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";

// --- Diff parser -----------------------------------------------------------

test("parseUnifiedDiff models an added file with RIGHT line numbers", () => {
  const model = parseUnifiedDiff(fixture("added.diff"));
  assert.deepEqual(changedPathsFromDiff(model), ["src/new-file.ts"]);
  const file = model.files.get("src/new-file.ts")!;
  assert.equal(file.status, "added");
  assert.equal(file.binary, false);
  assert.equal(file.hunks.length, 1);
  const hunk = file.hunks[0]!;
  assert.equal(hunk.header, "@@ -0,0 +1,3 @@");
  assert.equal(hunk.newStart, 1);
  assert.equal(hunk.newCount, 3);
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.newLineNumber, line.text]),
    [
      ["added", 1, "export const a = 1;"],
      ["added", 2, "export const b = 2;"],
      ["added", 3, "export const c = 3;"],
    ],
  );
});

test("parseUnifiedDiff models multiple hunks and their new-side spans", () => {
  const file = parseUnifiedDiff(fixture("modified-multi-hunk.diff")).files.get("file.ts")!;
  assert.equal(file.status, "modified");
  assert.equal(file.hunks.length, 2);
  assert.equal(file.hunks[0]!.newStart, 1);
  assert.equal(file.hunks[0]!.newCount, 6);
  assert.equal(file.hunks[1]!.newStart, 35);
  assert.equal(file.hunks[1]!.newCount, 6);
  assert.equal(file.hunks[1]!.section, "line 34");
  const added = file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind === "added").map((line) => line.newLineNumber),
  );
  assert.deepEqual(added, [3, 38]);
});

test("parseUnifiedDiff keeps rename new paths and previous filenames", () => {
  const model = parseUnifiedDiff(fixture("rename.diff"));
  assert.deepEqual(changedPathsFromDiff(model), ["src/new-name.ts"]);
  const file = model.files.get("src/new-name.ts")!;
  assert.equal(file.status, "renamed");
  assert.equal(file.previousPath, "src/old-name.ts");
  assert.equal(file.similarity, 55);
  assert.deepEqual(
    file.hunks[0]!.lines.filter((line) => line.kind === "added").map((line) => line.text),
    ["second changed"],
  );
  assert.equal(model.files.has("src/old-name.ts"), false);
});

test("parseUnifiedDiff models a deleted file without RIGHT line numbers", () => {
  const file = parseUnifiedDiff(fixture("deleted.diff")).files.get("src/gone.ts")!;
  assert.equal(file.status, "deleted");
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0]!.newCount, 0);
  assert.ok(file.hunks[0]!.lines.every((line) => line.newLineNumber === null));
});

test("parseUnifiedDiff flags binary files", () => {
  const file = parseUnifiedDiff(fixture("binary.diff")).files.get("assets/icon.png")!;
  assert.equal(file.binary, true);
  assert.equal(file.status, "added");
  assert.equal(file.hunks.length, 0);
});

test("parseUnifiedDiff strips trailing CR from body lines", () => {
  const hunk = parseUnifiedDiff(fixture("crlf.diff")).files.get("src/windows.txt")!.hunks[0]!;
  const added = hunk.lines.find((line) => line.kind === "added")!;
  assert.equal(added.text, "second changed");
  assert.equal(added.raw, "+second changed");
  assert.ok(hunk.lines.every((line) => !line.raw.endsWith("\r")));
});

test("parseUnifiedDiff records the no-newline marker", () => {
  const hunk = parseUnifiedDiff(fixture("no-newline.diff")).files.get("src/tail.ts")!.hunks[0]!;
  const meta = hunk.lines.filter((line) => line.kind === "meta");
  assert.equal(meta.length, 2);
  assert.equal(meta[0]!.raw, "\\ No newline at end of file");
  assert.equal(hunk.lines.find((line) => line.kind === "added")!.newLineNumber, 2);
  assert.equal(hunk.lines.find((line) => line.kind === "removed")!.oldLineNumber, 2);
  assert.ok(formatHunk(hunk).includes("\\ No newline at end of file"));
});

test("parseUnifiedDiff handles paths with spaces and Japanese characters", () => {
  const model = parseUnifiedDiff(fixture("spaces-japanese.diff"));
  const path = "dir with space/ファイル name.ts";
  assert.deepEqual(changedPathsFromDiff(model), [path]);
  const file = model.files.get(path)!;
  assert.equal(file.status, "added");
  assert.equal(file.hunks[0]!.lines[1]!.text, "export const y = 2;");
});

test("parseUnifiedDiff models a symlink fixture like a regular added file", () => {
  const file = parseUnifiedDiff(fixture("symlink.diff")).files.get("src/link.ts")!;
  assert.equal(file.status, "added");
  assert.equal(file.hunks[0]!.lines[0]!.text, "target.ts");
});

test("parseUnifiedDiff reads a mode-only change from the diff --git header", () => {
  const model = parseUnifiedDiff([
    "diff --git a/script.sh b/script.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n"));
  const file = model.files.get("script.sh")!;
  assert.equal(file.status, "modified");
  assert.equal(file.hunks.length, 0);
});

test("parseUnifiedDiff refuses an unparseable hunk header", () => {
  assert.throws(
    () => parseUnifiedDiff("diff --git a/x b/x\n@@ -oops @@\n"),
    (error: unknown) => error instanceof RangeRunError && error.kind === "diff",
  );
});

// --- Path safety -----------------------------------------------------------

test("isSafeRepoPath accepts repository-relative names and rejects escapes", () => {
  for (const path of ["src/a.ts", "dir with space/ファイル name.ts", "a-b/c.d", "a"]) {
    assert.equal(isSafeRepoPath(path), true, path);
  }
  for (const path of ["", "/abs.ts", "C:/abs.ts", "a\\b.ts", "a/../b.ts", "./a.ts", "a/./b.ts", "a//b.ts", "a/", "a\0b.ts"]) {
    assert.equal(isSafeRepoPath(path), false, JSON.stringify(path));
  }
});

// --- Pure anchor resolution (steps 5 and 6) --------------------------------

test("resolveFinding resolves an exact anchor inside the candidate", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/new-file.ts",
    start: 2,
    end: 2,
    anchor: "export const b = 2;",
  });
  assert.deepEqual(resolvedRange(result), {
    path: "src/new-file.ts",
    commitId: HEAD_SHA,
    startLine: 1,
    endLine: 3,
    anchorStartLine: 2,
    side: "RIGHT",
    code: "export const a = 1;\nexport const b = 2;\nexport const c = 3;",
  });
});

test("resolveFinding keeps a single added line when context adjoins it", () => {
  const result = resolvePure({
    diffText: fixture("modified-multi-hunk.diff"),
    blob: multiHunkBlob(),
    path: "file.ts",
    start: 38,
    end: 38,
    anchor: "line 38 changed",
  });
  const range = resolvedRange(result);
  assert.equal(range.startLine, 38);
  assert.equal(range.endLine, 38);
  assert.equal(range.anchorStartLine, 38);
  assert.equal(range.code, "line 38 changed");
});

test("resolveFinding includes an adjoining added run and keeps anchor context", () => {
  const result = resolvePure({
    diffText: fixture("modified-multi-hunk.diff"),
    blob: multiHunkBlob(),
    path: "file.ts",
    start: 4,
    end: 5,
    anchor: "line 04\nline 05",
  });
  const range = resolvedRange(result);
  assert.deepEqual([range.startLine, range.endLine, range.anchorStartLine], [3, 5, 4]);
  assert.equal(range.code, "line 03 changed\nline 04\nline 05");
});

test("resolveFinding resolves a multi-line anchor that mixes added and context lines", () => {
  const result = resolvePure({
    diffText: fixture("modified-multi-hunk.diff"),
    blob: multiHunkBlob(),
    path: "file.ts",
    start: 3,
    end: 4,
    anchor: "line 03 changed\nline 04",
  });
  const range = resolvedRange(result);
  assert.deepEqual([range.startLine, range.endLine, range.anchorStartLine], [3, 4, 3]);
  assert.equal(range.code, "line 03 changed\nline 04");
});

test("resolveFinding skips a context-only anchor without adjoining added lines", () => {
  const result = resolvePure({
    diffText: fixture("modified-multi-hunk.diff"),
    blob: multiHunkBlob(),
    path: "file.ts",
    start: 5,
    end: 6,
    anchor: "line 05\nline 06",
  });
  assert.equal(skipReason(result), "no_changed_line_in_range");
});

test("resolveFinding adopts a unique anchor outside the candidate", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/new-file.ts",
    start: 10,
    end: 12,
    anchor: "export const c = 3;",
  });
  const range = resolvedRange(result);
  assert.equal(range.anchorStartLine, 3);
  assert.deepEqual([range.startLine, range.endLine], [1, 3]);
});

test("resolveFinding corrects a candidate outside the blob through anchor uniqueness", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/new-file.ts",
    start: 100,
    end: 101,
    anchor: "export const b = 2;",
  });
  const range = resolvedRange(result);
  assert.equal(range.anchorStartLine, 2);
});

test("resolveFinding skips an ambiguous anchor with multiple matches", () => {
  const diffText = [
    "diff --git a/dup.ts b/dup.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/dup.ts",
    "@@ -0,0 +1,5 @@",
    "+dup",
    "+alpha",
    "+beta",
    "+dup",
    "+gamma",
    "",
  ].join("\n");
  const result = resolvePure({
    diffText,
    blob: "dup\nalpha\nbeta\ndup\ngamma\n",
    path: "dup.ts",
    start: 2,
    end: 2,
    anchor: "dup",
  });
  assert.equal(skipReason(result), "anchor_ambiguous");
});

test("resolveFinding prefers the first exact window when an anchor repeats inside the candidate", () => {
  const diffText = [
    "diff --git a/dup2.ts b/dup2.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/dup2.ts",
    "@@ -0,0 +1,3 @@",
    "+dup",
    "+mid",
    "+dup",
    "",
  ].join("\n");
  const result = resolvePure({
    diffText,
    blob: "dup\nmid\ndup\n",
    path: "dup2.ts",
    start: 1,
    end: 3,
    anchor: "dup",
  });
  const range = resolvedRange(result);
  assert.equal(range.anchorStartLine, 1);
  assert.deepEqual([range.startLine, range.endLine], [1, 3]);
});

test("resolveFinding skips when the anchor is absent", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/new-file.ts",
    start: 1,
    end: 1,
    anchor: "export const missing = 0;",
  });
  assert.equal(skipReason(result), "anchor_not_found");
});

test("resolveFinding does not trim or guess anchor text", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/new-file.ts",
    start: 2,
    end: 2,
    anchor: "export const b = 2;\n",
  });
  assert.equal(skipReason(result), "anchor_not_found");
});

const GAP_DIFF = [
  "diff --git a/f.ts b/f.ts",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -10,3 +10,3 @@",
  " x",
  "-y",
  "+Y",
  " z",
  "",
].join("\n");

const GAP_BLOB = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "x", "Y", "z"].join("\n") + "\n";

test("resolveFinding skips an anchor straddling the gap between hunks", () => {
  const result = resolvePure({
    diffText: GAP_DIFF,
    blob: GAP_BLOB,
    path: "f.ts",
    start: 3,
    end: 4,
    anchor: "c\nd",
  });
  assert.equal(skipReason(result), "not_in_single_hunk");
});

test("resolveFinding skips an anchor that quotes a removed line", () => {
  // HEAD has "line 03 changed"; the removed old text is not in the blob, and
  // matching is exact (no prefix or fuzzy match).
  const result = resolvePure({
    diffText: fixture("modified-multi-hunk.diff"),
    blob: multiHunkBlob(),
    path: "file.ts",
    start: 3,
    end: 3,
    anchor: "line 03",
  });
  assert.equal(skipReason(result), "anchor_not_found");
});

test("resolveFinding skips an anchor entirely in an unchanged gap", () => {
  const result = resolvePure({
    diffText: GAP_DIFF,
    blob: GAP_BLOB,
    path: "f.ts",
    start: 4,
    end: 5,
    anchor: "d\ne",
  });
  assert.equal(skipReason(result), "not_in_single_hunk");
});

test("resolveFinding expands a context anchor to its adjoining added line", () => {
  const result = resolvePure({
    diffText: GAP_DIFF,
    blob: GAP_BLOB,
    path: "f.ts",
    start: 3,
    end: 3,
    anchor: "c",
  });
  const range = resolvedRange(result);
  assert.deepEqual([range.startLine, range.endLine, range.anchorStartLine], [2, 3, 3]);
  assert.equal(range.code, "B\nc");
});

test("resolveFinding matches anchors against CRLF blobs and normalizes code", () => {
  const blob = "first line\r\nsecond changed\r\nthird line\r\n";
  const result = resolvePure({
    diffText: fixture("crlf.diff"),
    blob,
    path: "src/windows.txt",
    start: 2,
    end: 2,
    anchor: "second changed",
  });
  const range = resolvedRange(result);
  assert.equal(range.startLine, 2);
  assert.equal(range.code, "second changed");
});

test("resolveFinding accepts anchors that carry CRLF endings", () => {
  const blob = "first line\r\nsecond changed\r\nthird line\r\n";
  const result = resolvePure({
    diffText: fixture("crlf.diff"),
    blob,
    path: "src/windows.txt",
    start: 1,
    end: 2,
    anchor: "first line\r\nsecond changed",
  });
  const range = resolvedRange(result);
  assert.deepEqual([range.startLine, range.endLine], [1, 2]);
  assert.equal(range.code, "first line\nsecond changed");
});

// --- Path / blob level skips -----------------------------------------------

test("resolveFinding skips a path that is not changed", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "src/other.ts",
    start: 1,
    end: 1,
    anchor: "x",
  });
  assert.equal(skipReason(result), "path_not_changed");
});

test("resolveFinding rejects an unsafe path before touching the diff", () => {
  const result = resolvePure({
    diffText: fixture("added.diff"),
    blob: ADDED_BLOB,
    path: "../escape.ts",
    start: 1,
    end: 1,
    anchor: "x",
  });
  assert.equal(skipReason(result), "path_unsafe");
});

test("resolveFinding skips a deleted file without loading a blob", () => {
  const result = resolveFinding({
    finding: makeFinding("src/gone.ts", 1, 1, "one"),
    diff: parseUnifiedDiff(fixture("deleted.diff")),
    headSha: HEAD_SHA,
    loadBlob: () => {
      throw new Error("must not load a deleted blob");
    },
  });
  assert.equal(skipReason(result), "file_deleted");
});

test("resolveFinding skips binary files without loading a blob", () => {
  const result = resolveFinding({
    finding: makeFinding("assets/icon.png", 1, 1, "x"),
    diff: parseUnifiedDiff(fixture("binary.diff")),
    headSha: HEAD_SHA,
    loadBlob: () => {
      throw new Error("must not load a binary blob");
    },
  });
  assert.equal(skipReason(result), "file_binary");
});

test("resolveFinding passes through blob-level skips", () => {
  const result = resolveFinding({
    finding: makeFinding("src/new-file.ts", 1, 1, "export const a = 1;"),
    diff: parseUnifiedDiff(fixture("added.diff")),
    headSha: HEAD_SHA,
    loadBlob: () => skipOutcome("blob_too_large", "fixture"),
  });
  assert.equal(skipReason(result), "blob_too_large");
});

test("resolveFinding rejects an invalid candidate interval", () => {
  const result = resolveFinding({
    finding: makeFinding("src/new-file.ts", 3, 2, "x"),
    diff: parseUnifiedDiff(fixture("added.diff")),
    headSha: HEAD_SHA,
    loadBlob: () => {
      throw new Error("must not load a blob for an invalid candidate");
    },
  });
  assert.equal(skipReason(result), "candidate_invalid");
});

// --- Jev evidence seam -----------------------------------------------------

test("hunkOf and evidence helpers expose the diff around a resolved range", () => {
  const diff = parseUnifiedDiff(fixture("modified-multi-hunk.diff"));
  const blobLines = splitBlobLines(multiHunkBlob());

  const hunk = hunkOf(diff, "file.ts", { startLine: 38, endLine: 38 })!;
  assert.equal(hunk.newStart, 35);
  assert.equal(hunksOverlappingRange(diff, "file.ts", { startLine: 2, endLine: 38 }).length, 2);

  const evidence = buildJevEvidence({
    diff,
    path: "file.ts",
    blobLines,
    range: { startLine: 38, endLine: 38 },
    contextLines: 2,
  });
  assert.deepEqual(evidence.contextBefore, ["line 36", "line 37"]);
  assert.deepEqual(evidence.contextAfter, ["line 39", "line 40"]);
  assert.equal(evidence.diffHunks.length, 1);
  assert.ok(evidence.diffHunks[0]!.startsWith("@@ -35,6 +35,6 @@ line 34"));
  assert.ok(evidence.diffHunks[0]!.includes("+line 38 changed"));
  assert.equal(evidence.evidenceTruncated, false);

  const changedOnly = changedLineEvidence({ diff, path: "file.ts", range: { startLine: 38, endLine: 38 } });
  assert.equal(changedOnly.length, 1);
  assert.ok(changedOnly[0]!.includes("-line 38"));
  assert.ok(changedOnly[0]!.includes("+line 38 changed"));
  assert.ok(!changedOnly[0]!.includes("line 37"));
});

// --- Corrections (Q07) -----------------------------------------------------

const CORRECTION_DIFF = [
  "diff --git a/c.ts b/c.ts",
  "--- a/c.ts",
  "+++ b/c.ts",
  "@@ -5,3 +5,9 @@",
  " ctx",
  " ctx",
  "+add",
  "+add",
  "+add",
  " ctx",
  "+add",
  "+add",
  "+add",
  "",
].join("\n");

const CORRECTION_CAP_DIFF = [
  "diff --git a/cap.ts b/cap.ts",
  "--- a/cap.ts",
  "+++ b/cap.ts",
  "@@ -5,3 +5,9 @@",
  " ctx",
  " ctx",
  "+add",
  "+add",
  "+add",
  "+add",
  "+add",
  "+add",
  " ctx",
  "",
].join("\n");

const CORRECTION_WIDE_DIFF = [
  "diff --git a/wide.ts b/wide.ts",
  "--- a/wide.ts",
  "+++ b/wide.ts",
  "@@ -5,5 +5,11 @@",
  " ctx",
  " ctx",
  "+add",
  "+add",
  "+add",
  " anchorctx",
  " ctx",
  "+add",
  "+add",
  "+add",
  " ctx",
  "",
].join("\n");

const CORRECTION_BLOB = ["l1", "l2", "l3", "l4", "ctx", "ctx", "add", "add", "add", "ctx", "add", "add", "add"]
  .join("\n") + "\n";

const CORRECTION_CAP_BLOB = ["l1", "l2", "l3", "l4", "ctx", "ctx", "add", "add", "add", "add", "add", "add", "ctx"]
  .join("\n") + "\n";

const CORRECTION_WIDE_BLOB = [
  "l1",
  "l2",
  "l3",
  "l4",
  "ctx",
  "ctx",
  "add",
  "add",
  "add",
  "anchorctx",
  "ctx",
  "add",
  "add",
  "add",
  "ctx",
].join("\n") + "\n";

function previousRange(overrides: {
  path?: string;
  startLine: number;
  endLine: number;
  anchorStartLine: number;
  code: string;
}): Parameters<typeof reResolveForCorrection>[0]["previous"] {
  return {
    path: overrides.path ?? "c.ts",
    commitId: HEAD_SHA,
    startLine: overrides.startLine,
    endLine: overrides.endLine,
    anchorStartLine: overrides.anchorStartLine,
    side: "RIGHT",
    code: overrides.code,
  };
}

test("too_narrow expands over the adjoining added run", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("c.ts", 7, 7, "add"),
    previous: previousRange({ startLine: 7, endLine: 7, anchorStartLine: 7, code: "add" }),
    quality: "too_narrow",
    diff: parseUnifiedDiff(CORRECTION_DIFF),
    blobLines: splitBlobLines(CORRECTION_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") {
    return;
  }
  assert.deepEqual([outcome.range.startLine, outcome.range.endLine], [7, 9]);
  assert.equal(outcome.range.code, "add\nadd\nadd");
  assert.equal(outcome.range.anchorStartLine, 7);
});

test("too_narrow caps the expansion at three lines per side", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("cap.ts", 7, 7, "add"),
    previous: previousRange({ path: "cap.ts", startLine: 7, endLine: 7, anchorStartLine: 7, code: "add" }),
    quality: "too_narrow",
    diff: parseUnifiedDiff(CORRECTION_CAP_DIFF),
    blobLines: splitBlobLines(CORRECTION_CAP_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") {
    return;
  }
  assert.deepEqual([outcome.range.startLine, outcome.range.endLine], [7, 10]);
});

test("too_narrow gives up when the range already covers the added run", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("c.ts", 7, 9, "add"),
    previous: previousRange({ startLine: 7, endLine: 9, anchorStartLine: 7, code: "add\nadd\nadd" }),
    quality: "too_narrow",
    diff: parseUnifiedDiff(CORRECTION_DIFF),
    blobLines: splitBlobLines(CORRECTION_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind !== "skipped") {
    return;
  }
  assert.equal(outcome.reason, "range_retry_exhausted");
});

test("too_wide shrinks to the anchor window and its adjoining added run", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("wide.ts", 10, 10, "anchorctx"),
    previous: previousRange({ path: "wide.ts", startLine: 7, endLine: 14, anchorStartLine: 10, code: "fixture" }),
    quality: "too_wide",
    diff: parseUnifiedDiff(CORRECTION_WIDE_DIFF),
    blobLines: splitBlobLines(CORRECTION_WIDE_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") {
    return;
  }
  assert.deepEqual([outcome.range.startLine, outcome.range.endLine], [7, 10]);
});

test("too_wide gives up when the shrink returns the previous range", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("c.ts", 7, 7, "add"),
    previous: previousRange({ startLine: 7, endLine: 9, anchorStartLine: 7, code: "add\nadd\nadd" }),
    quality: "too_wide",
    diff: parseUnifiedDiff(CORRECTION_DIFF),
    blobLines: splitBlobLines(CORRECTION_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind !== "skipped") {
    return;
  }
  assert.equal(outcome.reason, "range_retry_exhausted");
});

test("too_wide gives up when the anchor window has no added line", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("wide.ts", 5, 5, "ctx"),
    previous: previousRange({ path: "wide.ts", startLine: 5, endLine: 9, anchorStartLine: 5, code: "fixture" }),
    quality: "too_wide",
    diff: parseUnifiedDiff(CORRECTION_WIDE_DIFF),
    blobLines: splitBlobLines(CORRECTION_WIDE_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind !== "skipped") {
    return;
  }
  assert.equal(outcome.reason, "range_retry_exhausted");
});

test("corrections are limited to one attempt and never move wrong_location", () => {
  const base = {
    finding: makeFinding("c.ts", 7, 7, "add"),
    previous: previousRange({ startLine: 7, endLine: 7, anchorStartLine: 7, code: "add" }),
    diff: parseUnifiedDiff(CORRECTION_DIFF),
    blobLines: splitBlobLines(CORRECTION_BLOB),
  };
  for (const quality of ["too_narrow", "too_wide"] as const) {
    const retried = reResolveForCorrection({ ...base, quality, attempt: 1 });
    assert.equal(retried.kind, "skipped", quality);
  }
  const moved = reResolveForCorrection({ ...base, quality: "wrong_location", attempt: 0 });
  assert.equal(moved.kind, "skipped");
  if (moved.kind !== "skipped") {
    return;
  }
  assert.equal(moved.reason, "range_retry_exhausted");
});

test("corrections give up when the previous range belongs to another path", () => {
  const outcome = reResolveForCorrection({
    finding: makeFinding("c.ts", 7, 7, "add"),
    previous: previousRange({ path: "other.ts", startLine: 7, endLine: 7, anchorStartLine: 7, code: "add" }),
    quality: "too_narrow",
    diff: parseUnifiedDiff(CORRECTION_DIFF),
    blobLines: splitBlobLines(CORRECTION_BLOB),
    attempt: 0,
  });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind !== "skipped") {
    return;
  }
  assert.equal(outcome.reason, "range_retry_exhausted");
});

// --- Real repositories -----------------------------------------------------

test("resolveFindings resolves an added file against a real repository", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "src/added.ts", content: "export const a = 1;\nexport const b = 2;\n" }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/added.ts"],
      findings: [makeFinding("src/added.ts", 2, 2, "export const b = 2;")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.equal(range.path, "src/added.ts");
  assert.equal(range.commitId, repo.headSha);
  assert.deepEqual([range.startLine, range.endLine, range.anchorStartLine], [1, 2, 2]);
});

function multiHunkRepoEntries() {
  const base = Array.from({ length: 40 }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`);
  const head = base.map((line, index) => {
    if (index === 2) {
      return "line 03 changed";
    }
    if (index === 37) {
      return "line 38 changed";
    }
    return line;
  });
  return {
    base: [{ path: "file.ts", content: `${base.join("\n")}\n` }],
    head: [{ path: "file.ts", content: `${head.join("\n")}\n` }],
  };
}

test("resolveFindings resolves a line in the second hunk of a real diff", async (t) => {
  const repo = await createRangeRepo(multiHunkRepoEntries());
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["file.ts"],
      findings: [makeFinding("file.ts", 38, 38, "line 38 changed")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.deepEqual([range.startLine, range.endLine], [38, 38]);
  assert.equal(range.code, "line 38 changed");
});

test("resolveFindings accepts a hunk-crossing candidate when the anchor is in one hunk", async (t) => {
  const repo = await createRangeRepo(multiHunkRepoEntries());
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["file.ts"],
      findings: [makeFinding("file.ts", 1, 38, "line 38 changed")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.deepEqual([range.startLine, range.endLine], [38, 38]);
});

test("the parsed diff agrees with git diff --numstat", async (t) => {
  const specs = [
    multiHunkRepoEntries(),
    {
      base: [],
      head: [{ path: "src/added.ts", content: "export const a = 1;\nexport const b = 2;\n" }],
    },
  ];
  for (const spec of specs) {
    const repo = await createRangeRepo(spec);
    t.after(() => rm(repo.root, { recursive: true, force: true }));
    const model = buildDiffModel(repo.root, repo.baseSha, repo.headSha);
    const parsed = diffLineCounts(model);
    let added = 0;
    let removed = 0;
    for (const line of git(repo.root, "diff", "--numstat", repo.baseSha, repo.headSha).trim().split("\n")) {
      const [addedText, removedText] = line.split("\t");
      added += Number(addedText);
      removed += Number(removedText);
    }
    assert.deepEqual(parsed, { added, removed }, repo.root);
  }
});

test("resolveFindings reports rename targets and rejects the old path", async (t) => {
  const baseContent = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  const headContent = baseContent.replace("line 5\n", "line 5 changed\n");
  const repo = await createRangeRepo({
    base: [{ path: "src/old-name.ts", content: baseContent }],
    head: [
      { path: "src/old-name.ts", delete: true },
      { path: "src/new-name.ts", content: headContent },
    ],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/new-name.ts"],
      findings: [
        makeFinding("src/new-name.ts", 5, 5, "line 5 changed"),
        makeFinding("src/old-name.ts", 5, 5, "line 5 changed"),
      ],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.equal(range.path, "src/new-name.ts");
  assert.equal(skipReason(results[1]!), "path_not_changed");
});

test("resolveFindings rejects a deleted file but keeps the changed-path cross-check valid", async (t) => {
  const repo = await createRangeRepo({
    base: [{ path: "src/gone.ts", content: "one\ntwo\n" }],
    head: [{ path: "src/gone.ts", delete: true }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/gone.ts"],
      findings: [makeFinding("src/gone.ts", 1, 1, "one")],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "file_deleted");
});

test("resolveFindings skips binary files through the real diff", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "assets/icon.png", binary: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]) }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["assets/icon.png"],
      findings: [makeFinding("assets/icon.png", 1, 1, "x")],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "file_binary");
});

test("resolveFindings normalizes CRLF blobs from a real repository", async (t) => {
  const repo = await createRangeRepo({
    base: [{ path: "src/windows.txt", content: "first line\r\nsecond line\r\nthird line\r\n" }],
    head: [{ path: "src/windows.txt", content: "first line\r\nsecond changed\r\nthird line\r\n" }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/windows.txt"],
      findings: [makeFinding("src/windows.txt", 2, 2, "second changed")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.equal(range.code, "second changed");
});

test("resolveFindings handles a file without a trailing newline", async (t) => {
  const repo = await createRangeRepo({
    base: [{ path: "src/tail.ts", content: "export const a = 1;\nexport const b = 2;" }],
    head: [{ path: "src/tail.ts", content: "export const a = 1;\nexport const b = 3;" }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/tail.ts"],
      findings: [makeFinding("src/tail.ts", 2, 2, "export const b = 3;")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.deepEqual([range.startLine, range.endLine], [2, 2]);
  assert.equal(range.code, "export const b = 3;");
});

test("resolveFindings handles paths with spaces and Japanese characters", async (t) => {
  const path = "dir with space/ファイル name.ts";
  const repo = await createRangeRepo({
    base: [],
    head: [{ path, content: "export const x = 1;\nexport const y = 2;\n" }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: [path],
      findings: [makeFinding(path, 2, 2, "export const y = 2;")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.equal(range.path, path);
  assert.equal(range.anchorStartLine, 2);
});

test("resolveFindings skips blobs above the byte cap", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "big.txt", content: `${"x".repeat(2_100_000)}\n` }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["big.txt"],
      findings: [makeFinding("big.txt", 1, 1, "x")],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "blob_too_large");
});

test("resolveFindings skips blobs above the line cap", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "many.txt", content: "x\n".repeat(MAX_BLOB_LINES + 1) }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["many.txt"],
      findings: [makeFinding("many.txt", 1, 1, "x")],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "blob_line_limit");
});

test("resolveFindings rejects symlink entries through real git modes", async (t) => {
  const repo = await createRangeRepo({
    base: [{ path: "src/target.ts", content: "target\n" }],
    head: [{ path: "src/link.ts", symlink: "target.ts" }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/link.ts"],
      findings: [makeFinding("src/link.ts", 1, 1, "target.ts")],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "file_symlink_or_submodule");
});

test("resolveFindings rejects submodule entries through real git modes", async (t) => {
  const commit = "1".repeat(40);
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "vendor/sub", submodule: commit }],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["vendor/sub"],
      findings: [makeFinding("vendor/sub", 1, 1, `Subproject commit ${commit}`)],
    },
    { verifyHead: async () => undefined },
  );
  assert.equal(skipReason(results[0]!), "file_symlink_or_submodule");
});

test("resolveFindings stops the batch when GitHub and local changed paths differ", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "src/added.ts", content: "export const a = 1;\n" }],
  });
  cleanup(t, repo.root);
  await assert.rejects(
    resolveFindings(
      {
        workspace: repo.root,
        mergeBase: repo.baseSha,
        headSha: repo.headSha,
        changedPaths: ["other.ts"],
        findings: [],
      },
      { verifyHead: async () => undefined },
    ),
    (error: unknown) => error instanceof RangeRunError && error.kind === "changed_paths",
  );
});

test("resolveFindings accepts GitHub's rename of a local add+delete pair", async (t) => {
  // GitHub may report one rename while local git reports add+delete. Phase 2
  // normalizes that; the cross-check must not turn it into a run error.
  const repo = await createRangeRepo({
    base: [{ path: "src/old.ts", content: "one\ntwo\nthree\n" }],
    head: [
      { path: "src/old.ts", delete: true },
      { path: "src/new.ts", content: "export const replacement = 1;\nexport const other = 2;\n" },
    ],
  });
  cleanup(t, repo.root);
  const results = await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["src/new.ts"],
      findings: [makeFinding("src/new.ts", 2, 2, "export const other = 2;")],
    },
    { verifyHead: async () => undefined },
  );
  const range = resolvedRange(results[0]!);
  assert.equal(range.path, "src/new.ts");
});

test("resolveFindings re-verifies HEAD before touching git", async (t) => {
  const repo = await createRangeRepo({
    base: [],
    head: [{ path: "a.ts", content: "a\n" }],
  });
  cleanup(t, repo.root);
  let verified = false;
  await resolveFindings(
    {
      workspace: repo.root,
      mergeBase: repo.baseSha,
      headSha: repo.headSha,
      changedPaths: ["a.ts"],
      findings: [],
    },
    {
      verifyHead: async () => {
        verified = true;
      },
    },
  );
  assert.equal(verified, true);

  await assert.rejects(
    resolveFindings(
      {
        workspace: "/nonexistent-workspace",
        mergeBase: repo.baseSha,
        headSha: repo.headSha,
        changedPaths: ["a.ts"],
        findings: [],
      },
      {
        verifyHead: async () => {
          throw new RangeRunError("head_changed", "fixture head moved");
        },
      },
    ),
    (error: unknown) => error instanceof RangeRunError && error.kind === "head_changed",
  );
});
