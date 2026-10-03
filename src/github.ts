// GitHub REST metadata reads (Phase 2) and inline comment publishing (Phase 5).
// The Publisher's payload builder and single POST live here (decisions.md D12);
// the sequential publish loop and its failure handling live in main.ts. This
// module never depends on OpenCode or the review core.
import * as v from "valibot";
import type { PublishableFinding } from "./finding.ts";

// Documented current GitHub REST API version at implementation time
// (decisions.md D26). The runner compatibility check is part of Phase 6.
const GITHUB_API_VERSION = "2026-03-10";

// The last page of /pulls/{n}/files. 50 pages x 100 files bounds a runaway
// pagination loop while staying far above realistic PR sizes.
const MAX_FILE_PAGES = 50;

const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const repoFullNameSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));

// GitHub error responses are JSON but their shape varies (404, 403, 422,
// secondary rate limits). Only the documented envelope fields are validated;
// unknown fields are ignored and no field value is echoed into messages except
// the API-supplied message text.
const errorBodySchema = v.object({
  message: v.optional(v.string()),
  documentation_url: v.optional(v.string()),
  errors: v.optional(v.array(v.unknown())),
});

export type GitHubFetchOptions = {
  token: string;
  /** Path beginning with "/", for example "/repos/o/r/pulls/1". */
  path: string;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** HTTP method; metadata reads use GET (default), publishing uses POST. */
  method?: "GET" | "POST";
  /** JSON request body for POST; never logged or echoed in errors. */
  body?: unknown;
};

export type GitHubFetchResult = {
  body: unknown;
  /** Same-origin path from the `Link: <...>; rel="next"` header, if any. */
  nextPath: string | null;
};

export class GitHubError extends Error {
  readonly status: number;
  readonly fields: string[];

  constructor(status: number, message: string, fields: string[] = []) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.fields = fields;
  }
}

export class HeadChangedError extends Error {
  readonly expectedSha: string;
  readonly actualSha: string;

  constructor(expectedSha: string, actualSha: string) {
    super(`PR head changed during context: expected ${expectedSha}, got ${actualSha}`);
    this.name = "HeadChangedError";
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
}

function issuePaths(issues: v.BaseIssue<unknown>[]): string[] {
  const paths = issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return path && path.length > 0 ? path : "body";
  });
  return [...new Set(paths)];
}

function excerpt(text: string, limit = 300): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}

export function parseNextLink(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) {
    return null;
  }
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(linkHeader);
  if (!match?.[1]) {
    return null;
  }
  const next = new URL(match[1], baseUrl);
  if (next.origin !== new URL(baseUrl).origin) {
    throw new GitHubError(0, "GitHub pagination crossed origins", ["Link"]);
  }
  return `${next.pathname}${next.search}`;
}

/**
 * Fetch one GitHub REST resource. Any 3xx is an error: redirects could hide the
 * Authorization header from the request log. Error messages never contain the
 * token because only response bodies and the status code are formatted.
 */
export async function githubFetch(options: GitHubFetchOptions): Promise<GitHubFetchResult> {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const url = new URL(options.path, baseUrl);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "opencode-review-action",
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: options.signal,
    });
  } catch (error) {
    // Network failures surface as run errors without token or URL secrets. The
    // request may or may not have reached GitHub (status 0), which the
    // publisher treats as an ambiguous outcome (D18: never blind-resend).
    throw new GitHubError(0, `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}`, ["network"]);
  }

  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new GitHubError(response.status, "GitHub API redirect is not followed", ["redirect"]);
  }

  let body: unknown = null;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new GitHubError(response.status, "GitHub API returned a non-JSON body", ["body"]);
      }
      body = null;
    }
  }

  if (!response.ok) {
    const parsed = v.safeParse(errorBodySchema, body);
    const fields = parsed.success
      ? Object.keys(parsed.output).filter((key) => parsed.output[key as keyof typeof parsed.output] !== undefined)
      : [];
    const message = parsed.success && parsed.output.message
      ? excerpt(parsed.output.message)
      : "request failed";
    throw new GitHubError(response.status, `GitHub API error ${response.status}: ${message}`, fields);
  }

  return {
    body,
    nextPath: parseNextLink(response.headers.get("link"), baseUrl),
  };
}

// --- Pull request metadata -------------------------------------------------

export const prInfoSchema = v.object({
  number: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
  state: v.string(),
  draft: v.boolean(),
  head: v.object({
    sha: shaSchema,
    ref: v.string(),
    repo: v.object({ full_name: v.string() }),
  }),
  base: v.object({ sha: shaSchema }),
});
export type PrInfo = v.InferOutput<typeof prInfoSchema>;

export const changedFileSchema = v.object({
  filename: v.string(),
  status: v.string(),
  previous_filename: v.optional(v.string()),
});
export type ChangedFile = v.InferOutput<typeof changedFileSchema>;

function reposPath(repoFullName: string, suffix: string): string {
  if (!v.safeParse(repoFullNameSchema, repoFullName).success) {
    throw new GitHubError(0, "invalid repository name", ["repository"]);
  }
  const [owner, repo] = repoFullName.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export async function getPullRequest(
  token: string,
  repoFullName: string,
  number: number,
  options: Pick<GitHubFetchOptions, "signal" | "fetchImpl" | "baseUrl"> = {},
): Promise<PrInfo> {
  const result = await githubFetch({ token, path: reposPath(repoFullName, `/pulls/${number}`), ...options });
  const parsed = v.safeParse(prInfoSchema, result.body);
  if (!parsed.success) {
    throw new GitHubError(200, "unexpected pull request response shape", issuePaths(parsed.issues));
  }
  return parsed.output;
}

export async function listChangedFiles(
  token: string,
  repoFullName: string,
  number: number,
  options: Pick<GitHubFetchOptions, "signal" | "fetchImpl" | "baseUrl"> = {},
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let path: string | null = reposPath(repoFullName, `/pulls/${number}/files?per_page=100`);
  let pages = 0;
  while (path !== null) {
    if (pages >= MAX_FILE_PAGES) {
      throw new GitHubError(0, `changed files pagination exceeded ${MAX_FILE_PAGES} pages`, ["pagination"]);
    }
    pages += 1;
    const result: GitHubFetchResult = await githubFetch({ token, path, ...options });
    const parsed = v.safeParse(v.array(changedFileSchema), result.body);
    if (!parsed.success) {
      throw new GitHubError(200, "unexpected changed files response shape", issuePaths(parsed.issues));
    }
    files.push(...parsed.output);
    path = result.nextPath;
  }
  return files;
}

/**
 * The event and the live PR must agree on the head commit; the Range Resolver
 * and the publisher reuse this check before touching a revision.
 */
export async function verifyHeadCurrent(
  token: string,
  repoFullName: string,
  number: number,
  expectedSha: string,
  options: Pick<GitHubFetchOptions, "signal" | "fetchImpl" | "baseUrl"> = {},
): Promise<PrInfo> {
  const live = await getPullRequest(token, repoFullName, number, options);
  if (live.head.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new HeadChangedError(expectedSha.toLowerCase(), live.head.sha.toLowerCase());
  }
  return live;
}

// --- Inline comment payload and publication (Phase 5) -----------------------

// The exact POST body documented in docs/architecture.md "GitHub Publisher /
// dry-run". `position` is deliberately absent. `start_line` / `start_side` are
// only present for multi-line comments.
export const inlineCommentPayloadSchema = v.strictObject({
  commit_id: shaSchema,
  path: v.pipe(v.string(), v.minLength(1)),
  start_line: v.optional(v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1))),
  start_side: v.optional(v.literal("RIGHT")),
  line: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
  side: v.literal("RIGHT"),
  body: v.pipe(v.string(), v.minLength(1)),
});
export type InlineCommentPayload = v.InferOutput<typeof inlineCommentPayloadSchema>;

/**
 * Build the only POST body the Publisher ever sends. The same function serves
 * dry-run and publication (D11), so a dry-run plan is byte-equivalent to the
 * real request. The body prefix is `[severity] title` followed by a blank line
 * and the finding body.
 */
export function buildInlinePayload(finding: PublishableFinding): InlineCommentPayload {
  const multiLine = finding.startLine !== finding.endLine;
  return {
    commit_id: finding.commitId.toLowerCase(),
    path: finding.path,
    ...(multiLine ? { start_line: finding.startLine, start_side: "RIGHT" as const } : {}),
    line: finding.endLine,
    side: "RIGHT",
    body: `[${finding.severity}] ${finding.title}\n\n${finding.body}`,
  };
}

// Minimal 201 response schema: the created comment id and its HTML URL. The
// real response has many more fields, so this is a lenient object (extra keys
// ignored) rather than a strict one.
export const postedCommentSchema = v.object({
  id: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
  url: v.pipe(v.string(), v.minLength(1)),
});
export type PostedComment = v.InferOutput<typeof postedCommentSchema>;

/**
 * POST one inline review comment. GitHub answers 201 with the created comment;
 * an unexpected 2xx body is an error so a missing id can never be recorded as a
 * successful post. Error responses are parsed text-first by githubFetch.
 */
export async function postInlineComment(
  token: string,
  repoFullName: string,
  number: number,
  payload: InlineCommentPayload,
  options: Pick<GitHubFetchOptions, "signal" | "fetchImpl" | "baseUrl"> = {},
): Promise<PostedComment> {
  const result = await githubFetch({
    token,
    path: reposPath(repoFullName, `/pulls/${number}/comments`),
    method: "POST",
    body: payload,
    ...options,
  });
  const parsed = v.safeParse(postedCommentSchema, result.body);
  if (!parsed.success) {
    throw new GitHubError(201, "unexpected inline comment response shape", issuePaths(parsed.issues));
  }
  return parsed.output;
}
