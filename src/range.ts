// Range Resolver (Phase 3): map an AI-reported candidate range to a
// deterministic RIGHT-side comment range using local git facts only.
//
// The resolver follows the seven steps in docs/architecture.md
// "Range Resolver": fixed HEAD, local diff model, GitHub changed-file
// cross-check, path and file-mode safety, HEAD blob lines with trailing-CR
// normalization only, exact anchor matching (candidate first, then a unique
// match elsewhere), and the minimal range that stays inside one hunk and
// contains at least one added line.
//
// Corrections for Jev's too_narrow / too_wide (Q07) are pure functions over a
// parsed diff model and blob lines; the caller tracks attempts (max one).
//
// Module boundary (docs/architecture.md "モジュールと依存"): this module does
// not import opencode.ts or @opencode/*. git is spawned with argument arrays;
// no shell is involved.
import { spawnSync } from "node:child_process";
import type { Finding, JevEvidence, RangeQuality, ResolvedRange } from "./finding.ts";

// --- Limits ----------------------------------------------------------------

/** Blob byte cap. Above this the finding is skipped rather than fetched. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;
/** Blob line cap applied after decoding. */
export const MAX_BLOB_LINES = 50_000;
/** Surrounding blob lines attached to the Jev evidence seam. */
export const DEFAULT_EVIDENCE_CONTEXT_LINES = 5;
/** Per-side cap for the too_narrow correction (Q07, fixed with fixtures). */
export const MAX_CORRECTION_EXPANSION_LINES = 3;

const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const BLOB_MAX_BUFFER = 16 * 1024 * 1024;

// --- Run errors vs finding skips -------------------------------------------

export type RangeRunFailureKind = "head_changed" | "github" | "changed_paths" | "git" | "diff";

/**
 * Context-integrity / environment failure: the batch stops and nothing is
 * published. Per-finding problems use RangeSkipReason instead.
 */
export class RangeRunError extends Error {
  readonly kind: RangeRunFailureKind;
  readonly fields: string[];

  constructor(kind: RangeRunFailureKind, message: string, fields: string[] = []) {
    super(message);
    this.name = "RangeRunError";
    this.kind = kind;
    this.fields = fields;
  }
}

function excerpt(text: string, limit = 300): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}

// --- Diff model ------------------------------------------------------------

export type DiffLineKind = "added" | "removed" | "context" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  /** Exact diff body line including its prefix, trailing CR removed. */
  raw: string;
  /** Line content after the prefix, trailing CR removed. */
  text: string;
  /** 1-based RIGHT line number for added/context lines, else null. */
  newLineNumber: number | null;
  /** 1-based LEFT line number for removed/context lines, else null. */
  oldLineNumber: number | null;
};

export type DiffHunk = {
  /** Raw "@@ -a,b +c,d @@ section" line. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
};

export type DiffFileStatus = "added" | "modified" | "renamed" | "deleted";

export type DiffFile = {
  /** New path; the old path for deleted files (GitHub's filename). */
  path: string;
  previousPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  similarity?: number;
  hunks: DiffHunk[];
};

export type DiffModel = {
  files: Map<string, DiffFile>;
};

export type HunkHeader = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseHunkHeader(header: string): HunkHeader {
  const match = HUNK_HEADER.exec(header);
  if (!match) {
    throw new RangeRunError("diff", "cannot parse a hunk header", ["diff"]);
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    section: (match[5] ?? "").trim(),
  };
}

type HunkBuilder = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
};

type FileBuilder = {
  header: string;
  status: DiffFileStatus;
  binary: boolean;
  similarity: number | null;
  hunks: DiffHunk[];
  sawNewFile: boolean;
  sawDeletedFile: boolean;
  oldMarkerPath: string | null;
  newMarkerPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  binaryOldPath: string | null;
  binaryNewPath: string | null;
};

function newFileBuilder(header: string): FileBuilder {
  return {
    header,
    status: "modified",
    binary: false,
    similarity: null,
    hunks: [],
    sawNewFile: false,
    sawDeletedFile: false,
    oldMarkerPath: null,
    newMarkerPath: null,
    renameFrom: null,
    renameTo: null,
    binaryOldPath: null,
    binaryNewPath: null,
  };
}

/** Strips the "a/" / "b/" prefix of a ---/+++/Binary-files path. */
function stripMarkerPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function markerPath(value: string, prefix: string): string | null {
  // git appends a TAB to ---/+++ names that contain spaces; strip it before
  // interpreting the path (the diff --git header stays tab-free).
  const path = value.endsWith("\t") ? value.slice(0, -1) : value;
  return path === "/dev/null" ? null : stripMarkerPrefix(path, prefix);
}

function parseBinaryLine(line: string): { oldPath: string | null; newPath: string | null } {
  const match = /^Binary files (.*) and (.*) differ$/.exec(line);
  if (!match) {
    return { oldPath: null, newPath: null };
  }
  const oldRaw = match[1] ?? "";
  const newRaw = match[2] ?? "";
  return {
    oldPath: oldRaw === "/dev/null" ? null : stripMarkerPrefix(oldRaw, "a/"),
    newPath: newRaw === "/dev/null" ? null : stripMarkerPrefix(newRaw, "b/"),
  };
}

/**
 * Fallback for blocks without ---/+++ or rename markers (mode-only changes,
 * binary files without a recognizable "Binary files" line). The diff --git
 * header is unambiguous only when both sides carry the same path.
 */
function fallbackPathFromHeader(header: string): string | null {
  const rest = header.slice("diff --git ".length);
  if (!rest.startsWith("a/")) {
    return null;
  }
  let searchFrom = 2;
  for (;;) {
    const index = rest.indexOf(" b/", searchFrom);
    if (index === -1) {
      return null;
    }
    const left = rest.slice(0, index);
    const right = rest.slice(index + 3);
    if (left === `a/${right}`) {
      return right;
    }
    searchFrom = index + 1;
  }
}

function builderStatus(builder: FileBuilder): DiffFileStatus {
  if (builder.renameTo !== null) {
    return "renamed";
  }
  if (builder.sawNewFile) {
    return "added";
  }
  if (builder.sawDeletedFile) {
    return "deleted";
  }
  return "modified";
}

function builderPath(builder: FileBuilder): string | null {
  const status = builderStatus(builder);
  if (status === "deleted") {
    return builder.oldMarkerPath ?? builder.renameFrom ?? builder.binaryOldPath ?? fallbackPathFromHeader(builder.header);
  }
  if (status === "renamed") {
    return builder.renameTo;
  }
  if (status === "added") {
    return builder.newMarkerPath ?? builder.binaryNewPath ?? fallbackPathFromHeader(builder.header);
  }
  return (
    builder.newMarkerPath ??
    builder.oldMarkerPath ??
    builder.binaryNewPath ??
    builder.binaryOldPath ??
    fallbackPathFromHeader(builder.header)
  );
}

function bodyLine(
  raw: string,
  prefix: string,
  currentOldLine: () => number,
  currentNewLine: () => number,
): DiffLine {
  const text = raw.slice(1);
  if (prefix === "+") {
    return { kind: "added", raw, text, newLineNumber: currentNewLine(), oldLineNumber: null };
  }
  if (prefix === "-") {
    return { kind: "removed", raw, text, newLineNumber: null, oldLineNumber: currentOldLine() };
  }
  if (prefix === " ") {
    return { kind: "context", raw, text, newLineNumber: currentNewLine(), oldLineNumber: currentOldLine() };
  }
  return { kind: "meta", raw, text, newLineNumber: null, oldLineNumber: null };
}

/**
 * Parse `git diff --no-ext-diff --no-textconv -M` output. Hunk headers are
 * required: a patch without them is not guessed into shape
 * (docs/architecture.md "hunk headerがないpatchを無理に復元しない").
 */
export function parseUnifiedDiff(text: string): DiffModel {
  const files = new Map<string, DiffFile>();
  let builder: FileBuilder | null = null;
  let hunk: HunkBuilder | null = null;
  let oldLine = 0;
  let newLine = 0;

  const finishHunk = (): void => {
    if (builder !== null && hunk !== null) {
      builder.hunks.push({ ...hunk });
    }
    hunk = null;
  };
  const finishFile = (): void => {
    if (builder === null) {
      return;
    }
    const path = builderPath(builder);
    if (path !== null) {
      files.set(path, {
        path,
        status: builderStatus(builder),
        binary: builder.binary,
        hunks: builder.hunks,
        ...(builder.renameFrom !== null ? { previousPath: builder.renameFrom } : {}),
        ...(builder.similarity !== null ? { similarity: builder.similarity } : {}),
      });
    }
    builder = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      finishHunk();
      finishFile();
      builder = newFileBuilder(line);
      continue;
    }
    if (builder === null) {
      continue;
    }
    if (hunk !== null) {
      const prefix = line.charAt(0);
      if (prefix === "+" || prefix === "-" || prefix === " " || prefix === "\\") {
        hunk.lines.push(bodyLine(line, prefix, () => oldLine, () => newLine));
        if (prefix === "+") {
          newLine += 1;
        } else if (prefix === "-") {
          oldLine += 1;
        } else if (prefix === " ") {
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }
      finishHunk();
    }
    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      hunk = {
        header: line,
        oldStart: parsed.oldStart,
        oldCount: parsed.oldCount,
        newStart: parsed.newStart,
        newCount: parsed.newCount,
        section: parsed.section,
        lines: [],
      };
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      builder.sawNewFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      builder.sawDeletedFile = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      builder.renameFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      builder.renameTo = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("similarity index ")) {
      const percent = /^similarity index (\d+)%$/.exec(line);
      builder.similarity = percent === null ? null : Number(percent[1]);
      continue;
    }
    if (line.startsWith("--- ")) {
      builder.oldMarkerPath = markerPath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      builder.newMarkerPath = markerPath(line.slice(4), "b/");
      continue;
    }
    if (line.startsWith("Binary files ")) {
      const paths = parseBinaryLine(line);
      builder.binaryOldPath = paths.oldPath;
      builder.binaryNewPath = paths.newPath;
      builder.binary = true;
      continue;
    }
  }
  finishHunk();
  finishFile();
  return { files };
}

/** All paths of the model, sorted; matches GitHub's changed-file filenames. */
export function changedPathsFromDiff(diff: DiffModel): string[] {
  return [...diff.files.keys()].sort();
}

// --- Blob lines ------------------------------------------------------------

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Split a HEAD blob into lines; only trailing CR is normalized. */
export function splitBlobLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map(stripTrailingCr);
}

/** Split an anchor into lines; only trailing CR is normalized, nothing else. */
export function splitAnchorLines(anchor: string): string[] {
  return anchor.split("\n").map(stripTrailingCr);
}

function windowMatches(blobLines: readonly string[], anchorLines: readonly string[], startIndex: number): boolean {
  for (let offset = 0; offset < anchorLines.length; offset += 1) {
    if (blobLines[startIndex + offset] !== anchorLines[offset]) {
      return false;
    }
  }
  return true;
}

// --- Skips and outcomes ----------------------------------------------------

export const rangeSkipReasons = [
  "candidate_invalid",
  "path_not_changed",
  "path_unsafe",
  "file_binary",
  "file_deleted",
  "file_symlink_or_submodule",
  "blob_too_large",
  "blob_line_limit",
  "anchor_not_found",
  "anchor_ambiguous",
  "not_in_single_hunk",
  "no_changed_line_in_range",
  "range_retry_exhausted",
] as const;
export type RangeSkipReason = (typeof rangeSkipReasons)[number];

/** Japanese messages recorded in the result file for skipped findings. */
export const rangeSkipMessages: Record<RangeSkipReason, string> = {
  candidate_invalid: "指摘の候補行範囲が不正です。",
  path_not_changed: "指摘対象のpathがPRの変更ファイルに含まれていません。",
  path_unsafe: "pathに絶対path・..・NUL・バックスラッシュなどの不正な要素が含まれています。",
  file_binary: "指摘対象はbinaryファイルのためanchorを検証できません。",
  file_deleted: "指摘対象のファイルはHEADで削除されています。",
  file_symlink_or_submodule: "指摘対象はsymlinkまたはsubmoduleのためコメントできません。",
  blob_too_large: "指摘対象のblobがサイズ上限（2 MiB）を超えています。",
  blob_line_limit: "指摘対象のblobが行数上限（50,000行）を超えています。",
  anchor_not_found: "anchorと完全一致する行がHEADに存在しません。",
  anchor_ambiguous: "anchorがHEAD内で一意に特定できません。",
  not_in_single_hunk: "確定範囲がdiffの同一hunk内に収まりません。",
  no_changed_line_in_range: "確定範囲に追加・変更行が含まれていません。",
  range_retry_exhausted: "範囲の再解決を試みましたが、同じ範囲または解決不能のため打ち切りました。",
};

export type RangeSkip = { kind: "skipped"; reason: RangeSkipReason; message: string };
export type RangeResolved = { kind: "resolved"; range: ResolvedRange };
export type RangeOutcome = RangeResolved | RangeSkip;

export type FindingResolution =
  | { finding: Finding; kind: "resolved"; range: ResolvedRange }
  | { finding: Finding; kind: "skipped"; reason: RangeSkipReason; message: string };

export function skipOutcome(reason: RangeSkipReason, detail = ""): RangeSkip {
  const base = rangeSkipMessages[reason];
  return { kind: "skipped", reason, message: detail.length > 0 ? `${base} (${detail})` : base };
}

// --- Path safety -----------------------------------------------------------

/**
 * Reject absolute paths, Windows drive paths, backslashes, NUL and empty,
 * "." or ".." segments. Paths with spaces or non-ASCII characters stay valid.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.includes("\0") || path.includes("\\")) {
    return false;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

// --- Hunk helpers ----------------------------------------------------------

export function hunkOf(
  diff: DiffModel,
  path: string,
  range: { startLine: number; endLine: number },
): DiffHunk | undefined {
  const file = diff.files.get(path);
  if (!file) {
    return undefined;
  }
  return file.hunks.find(
    (hunk) => hunk.newCount > 0 && hunk.newStart <= range.startLine && range.endLine <= hunk.newStart + hunk.newCount - 1,
  );
}

export function hunksOverlappingRange(
  diff: DiffModel,
  path: string,
  range: { startLine: number; endLine: number },
): DiffHunk[] {
  const file = diff.files.get(path);
  if (!file) {
    return [];
  }
  return file.hunks.filter(
    (hunk) => hunk.newCount > 0 && hunk.newStart <= range.endLine && range.startLine <= hunk.newStart + hunk.newCount - 1,
  );
}

function addedLineNumbers(hunk: DiffHunk): Set<number> {
  const numbers = new Set<number>();
  for (const line of hunk.lines) {
    if (line.kind === "added" && line.newLineNumber !== null) {
      numbers.add(line.newLineNumber);
    }
  }
  return numbers;
}

function rangeHasAddedLine(added: Set<number>, start: number, end: number): boolean {
  for (let line = start; line <= end; line += 1) {
    if (added.has(line)) {
      return true;
    }
  }
  return false;
}

function buildResolvedRange(
  path: string,
  headSha: string,
  startLine: number,
  endLine: number,
  anchorStartLine: number,
  blobLines: readonly string[],
): ResolvedRange {
  return {
    path,
    commitId: headSha,
    startLine,
    endLine,
    anchorStartLine,
    side: "RIGHT",
    code: blobLines.slice(startLine - 1, endLine).join("\n"),
  };
}

// --- Anchor resolution (steps 5 and 6) -------------------------------------

type AnchorWindow = { start: number; end: number };

function closestToCandidate(indices: readonly number[], candidateStart: number): number {
  let best = indices[0]!;
  let bestDistance = Math.abs(best + 1 - candidateStart);
  for (const index of indices.slice(1)) {
    const distance = Math.abs(index + 1 - candidateStart);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Step 5: prefer an exact anchor window fully inside the candidate range; if
 * there is none, adopt the single exact match anywhere in the file. Zero
 * matches and multiple matches outside the candidate are skips, never guesses.
 */
function locateAnchor(finding: Finding, blobLines: readonly string[]): AnchorWindow | RangeSkip {
  const anchorLines = splitAnchorLines(finding.candidateRange.anchor);
  const matches: number[] = [];
  for (let index = 0; index + anchorLines.length <= blobLines.length; index += 1) {
    if (windowMatches(blobLines, anchorLines, index)) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    return skipOutcome("anchor_not_found");
  }
  const candidateStart = finding.candidateRange.start;
  const candidateEnd = finding.candidateRange.end;
  const inside = matches.filter(
    (index) => index + 1 >= candidateStart && index + anchorLines.length <= candidateEnd,
  );
  if (inside.length > 0) {
    const chosen = closestToCandidate(inside, candidateStart);
    return { start: chosen + 1, end: chosen + anchorLines.length };
  }
  if (matches.length === 1) {
    const chosen = matches[0]!;
    return { start: chosen + 1, end: chosen + anchorLines.length };
  }
  return skipOutcome("anchor_ambiguous", `${matches.length} matches`);
}

/**
 * Step 6: minimal contiguous RIGHT range containing the anchor window. The
 * range stays inside one hunk and is expanded only over added lines directly
 * adjoining the window (a maximal contiguous added run); context lines beyond
 * that run are not included. At least one added line is required.
 */
function minimalCommentRange(input: {
  diff: DiffModel;
  path: string;
  headSha: string;
  anchorStart: number;
  anchorEnd: number;
  blobLines: readonly string[];
}): RangeOutcome {
  const hunk = hunkOf(input.diff, input.path, { startLine: input.anchorStart, endLine: input.anchorEnd });
  if (!hunk || hunk.newCount <= 0) {
    return skipOutcome("not_in_single_hunk");
  }
  const hunkStart = hunk.newStart;
  const hunkEnd = hunk.newStart + hunk.newCount - 1;
  if (input.anchorEnd > input.blobLines.length || hunkEnd > input.blobLines.length) {
    return skipOutcome("not_in_single_hunk", "blob is shorter than the hunk");
  }
  const added = addedLineNumbers(hunk);
  let start = input.anchorStart;
  let end = input.anchorEnd;
  while (start - 1 >= hunkStart && added.has(start - 1)) {
    start -= 1;
  }
  while (end + 1 <= hunkEnd && added.has(end + 1)) {
    end += 1;
  }
  if (!rangeHasAddedLine(added, start, end)) {
    return skipOutcome("no_changed_line_in_range");
  }
  return {
    kind: "resolved",
    range: buildResolvedRange(input.path, input.headSha, start, end, input.anchorStart, input.blobLines),
  };
}

// --- Finding resolution ----------------------------------------------------

export type BlobResult = { kind: "ok"; byteLength: number; binary: boolean; lines: string[] } | RangeSkip;

export type ResolveFindingInput = {
  finding: Finding;
  diff: DiffModel;
  headSha: string;
  /** Blob reader seam; resolveFindings passes the git-backed reader. */
  loadBlob: (file: DiffFile) => BlobResult;
};

function skippedFinding(finding: Finding, outcome: RangeSkip): FindingResolution {
  return { finding, kind: "skipped", reason: outcome.reason, message: outcome.message };
}

export function resolveFinding(input: ResolveFindingInput): FindingResolution {
  const { finding } = input;
  const { start, end } = finding.candidateRange;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return skippedFinding(finding, skipOutcome("candidate_invalid"));
  }
  if (!isSafeRepoPath(finding.path)) {
    return skippedFinding(finding, skipOutcome("path_unsafe", finding.path));
  }
  const file = input.diff.files.get(finding.path);
  if (!file) {
    return skippedFinding(finding, skipOutcome("path_not_changed"));
  }
  if (file.status === "deleted") {
    return skippedFinding(finding, skipOutcome("file_deleted"));
  }
  if (file.binary) {
    return skippedFinding(finding, skipOutcome("file_binary"));
  }
  const blob = input.loadBlob(file);
  if (blob.kind === "skipped") {
    return skippedFinding(finding, blob);
  }
  if (blob.binary) {
    return skippedFinding(finding, skipOutcome("file_binary"));
  }
  const anchor = locateAnchor(finding, blob.lines);
  if ("kind" in anchor) {
    return skippedFinding(finding, anchor);
  }
  const outcome = minimalCommentRange({
    diff: input.diff,
    path: finding.path,
    headSha: input.headSha,
    anchorStart: anchor.start,
    anchorEnd: anchor.end,
    blobLines: blob.lines,
  });
  return outcome.kind === "resolved"
    ? { finding, kind: "resolved", range: outcome.range }
    : skippedFinding(finding, outcome);
}

// --- Corrections (Q07) -----------------------------------------------------

export type CorrectionInput = {
  finding: Finding;
  previous: ResolvedRange;
  quality: RangeQuality;
  diff: DiffModel;
  blobLines: readonly string[];
  /** Corrections already performed; only 0 starts a re-resolution. */
  attempt: number;
};

function shrinkToAnchor(input: CorrectionInput): RangeOutcome {
  const anchorLines = splitAnchorLines(input.finding.candidateRange.anchor);
  const anchorStart = input.previous.anchorStartLine;
  const anchorEnd = anchorStart + anchorLines.length - 1;
  if (anchorStart < 1 || anchorEnd > input.blobLines.length) {
    return skipOutcome("range_retry_exhausted", "anchor window is outside the blob");
  }
  if (!windowMatches(input.blobLines, anchorLines, anchorStart - 1)) {
    return skipOutcome("range_retry_exhausted", "anchor no longer matches the blob");
  }
  const outcome = minimalCommentRange({
    diff: input.diff,
    path: input.finding.path,
    headSha: input.previous.commitId,
    anchorStart,
    anchorEnd,
    blobLines: input.blobLines,
  });
  if (outcome.kind === "skipped") {
    return skipOutcome("range_retry_exhausted", `shrink produced ${outcome.reason}`);
  }
  if (outcome.range.startLine === input.previous.startLine && outcome.range.endLine === input.previous.endLine) {
    return skipOutcome("range_retry_exhausted", "corrected range equals the previous range");
  }
  return outcome;
}

function expandWithinHunk(input: CorrectionInput): RangeOutcome {
  const previous = input.previous;
  const hunk = hunkOf(input.diff, input.finding.path, previous);
  if (!hunk || hunk.newCount <= 0) {
    return skipOutcome("range_retry_exhausted", "no hunk contains the previous range");
  }
  if (previous.endLine > input.blobLines.length) {
    return skipOutcome("range_retry_exhausted", "previous range is outside the blob");
  }
  const hunkStart = hunk.newStart;
  const hunkEnd = hunk.newStart + hunk.newCount - 1;
  const added = addedLineNumbers(hunk);
  let runStart = previous.startLine;
  let runEnd = previous.endLine;
  while (runStart - 1 >= hunkStart && added.has(runStart - 1)) {
    runStart -= 1;
  }
  while (runEnd + 1 <= hunkEnd && added.has(runEnd + 1)) {
    runEnd += 1;
  }
  const expandedStart = Math.max(runStart, previous.startLine - MAX_CORRECTION_EXPANSION_LINES, hunkStart);
  const expandedEnd = Math.min(runEnd, previous.endLine + MAX_CORRECTION_EXPANSION_LINES, hunkEnd);
  if (expandedStart === previous.startLine && expandedEnd === previous.endLine) {
    return skipOutcome("range_retry_exhausted", "no wider deterministic range");
  }
  return {
    kind: "resolved",
    range: buildResolvedRange(
      input.finding.path,
      previous.commitId,
      expandedStart,
      expandedEnd,
      previous.anchorStartLine,
      input.blobLines,
    ),
  };
}

/**
 * Pure re-resolution for Jev range failures (docs/architecture.md Q07).
 * too_wide shrinks to the anchor window; too_narrow expands over the adjoining
 * added run capped at +3 lines per side inside the same hunk. A corrected
 * range equal to the previous one, a wrong_location, or an already-used
 * attempt gives up with range_retry_exhausted; the caller never re-evaluates
 * identical input.
 */
export function reResolveForCorrection(input: CorrectionInput): RangeOutcome {
  if (input.attempt !== 0) {
    return skipOutcome("range_retry_exhausted", "re-resolution limit reached");
  }
  if (input.quality === "correct") {
    return skipOutcome("range_retry_exhausted", "range quality is already correct");
  }
  if (input.quality === "wrong_location") {
    return skipOutcome("range_retry_exhausted", "wrong_location has no deterministic relocation");
  }
  if (input.previous.path !== input.finding.path) {
    return skipOutcome("range_retry_exhausted", "previous range is for a different path");
  }
  return input.quality === "too_wide" ? shrinkToAnchor(input) : expandWithinHunk(input);
}

// --- Jev evidence seam -----------------------------------------------------

/** Full hunk text including its header, for Jev evidence. */
export function formatHunk(hunk: DiffHunk): string {
  return [hunk.header, ...hunk.lines.map((line) => line.raw)].join("\n");
}

/** Changed-line-only variant: header plus +/- lines, no context. */
export function formatChangedLines(hunk: DiffHunk): string {
  return [
    hunk.header,
    ...hunk.lines.filter((line) => line.kind === "added" || line.kind === "removed").map((line) => line.raw),
  ].join("\n");
}

export function changedLineEvidence(input: {
  diff: DiffModel;
  path: string;
  range: { startLine: number; endLine: number };
}): string[] {
  return hunksOverlappingRange(input.diff, input.path, input.range).map(formatChangedLines);
}

/** Builds the JevEvidence shape consumed by finding.ts buildJevState. */
export function buildJevEvidence(input: {
  diff: DiffModel;
  path: string;
  blobLines: readonly string[];
  range: { startLine: number; endLine: number };
  contextLines?: number;
}): JevEvidence {
  const context = input.contextLines ?? DEFAULT_EVIDENCE_CONTEXT_LINES;
  const hunks = hunksOverlappingRange(input.diff, input.path, input.range);
  return {
    contextBefore: input.blobLines.slice(Math.max(0, input.range.startLine - 1 - context), input.range.startLine - 1),
    contextAfter: input.blobLines.slice(input.range.endLine, input.range.endLine + context),
    diffHunks: hunks.map(formatHunk),
    evidenceTruncated: false,
  };
}

// --- Git access and batch entrypoint ---------------------------------------

/** Local full diff between merge-base and the fixed HEAD. */
export function buildDiffModel(workspace: string, mergeBase: string, headSha: string): DiffModel {
  // `-M --find-renames` mirrors GitHub's rename reporting so a renamed file is
  // one entry keyed by its new path (docs/architecture.md step 2). The full
  // patch is parsed locally; no external diff is executed.
  const result = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "-M", "--find-renames", mergeBase, headSha],
    { cwd: workspace, encoding: "utf8", maxBuffer: DIFF_MAX_BUFFER, windowsHide: true },
  );
  if (result.error) {
    throw new RangeRunError("diff", "git diff could not start", ["diff"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("diff", `git diff failed: ${excerpt(result.stderr ?? "")}`, ["diff"]);
  }
  return parseUnifiedDiff(result.stdout ?? "");
}

type LsTreeEntry = { mode: string; size: number | null };

function readLsTreeEntry(workspace: string, headSha: string, path: string): LsTreeEntry | undefined {
  const result = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-tree", "-l", "-z", headSha, "--", path],
    { cwd: workspace, encoding: "utf8", maxBuffer: DIFF_MAX_BUFFER, windowsHide: true },
  );
  if (result.error) {
    throw new RangeRunError("git", "git ls-tree could not start", ["git"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("git", `git ls-tree failed: ${excerpt(result.stderr ?? "")}`, ["git"]);
  }
  const record = (result.stdout ?? "").split("\0").find((entry) => entry.length > 0);
  if (record === undefined) {
    return undefined;
  }
  const tabIndex = record.indexOf("\t");
  const meta = record.slice(0, tabIndex === -1 ? undefined : tabIndex).split(" ");
  const mode = meta[0] ?? "";
  const sizeText = meta[3];
  const size = sizeText !== undefined && /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  return { mode, size };
}

/**
 * Reads one HEAD blob through `git show`, after checking its `ls-tree -l`
 * mode and size. Exported so Phase 4 can rebuild the blob lines for range
 * corrections (reResolveForCorrection) without duplicating the caps.
 */
export function readHeadBlob(workspace: string, headSha: string, path: string): BlobResult {
  const entry = readLsTreeEntry(workspace, headSha, path);
  if (entry === undefined) {
    return skipOutcome("file_deleted", "path is not in HEAD");
  }
  if (entry.mode === "120000" || entry.mode === "160000") {
    return skipOutcome("file_symlink_or_submodule", `mode ${entry.mode}`);
  }
  if (!/^100(644|755)$/.test(entry.mode)) {
    return skipOutcome("path_unsafe", `HEAD mode ${entry.mode}`);
  }
  if (entry.size !== null && entry.size > MAX_BLOB_BYTES) {
    return skipOutcome("blob_too_large", `${entry.size} bytes`);
  }
  const result = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "show", `${headSha}:${path}`],
    { cwd: workspace, encoding: "buffer", maxBuffer: BLOB_MAX_BUFFER, windowsHide: true },
  );
  if (result.error) {
    throw new RangeRunError("git", "git show could not start", ["git"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("git", `git show ${path} failed`, ["git"]);
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  if (bytes.length > MAX_BLOB_BYTES) {
    return skipOutcome("blob_too_large", `${bytes.length} bytes`);
  }
  if (bytes.includes(0)) {
    return skipOutcome("file_binary");
  }
  const lines = splitBlobLines(bytes.toString("utf8"));
  if (lines.length > MAX_BLOB_LINES) {
    return skipOutcome("blob_line_limit", `${lines.length} lines`);
  }
  return { kind: "ok", byteLength: bytes.length, binary: false, lines };
}

/**
 * Cross-check the local diff against the GitHub changed-file filename set.
 * They are equal up to the rename normalization of Phase 2
 * (crossCheckChangedPaths): when GitHub reports a rename that local git
 * reported as add + delete, the old path is absent from the GitHub set but
 * present locally as a deleted entry. A GitHub path missing from the local
 * diff, or a non-deleted local path missing from GitHub, is a context-integrity
 * run error instead of a per-finding skip.
 */
function assertChangedPaths(diff: DiffModel, changedPaths: readonly string[]): void {
  const remote = new Set(changedPaths);
  for (const path of remote) {
    if (!diff.files.has(path)) {
      throw new RangeRunError("changed_paths", "GitHub reports a changed path that the local diff does not", [
        "changed_paths",
      ]);
    }
  }
  for (const [path, file] of diff.files) {
    if (!remote.has(path) && file.status !== "deleted") {
      throw new RangeRunError(
        "changed_paths",
        `local diff and GitHub changed files differ (${path} is not in the GitHub list)`,
        ["changed_paths"],
      );
    }
  }
}

export type ResolveFindingsInput = {
  workspace: string;
  mergeBase: string;
  headSha: string;
  /** GitHub changed-file filenames from ReviewContext, rename-new-path form. */
  changedPaths: readonly string[];
  findings: readonly Finding[];
};

export type ResolveFindingsDeps = {
  /**
   * Re-check that the PR head still equals the fixed sha before resolving.
   * Phase 5 repeats this check before posting (docs/architecture.md D14).
   */
  verifyHead: () => Promise<void>;
};

/**
 * Resolve a batch of findings. Context-integrity problems (head moved, GitHub
 * and local path sets differ, git/diff failures) throw RangeRunError and stop
 * the run; per-finding problems become skips with a fixed reason code.
 */
export async function resolveFindings(
  input: ResolveFindingsInput,
  deps: ResolveFindingsDeps,
): Promise<FindingResolution[]> {
  await deps.verifyHead();
  const diff = buildDiffModel(input.workspace, input.mergeBase, input.headSha);
  assertChangedPaths(diff, input.changedPaths);
  return input.findings.map((finding) =>
    resolveFinding({
      finding,
      diff,
      headSha: input.headSha,
      loadBlob: (file) => readHeadBlob(input.workspace, input.headSha, file.path),
    }),
  );
}
