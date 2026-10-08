// OpenCode Finding Producer: fixed-HEAD review workspace, managed config,
// controlled process spawn, NDJSON ingestion and canonical Findings.
//
// This module owns every producer-specific decision (OpenCode CLI arguments,
// child environment, Skill staging, NDJSON parsing). The review core in
// finding.ts stays free of these dependencies (docs/architecture.md).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import * as v from "valibot";
import { reportFindingInputSchema, skillCriteriaExcerpt, type Finding, type JevSkillCriteria, type ReviewContext } from "./finding.ts";
import {
  getPullRequest,
  listChangedFiles,
  type ChangedFile,
  type PrInfo,
} from "./github.ts";
import { reportFindingTemplate } from "./templates.ts";

// --- Limits and shared constants -------------------------------------------

export const MAX_RECORD_BYTES = 32 * 1024;
export const MAX_NDJSON_BYTES = 4 * 1024 * 1024;
export const MAX_TAIL_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_PROMPT_PATHS = 500;
const AGENT_NAME = "reviewer";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Managed config exclusion set (decisions.md D26): PR-side runtime config and
// environment files never reach the review workspace. AGENTS.md is kept because
// OPENCODE_DISABLE_PROJECT_CONFIG=1 already disables its discovery (D21).
export const WORKSPACE_EXCLUDED_DIRECTORIES = [".opencode"] as const;
export const WORKSPACE_EXCLUDED_FILES = ["opencode.json", "opencode.jsonc"] as const;
export const WORKSPACE_ENV_PREFIX = ".env";

// --- Failure classification ------------------------------------------------

export type ReviewFailureKind =
  | "github"
  | "head_changed"
  | "workspace"
  | "changed_paths"
  | "skill"
  | "config"
  | "spawn"
  | "timeout"
  | "cancelled"
  | "producer"
  | "ndjson_missing"
  | "ndjson_corrupt"
  | "ndjson_too_large"
  | "limit_exceeded";

export class ReviewRunError extends Error {
  readonly kind: ReviewFailureKind;
  readonly fields: string[];

  constructor(kind: ReviewFailureKind, message: string, fields: string[] = []) {
    super(message);
    this.name = "ReviewRunError";
    this.kind = kind;
    this.fields = fields;
  }
}

function excerpt(text: string, limit = 300): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}

// --- Bounded buffers -------------------------------------------------------

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      return;
    }
    const remaining = this.limit - this.size;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- Child environment (pure, unit tested) ---------------------------------

export type ChildEnvironmentInput = {
  parentEnv: Record<string, string | undefined>;
  model: string;
  homeDir: string;
  tempDir: string;
  ndjsonPath: string;
  changedPathsPath: string;
  canaryMarkerPath: string;
  maxFindings: number;
  recordLimitBytes: number;
  /**
   * Protected secret values that must never reach the child: TYPESAFE_*,
   * GITHUB_TOKEN, GH_TOKEN. The shared OpenCode credential is inherited by
   * design when the provider is opencode/opencode-go, free and paid (D28).
   */
  protectedValues?: readonly string[];
};

export type ChildEnvironment = {
  env: Record<string, string>;
  providerKeyName: string | null;
};

// Minimal provider -> credential mapping mirroring the models.dev environment
// lists. The map grows only when an allowed model provider needs it; the
// OpenCode free provider works anonymously.
const providerCredentialNames: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
};

const forbiddenChildEnvNames = /^(TYPESAFE_[A-Z0-9_]*|GITHUB_TOKEN|GH_TOKEN)$/;

export function providerFromModel(model: string): string {
  const withoutVariant = model.split("#", 1)[0] ?? model;
  return withoutVariant.split("/", 1)[0] ?? withoutVariant;
}

export function buildChildEnvironment(input: ChildEnvironmentInput): ChildEnvironment {
  const parent = input.parentEnv;
  const path = parent["PATH"];
  if (!path || path.trim().length === 0) {
    throw new ReviewRunError("config", "PATH is required to spawn OpenCode", ["PATH"]);
  }

  const env: Record<string, string> = {
    PATH: path,
    HOME: input.homeDir,
    XDG_CONFIG_HOME: join(input.homeDir, ".config"),
    TMPDIR: input.tempDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    REVIEW_NDJSON_PATH: input.ndjsonPath,
    REVIEW_CHANGED_PATHS: input.changedPathsPath,
    REVIEW_CANARY_MARKER: input.canaryMarkerPath,
    REVIEW_MAX_FINDINGS: String(input.maxFindings),
    REVIEW_RECORD_LIMIT_BYTES: String(input.recordLimitBytes),
  };
  for (const name of ["LANG", "LC_ALL"]) {
    const value = parent[name];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }

  const provider = providerFromModel(input.model);
  let providerKeyName: string | null = null;
  for (const name of providerCredentialNames[provider] ?? []) {
    const value = parent[name];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
      providerKeyName = name;
      break;
    }
  }

  // D24/D28: a child value equal to a protected secret (TYPESAFE_*,
  // GITHUB_TOKEN, GH_TOKEN) is refused before spawn.
  const protectedValues = [
    ...(input.protectedValues ?? []),
    parent["TYPESAFE_API_KEY"],
    parent["GITHUB_TOKEN"],
    parent["GH_TOKEN"],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const [name, value] of Object.entries(env)) {
    if (protectedValues.includes(value)) {
      throw new ReviewRunError("config", `refusing to pass ${name}: value equals a protected secret`, [name]);
    }
  }
  for (const name of Object.keys(env)) {
    if (forbiddenChildEnvNames.test(name)) {
      throw new ReviewRunError("config", `internal allowlist error: ${name} must never reach the child`, [name]);
    }
  }
  return { env, providerKeyName };
}

// --- CLI command and prompt (pure) -----------------------------------------

export type OpenCodeCommand = {
  command: string;
  args: string[];
};

export function buildOpenCodeCommand(input: {
  cliPath: string;
  model: string;
  agent: string;
  prompt: string;
}): OpenCodeCommand {
  return {
    command: input.cliPath,
    args: ["run", "--standalone", "--format", "json", "--agent", input.agent, "--model", input.model, input.prompt],
  };
}

export function buildReviewerPrompt(skillName: string, changedPaths: readonly string[]): string {
  const listed = changedPaths.slice(0, MAX_PROMPT_PATHS);
  const list = listed.map((path) => `- ${path}`).join("\n");
  const omitted = changedPaths.length - listed.length;
  const more = omitted > 0 ? `\n- ... and ${omitted} more changed files` : "";
  return [
    "You review one pull request as the finding producer for an automated review pipeline.",
    "",
    "Workspace:",
    "- The current working directory is a checkout pinned to the PR HEAD. Treat it as read-only.",
    "- Only these files were changed by this PR; report findings only for these paths:",
    list + more,
    "",
    "Process:",
    `1. Load the "${skillName}" skill and follow its review criteria.`,
    "2. Read the changed files and enough surrounding code to understand the behavior.",
    "3. Call report_finding once per concrete problem. It is the only formal output channel; text output is not read by the pipeline.",
    "4. If you find no concrete problem, finish without calling report_finding.",
    "",
    "report_finding fields:",
    "- path: one of the changed paths above (repository-relative, HEAD/new side).",
    "- candidateStart, candidateEnd: 1-based inclusive line numbers in the HEAD file, candidateStart <= candidateEnd.",
    "- anchor: the exact contiguous source text of those lines, copied verbatim from the read tool output instead of retyping. Keep every character, including leading whitespace and indentation; never trim, re-indent, or add markdown fences.",
    '- anchor example: correct "  return n - 1;" (two leading spaces kept); wrong "return n - 1;" (indentation lost).',
    "- severity: critical | high | medium | low by concrete impact.",
    "- title: short problem name. body: trigger, evidence and impact.",
    "",
    "The pipeline re-checks path, line numbers and anchor against the fixed HEAD; incorrect values are rejected or dropped.",
  ].join("\n");
}

// --- Managed OpenCode config (temp HOME) -----------------------------------

export type PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny";
};

export function reviewerPermissions(skillName: string, skillDir: string): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "skill", resource: skillName, effect: "allow" },
    { action: "report_finding", resource: "*", effect: "allow" },
    { action: "external_directory", resource: `${skillDir}/*`, effect: "allow" },
  ];
}

export const CANARY_PLUGIN_FILE = "canary.ts";
export const REPORT_FINDING_PLUGIN_FILE = "report-finding.ts";

// Positive canary (decisions.md D26): a malformed or ignored managed config can
// leave the CLI running with fewer plugins without failing the process. The
// canary writes a marker during plugin setup so a run is only trusted when the
// managed plugin layer was actually loaded.
export const canaryPluginText = `// Managed canary plugin: proves that the managed OpenCode config was loaded.
// The marker path comes from the Action-injected environment, never from model input.
export default {
  id: "review-config-canary",
  async setup() {
    const marker = process.env.REVIEW_CANARY_MARKER;
    if (!marker) return;
    const fs = await import("node:fs/promises");
    await fs.writeFile(marker, "loaded", "utf8");
  },
};
`;

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function permissionsYaml(permissions: readonly PermissionRule[]): string {
  return permissions
    .map((rule) => `  - { action: ${yamlString(rule.action)}, resource: ${yamlString(rule.resource)}, effect: ${yamlString(rule.effect)} }`)
    .join("\n");
}

export type ManagedConfigInput = {
  tempHome: string;
  skillName: string;
  skillDir: string;
  prompt: string;
};

export type ManagedConfig = {
  configDir: string;
  agentPath: string;
  reportFindingPluginPath: string;
  canaryPluginPath: string;
  skillsDir: string;
};

/**
 * Materialize the only files OpenCode may read under the temp HOME:
 * opencode.json (v2 ordered permissions), agents/reviewer.md, the report_finding
 * plugin text and the canary plugin. The Skill directory is filled by
 * stageSkillFromHead. No other files are written.
 */
export async function stageManagedConfigDir(input: ManagedConfigInput): Promise<ManagedConfig> {
  const configDir = join(input.tempHome, ".config", "opencode");
  const agentPath = join(configDir, "agents", `${AGENT_NAME}.md`);
  const pluginsDir = join(configDir, "plugins");
  const skillsDir = join(configDir, "skills");
  const reportFindingPluginPath = join(pluginsDir, REPORT_FINDING_PLUGIN_FILE);
  const canaryPluginPath = join(pluginsDir, CANARY_PLUGIN_FILE);
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  const permissions = reviewerPermissions(input.skillName, input.skillDir);
  const config = {
    $schema: "https://opencode.ai/config.json",
    permissions,
  };
  await writeFile(join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // The agent frontmatter carries the same ordered rules. Global config rules
  // and agent rules both append to the built-in defaults; keeping both layers
  // identical makes the policy resilient to either config source being ignored
  // (agent frontmatter was the measured 2.0.22 source, config is the documented
  // v2 source).
  const agent = [
    "---",
    `description: ${yamlString("OpenCode review producer for one pull request")}`,
    "mode: primary",
    "permissions:",
    permissionsYaml(permissions),
    "---",
    input.prompt,
    "",
  ].join("\n");
  await writeFile(agentPath, agent, "utf8");
  await writeFile(reportFindingPluginPath, reportFindingTemplate, "utf8");
  await writeFile(canaryPluginPath, canaryPluginText, "utf8");

  return { configDir, agentPath, reportFindingPluginPath, canaryPluginPath, skillsDir };
}

// --- Skill staging ---------------------------------------------------------

export type StagedSkill = {
  name: string;
  description: string;
  sourceDir: string;
  stagedDir: string;
  fileCount: number;
  /** SKILL.md body (frontmatter removed, capped) used as Jev skill criteria. */
  criteria: string;
};

/** Body after the closing frontmatter fence; "" when the block is missing. */
export function skillBodyFromMarkdown(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return "";
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return "";
  }
  return lines.slice(end + 1).join("\n").trim();
}

export function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new ReviewRunError("skill", "SKILL.md must start with YAML frontmatter", ["SKILL.md"]);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter is not terminated", ["SKILL.md"]);
  }
  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const key = match[1];
    const rawValue = (match[2] ?? "").trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2").trim();
    if (key === "name") {
      name = value;
    }
    if (key === "description") {
      description = value;
    }
  }
  if (name === undefined || !SKILL_NAME_PATTERN.test(name)) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter name is missing or invalid", ["SKILL.md", "name"]);
  }
  if (description === undefined || description.length === 0 || description.length > 1024) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter description must be 1..1024 characters", ["SKILL.md", "description"]);
  }
  if (/^[|>]/.test(description)) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter description must be a single-line value", ["SKILL.md", "description"]);
  }
  return { name, description };
}

export function parseLsTreeZ(output: string): Array<{ mode: string; type: string; path: string }> {
  return output
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tabIndex = record.indexOf("\t");
      const meta = record.slice(0, tabIndex).split(" ");
      return {
        mode: meta[0] ?? "",
        type: meta[1] ?? "",
        path: record.slice(tabIndex + 1),
      };
    });
}

class GitCommandError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`git exited with status ${status}`);
    this.name = "GitCommandError";
    this.status = status;
  }
}

function runGit(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    throw new GitCommandError(-1);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGitBytes(args: string[], cwd: string): { status: number; stdout: Buffer; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    throw new GitCommandError(-1);
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return { status: result.status ?? 1, stdout, stderr: typeof result.stderr === "string" ? result.stderr : "" };
}

function gitOrThrow(args: string[], cwd: string, kind: ReviewFailureKind, fields: string[]): string {
  let result: { status: number; stdout: string; stderr: string };
  try {
    result = runGit(args, cwd);
  } catch {
    throw new ReviewRunError(kind, `git ${args[0] ?? ""} could not start`, fields);
  }
  if (result.status !== 0) {
    throw new ReviewRunError(kind, `git ${args[0] ?? ""} failed: ${excerpt(result.stderr)}`, fields);
  }
  return result.stdout;
}

function gitShowBytes(workspace: string, revision: string, path: string, kind: ReviewFailureKind, fields: string[]): Buffer {
  let result: { status: number; stdout: Buffer; stderr: string };
  try {
    result = runGitBytes(["show", `${revision}:${path}`], workspace);
  } catch {
    throw new ReviewRunError(kind, "git show could not start", fields);
  }
  if (result.status !== 0) {
    throw new ReviewRunError(kind, `git show ${path} failed`, fields);
  }
  return result.stdout;
}

export async function stageSkillFromHead(input: {
  workspace: string;
  headSha: string;
  skillName: string;
  skillsRoot: string;
}): Promise<StagedSkill> {
  if (!SKILL_NAME_PATTERN.test(input.skillName)) {
    throw new ReviewRunError("skill", "skill name is invalid", ["skill"]);
  }
  const prefix = `.opencode/skills/${input.skillName}`;
  const skillFile = gitShowBytes(input.workspace, input.headSha, `${prefix}/SKILL.md`, "skill", ["skill"]);
  const skillText = skillFile.toString("utf8");
  const frontmatter = parseSkillFrontmatter(skillText);
  if (frontmatter.name !== input.skillName) {
    throw new ReviewRunError(
      "skill",
      `SKILL.md name "${frontmatter.name}" does not match the requested skill "${input.skillName}"`,
      ["skill"],
    );
  }

  const treeOutput = gitOrThrow(["ls-tree", "-r", "-z", input.headSha, "--", prefix], input.workspace, "skill", ["skill"]);
  const entries = parseLsTreeZ(treeOutput);
  if (entries.length === 0 || entries.length > MAX_SKILL_FILES) {
    throw new ReviewRunError("skill", `skill must contain 1..${MAX_SKILL_FILES} files`, ["skill"]);
  }
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type !== "blob" || !/^100(644|755)$/.test(entry.mode)) {
      throw new ReviewRunError("skill", "skill directory contains a symlink, submodule or non-regular file", ["skill"]);
    }
    const relativePath = relative(prefix, entry.path);
    if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new ReviewRunError("skill", "skill entry escapes its directory", ["skill"]);
    }
    const bytes = gitShowBytes(input.workspace, input.headSha, entry.path, "skill", ["skill"]);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SKILL_BYTES) {
      throw new ReviewRunError("skill", `skill exceeds ${MAX_SKILL_BYTES} bytes`, ["skill"]);
    }
    files.push({ relativePath, bytes });
  }

  const stagedDir = join(input.skillsRoot, input.skillName);
  await mkdir(stagedDir, { recursive: true });
  for (const file of files) {
    const target = join(stagedDir, file.relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.bytes);
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    sourceDir: prefix,
    stagedDir,
    fileCount: files.length,
    criteria: skillCriteriaExcerpt(skillBodyFromMarkdown(skillText)),
  };
}

// --- Fixed-HEAD workspace --------------------------------------------------

export async function extractHeadArchive(input: { workspace: string; headSha: string; destDir: string }): Promise<void> {
  await mkdir(input.destDir, { recursive: true });
  const archiveErr = new BoundedBuffer(8192);
  const tarErr = new BoundedBuffer(8192);
  try {
    const archive = spawn("git", ["-C", input.workspace, "archive", "--format=tar", input.headSha], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const tar = spawn("tar", ["-x", "-C", input.destDir], {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    archive.stderr.on("data", (chunk: Buffer) => archiveErr.push(chunk));
    tar.stderr.on("data", (chunk: Buffer) => tarErr.push(chunk));
    archive.stdout.pipe(tar.stdin);
    const [archiveExit, tarExit] = await Promise.all([waitForClose(archive), waitForClose(tar)]);
    if (archiveExit.code !== 0) {
      throw new ReviewRunError("workspace", `git archive failed: ${excerpt(archiveErr.text())}`, ["workspace"]);
    }
    if (tarExit.code !== 0) {
      throw new ReviewRunError("workspace", `tar failed: ${excerpt(tarErr.text())}`, ["workspace"]);
    }
  } catch (error) {
    if (error instanceof ReviewRunError) {
      throw error;
    }
    throw new ReviewRunError("workspace", `extracting the PR HEAD failed: ${error instanceof Error ? error.name : "unknown error"}`, ["workspace"]);
  }
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function applyWorkspaceExclusions(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const excluded =
        (entry.isDirectory() && (WORKSPACE_EXCLUDED_DIRECTORIES as readonly string[]).includes(entry.name)) ||
        (WORKSPACE_EXCLUDED_FILES as readonly string[]).includes(entry.name) ||
        entry.name.startsWith(WORKSPACE_ENV_PREFIX);
      if (excluded) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }
}

// --- Context preparation (event + GitHub metadata + local git) --------------

export type PreparedReview = {
  context: ReviewContext;
  mergeBase: string;
  changedPaths: string[];
  workspace: string;
};

export type PrepareReviewDeps = {
  getPullRequest?: typeof getPullRequest;
  listChangedFiles?: typeof listChangedFiles;
  /** @internal Test seam: GitHub API base URL forwarded to the metadata reads. */
  baseUrl?: string;
  /** @internal Test seam: GitHub fetch implementation forwarded to the metadata reads. */
  fetchImpl?: typeof fetch;
};

export type LocalChange = {
  status: string;
  path: string;
  previousPath?: string;
};

export function parseNameStatusZ(output: string): LocalChange[] {
  const tokens = output.split("\0");
  const changes: LocalChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (!status) {
      continue;
    }
    const code = status.slice(0, 1).toUpperCase();
    if (code === "R" || code === "C") {
      const previousPath = tokens[index];
      const path = tokens[index + 1];
      index += 2;
      if (!previousPath || !path) {
        throw new ReviewRunError("changed_paths", "git diff --name-status output was truncated", ["changed_paths"]);
      }
      changes.push({ status, path, previousPath });
    } else {
      const path = tokens[index];
      index += 1;
      if (!path) {
        throw new ReviewRunError("changed_paths", "git diff --name-status output was truncated", ["changed_paths"]);
      }
      changes.push({ status, path });
    }
  }
  return changes;
}

/**
 * GitHub reports both sides of a rename as one entry, while local git rename
 * detection can also report an add + delete pair. Normalizing with GitHub's
 * `previous_filename` keeps a strict set equality without guessing.
 */
export function crossCheckChangedPaths(
  local: readonly LocalChange[],
  remote: readonly ChangedFile[],
): { ok: true; paths: string[] } | { ok: false; local: string[]; remote: string[] } {
  const remotePaths = [...new Set(remote.map((file) => file.filename))].sort();
  const localSet = new Set(local.map((change) => change.path));
  for (const file of remote) {
    if (file.status === "renamed" && file.previous_filename) {
      localSet.delete(file.previous_filename);
    }
  }
  const localPaths = [...localSet].sort();
  const equal = localPaths.length === remotePaths.length && localPaths.every((path, index) => path === remotePaths[index]);
  return equal ? { ok: true, paths: remotePaths } : { ok: false, local: localPaths, remote: remotePaths };
}

function wrapGitHubError(error: unknown, what: string): ReviewRunError {
  if (error instanceof ReviewRunError) {
    return error;
  }
  if (error instanceof Error && error.name === "HeadChangedError") {
    return new ReviewRunError("head_changed", error.message, ["head.sha"]);
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return new ReviewRunError("github", `${what}: ${message}`, ["github"]);
}

export async function prepareReviewContext(
  input: { context: ReviewContext; token: string; workspace: string; signal?: AbortSignal },
  deps: PrepareReviewDeps = {},
): Promise<PreparedReview> {
  const readPullRequest = deps.getPullRequest ?? getPullRequest;
  const readChangedFiles = deps.listChangedFiles ?? listChangedFiles;
  const { context } = input;

  let live: PrInfo;
  try {
    live = await readPullRequest(input.token, context.repository, context.pullNumber, {
      signal: input.signal,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    throw wrapGitHubError(error, "reading pull request metadata");
  }
  if (live.head.sha.toLowerCase() !== context.headSha.toLowerCase()) {
    throw new ReviewRunError(
      "head_changed",
      `PR head changed during context: event ${context.headSha}, live ${live.head.sha.toLowerCase()}`,
      ["head.sha"],
    );
  }
  if (live.head.repo.full_name.toLowerCase() !== context.repository.toLowerCase()) {
    throw new ReviewRunError("head_changed", "PR head repository changed during context", ["head.repo.full_name"]);
  }

  const head = gitOrThrow(["rev-parse", "HEAD"], input.workspace, "workspace", ["GITHUB_WORKSPACE"]).trim().toLowerCase();
  if (!SHA_PATTERN.test(head)) {
    throw new ReviewRunError("workspace", "workspace HEAD is not a commit sha", ["GITHUB_WORKSPACE"]);
  }
  if (head !== context.headSha.toLowerCase()) {
    throw new ReviewRunError("workspace", "workspace is not checked out at the PR head", ["GITHUB_WORKSPACE"]);
  }
  gitOrThrow(["cat-file", "-e", `${context.baseSha}^{commit}`], input.workspace, "workspace", ["base.sha"]);
  const mergeBase = gitOrThrow(["merge-base", context.baseSha, context.headSha], input.workspace, "workspace", ["base.sha"])
    .trim()
    .toLowerCase();
  if (!SHA_PATTERN.test(mergeBase)) {
    throw new ReviewRunError("workspace", "merge-base did not return a commit sha", ["base.sha"]);
  }

  const diffOutput = gitOrThrow(
    ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", mergeBase, context.headSha],
    input.workspace,
    "changed_paths",
    ["changed_paths"],
  );
  const local = parseNameStatusZ(diffOutput);
  let remote: ChangedFile[];
  try {
    remote = await readChangedFiles(input.token, context.repository, context.pullNumber, {
      signal: input.signal,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    throw wrapGitHubError(error, "reading changed files");
  }
  const check = crossCheckChangedPaths(local, remote);
  if (!check.ok) {
    throw new ReviewRunError(
      "changed_paths",
      `changed path sets differ (local ${check.local.length}, GitHub ${check.remote.length})`,
      ["changed_paths"],
    );
  }
  return { context, mergeBase, changedPaths: check.paths, workspace: input.workspace };
}

// --- Session spawn ---------------------------------------------------------

export type SessionOutcome = {
  kind: "exit" | "timeout" | "cancelled" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  message?: string;
};

export type SessionOptions = {
  command: OpenCodeCommand;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  killGraceMs?: number;
  tailBytes?: number;
};

export async function runOpenCodeSession(options: SessionOptions): Promise<SessionOutcome> {
  const tailLimit = options.tailBytes ?? MAX_TAIL_BYTES;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const stdout = new BoundedBuffer(tailLimit);
  const stderr = new BoundedBuffer(tailLimit);
  const stdoutLog = options.stdoutLogPath ? new BoundedBuffer(MAX_LOG_BYTES) : null;
  const stderrLog = options.stderrLogPath ? new BoundedBuffer(MAX_LOG_BYTES) : null;

  const outcome = await new Promise<SessionOutcome>((resolveOutcome) => {
    let settled = false;
    let kind: SessionOutcome["kind"] = "exit";
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardStopTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    let spawnError: Error | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardStopTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: SessionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveOutcome(result);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // The child may already be gone; the close event settles the promise.
      }
    };
    const onAbort = (): void => {
      kind = "cancelled";
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), grace);
    };
    const tails = (): Pick<SessionOutcome, "stdoutTail" | "stderrTail"> => ({ stdoutTail: stdout.text(), stderrTail: stderr.text() });

    try {
      child = spawn(options.command.command, options.command.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error("spawn failed");
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: spawnError.name });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutLog?.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      stderrLog?.push(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: error.name });
    });
    child.once("close", (code, signal) => {
      finish({ kind, code, signal, ...tails() });
    });

    if (options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        kind = "timeout";
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), grace);
        hardStopTimer = setTimeout(() => {
          finish({ kind: "timeout", code: null, signal: null, ...tails() });
        }, grace + 5000);
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (spawnError) {
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: spawnError.name });
    }
  });

  if (options.stdoutLogPath && stdoutLog) {
    await writeFile(options.stdoutLogPath, stdoutLog.text(), "utf8").catch(() => undefined);
  }
  if (options.stderrLogPath && stderrLog) {
    await writeFile(options.stderrLogPath, stderrLog.text(), "utf8").catch(() => undefined);
  }
  return outcome;
}

// --- NDJSON ingestion ------------------------------------------------------

export type FindingReadResult = {
  findings: Finding[];
  rejected: Array<{ line: number; reason: string }>;
  lineCount: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCoreFindingId(value: string): boolean {
  return uuidPattern.test(value);
}

function rejectReason(issues: v.BaseIssue<unknown>[]): string {
  const issue = issues[0];
  if (!issue) {
    return "schema validation failed";
  }
  const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";
  const message = excerpt(issue.message, 120);
  return path.length > 0 ? `${path}: ${message}` : message;
}

/**
 * Parse one invocation's NDJSON. Structural damage (unparseable line, partial
 * final line, non-object record) is a run error; a JSON object that fails the
 * canonical schema is a per-record reject so other findings survive
 * (docs/architecture.md "壊れたファイルはrun error").
 */
export async function readFindings(input: {
  ndjsonPath: string;
  skill: string;
  maxFindings: number;
}): Promise<FindingReadResult> {
  let size: number;
  try {
    size = (await stat(input.ndjsonPath)).size;
  } catch {
    throw new ReviewRunError("ndjson_missing", "findings file is missing", ["findings.ndjson"]);
  }
  if (size > MAX_NDJSON_BYTES) {
    throw new ReviewRunError("ndjson_too_large", `findings file exceeds ${MAX_NDJSON_BYTES} bytes`, ["findings.ndjson"]);
  }
  const text = await readFile(input.ndjsonPath, "utf8");
  if (text.length === 0) {
    return { findings: [], rejected: [], lineCount: 0 };
  }
  if (!text.endsWith("\n")) {
    throw new ReviewRunError("ndjson_corrupt", "findings file ends with a partial line", ["findings.ndjson"]);
  }
  const lines = text.slice(0, -1).split("\n");
  const findings: Finding[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new ReviewRunError("ndjson_corrupt", `findings file has an empty line at line ${lineNumber}`, ["findings.ndjson"]);
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ReviewRunError("ndjson_corrupt", `findings file has an unparseable line at line ${lineNumber}`, ["findings.ndjson"]);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new ReviewRunError("ndjson_corrupt", `findings record at line ${lineNumber} is not an object`, ["findings.ndjson"]);
    }
    const parsed = v.safeParse(reportFindingInputSchema, record);
    if (!parsed.success) {
      rejected.push({ line: lineNumber, reason: rejectReason(parsed.issues) });
      continue;
    }
    if (findings.length >= input.maxFindings) {
      throw new ReviewRunError("limit_exceeded", `findings file exceeds max-findings (${input.maxFindings})`, ["max-findings"]);
    }
    const entry = parsed.output;
    findings.push({
      id: randomUUID(),
      skill: input.skill,
      path: entry.path,
      candidateRange: { start: entry.candidateStart, end: entry.candidateEnd, anchor: entry.anchor },
      severity: entry.severity,
      title: entry.title,
      body: entry.body,
    });
  }
  return { findings, rejected, lineCount: lines.length };
}

// --- Producer orchestration ------------------------------------------------

export type ReviewStaging = {
  root: string;
  homeDir: string;
  workspaceDir: string;
  ndjsonPath: string;
  changedPathsPath: string;
  canaryMarkerPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export async function createReviewStaging(runnerTemp: string): Promise<ReviewStaging> {
  const root = await mkdtemp(join(runnerTemp, "review-"));
  return {
    root,
    homeDir: join(root, "home"),
    workspaceDir: join(root, "workspace"),
    ndjsonPath: join(root, "findings.ndjson"),
    changedPathsPath: join(root, "changed-paths.json"),
    canaryMarkerPath: join(root, "canary.marker"),
    stdoutLogPath: join(root, "opencode.stdout.log"),
    stderrLogPath: join(root, "opencode.stderr.log"),
  };
}

export type ProducerOptions = {
  runnerTemp: string;
  prepared: PreparedReview;
  model: string;
  timeoutMs: number;
  maxFindings: number;
  parentEnv: Record<string, string | undefined>;
  protectedValues?: readonly string[];
  cliPath?: string;
  /** Test seam: replaces the built OpenCode command entirely. */
  command?: OpenCodeCommand;
  keepArtifacts?: boolean;
  signal?: AbortSignal;
  killGraceMs?: number;
};

export type ProducerOutcome = {
  findings: Finding[];
  rejected: Array<{ line: number; reason: string }>;
  canaryPresent: boolean;
  stagingDir: string;
  exit: SessionOutcome;
  /** Selected SKILL.md criteria excerpt for the Jev state (Phase 4). */
  skillCriteria: JevSkillCriteria;
};

/**
 * Run one producer invocation: stage the workspace and managed config, spawn
 * OpenCode once, verify the canary, and read canonical Findings. Every exit
 * path cleans the staging directory unless REVIEW_KEEP_ARTIFACTS=1
 * (decisions.md D26) or keepArtifacts is set.
 */
export async function runFindingProducer(options: ProducerOptions): Promise<ProducerOutcome> {
  const keepArtifacts = options.keepArtifacts ?? options.parentEnv["REVIEW_KEEP_ARTIFACTS"] === "1";
  const staging = await createReviewStaging(options.runnerTemp);
  try {
    await writeFile(staging.changedPathsPath, JSON.stringify(options.prepared.changedPaths), "utf8");
    // The Action pre-creates the empty file; the Tool template appends to it
    // (and would create it if missing, which readFindings then rejects).
    await writeFile(staging.ndjsonPath, "", "utf8");
    await extractHeadArchive({
      workspace: options.prepared.workspace,
      headSha: options.prepared.context.headSha,
      destDir: staging.workspaceDir,
    });
    await applyWorkspaceExclusions(staging.workspaceDir);

    const skillDir = join(staging.homeDir, ".config", "opencode", "skills", options.prepared.context.skill);
    await stageManagedConfigDir({
      tempHome: staging.homeDir,
      skillName: options.prepared.context.skill,
      skillDir,
      prompt: buildReviewerPrompt(options.prepared.context.skill, options.prepared.changedPaths),
    });
    const stagedSkill = await stageSkillFromHead({
      workspace: options.prepared.workspace,
      headSha: options.prepared.context.headSha,
      skillName: options.prepared.context.skill,
      skillsRoot: join(staging.homeDir, ".config", "opencode", "skills"),
    });

    const childEnvironment = buildChildEnvironment({
      parentEnv: options.parentEnv,
      model: options.model,
      homeDir: staging.homeDir,
      tempDir: staging.root,
      ndjsonPath: staging.ndjsonPath,
      changedPathsPath: staging.changedPathsPath,
      canaryMarkerPath: staging.canaryMarkerPath,
      maxFindings: options.maxFindings,
      recordLimitBytes: MAX_RECORD_BYTES,
      protectedValues: options.protectedValues,
    });
    const command =
      options.command ??
      buildOpenCodeCommand({
        cliPath: options.cliPath ?? options.parentEnv["OPENCODE_CLI"] ?? "opencode",
        model: options.model,
        agent: AGENT_NAME,
        prompt: buildReviewerPrompt(options.prepared.context.skill, options.prepared.changedPaths),
      });

    const exit = await runOpenCodeSession({
      command,
      cwd: staging.workspaceDir,
      env: childEnvironment.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stdoutLogPath: staging.stdoutLogPath,
      stderrLogPath: staging.stderrLogPath,
      killGraceMs: options.killGraceMs,
    });

    if (exit.kind === "timeout") {
      throw new ReviewRunError("timeout", `OpenCode timed out after ${options.timeoutMs} ms`, ["timeout"]);
    }
    if (exit.kind === "cancelled") {
      throw new ReviewRunError("cancelled", "OpenCode invocation was cancelled", ["cancelled"]);
    }
    if (exit.kind === "spawn-error") {
      throw new ReviewRunError("spawn", `OpenCode could not start: ${exit.message ?? "unknown error"}`, ["opencode"]);
    }
    if (exit.code !== 0) {
      throw new ReviewRunError(
        "producer",
        `OpenCode exited with code ${exit.code}; stderr: ${excerpt(exit.stderrTail)}`,
        ["exit"],
      );
    }

    const canaryPresent = await fileExists(staging.canaryMarkerPath);
    if (!canaryPresent) {
      throw new ReviewRunError("config", "managed OpenCode config was not loaded (canary marker missing)", ["canary"]);
    }

    const read = await readFindings({
      ndjsonPath: staging.ndjsonPath,
      skill: options.prepared.context.skill,
      maxFindings: options.maxFindings,
    });
    return {
      ...read,
      canaryPresent,
      stagingDir: staging.root,
      exit,
      skillCriteria: { name: stagedSkill.name, criteria: stagedSkill.criteria },
    };
  } finally {
    if (!keepArtifacts) {
      await rm(staging.root, { recursive: true, force: true });
    }
  }
}
