import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import {
  GitHubError,
  HeadChangedError,
  buildInlinePayload,
  getPullRequest,
  githubFetch,
  listChangedFiles,
  parseNextLink,
  postInlineComment,
  verifyHeadCurrent,
  type InlineCommentPayload,
} from "../src/github.ts";
import type { PublishableFinding } from "../src/finding.ts";

type RecordedRequest = { url: string; headers: IncomingMessage["headers"] };
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function mockServer(t: TestContext, handler: Handler): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

const prBody = {
  number: 7,
  state: "open",
  draft: false,
  head: { sha: "1".repeat(40), ref: "feature", repo: { full_name: "example/repo" } },
  base: { sha: "2".repeat(40) },
};

test("githubFetch sends the documented headers and returns the parsed body", async (t) => {
  const { baseUrl, requests } = await mockServer(t, (_request, response) => json(response, 200, { ok: true }));
  const result = await githubFetch({ token: "ghp_test_token", path: "/repos/example/repo/pulls/7", baseUrl });
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.nextPath, null);
  const headers = requests[0]?.headers ?? {};
  assert.equal(headers["authorization"], "Bearer ghp_test_token");
  assert.equal(headers["accept"], "application/vnd.github+json");
  assert.equal(headers["x-github-api-version"], "2026-03-10");
});

test("getPullRequest validates the PR shape and returns typed metadata", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => json(response, 200, { ...prBody, mergeable: true }));
  const pr = await getPullRequest("token", "example/repo", 7, { baseUrl });
  assert.equal(pr.number, 7);
  assert.equal(pr.head.sha, "1".repeat(40));
  assert.equal(pr.head.repo.full_name, "example/repo");
  assert.equal(pr.base.sha, "2".repeat(40));
});

test("getPullRequest rejects an unexpected response shape by field", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => json(response, 200, { number: "seven" }));
  await assert.rejects(
    getPullRequest("token", "example/repo", 7, { baseUrl }),
    (error: unknown) => error instanceof GitHubError && error.message.includes("unexpected pull request response shape") && error.fields.length > 0,
  );
});

test("listChangedFiles follows Link rel=next until the last page", async (t) => {
  const { baseUrl, requests } = await mockServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("page") === "2") {
      json(response, 200, [{ filename: "src/b.ts", status: "added" }]);
      return;
    }
    const next = `${baseUrl}/repos/example/repo/pulls/7/files?per_page=100&page=2`;
    json(response, 200, [{ filename: "src/a.ts", status: "modified" }], { link: `<${next}>; rel="next"` });
  });
  const files = await listChangedFiles("token", "example/repo", 7, { baseUrl });
  assert.deepEqual(files, [
    { filename: "src/a.ts", status: "modified" },
    { filename: "src/b.ts", status: "added" },
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.url ?? "", /per_page=100&page=2$/);
});

test("listChangedFiles keeps previous_filename for renames", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) =>
    json(response, 200, [{ filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts" }]),
  );
  const files = await listChangedFiles("token", "example/repo", 7, { baseUrl });
  assert.equal(files[0]?.previous_filename, "src/old.ts");
});

test("a 403 error exposes status and fields but never the token", async (t) => {
  const token = "ghp_super_secret_token_value";
  const { baseUrl } = await mockServer(t, (_request, response) =>
    json(response, 403, { message: "Resource not accessible", documentation_url: "https://docs.github.com" }),
  );
  await assert.rejects(
    listChangedFiles(token, "example/repo", 7, { baseUrl }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 403);
      assert.ok(error.message.includes("403"));
      assert.ok(error.message.includes("Resource not accessible"));
      assert.ok(!error.message.includes(token));
      assert.ok(error.fields.includes("message"));
      return true;
    },
  );
});

test("non-2xx responses without a JSON envelope still fail cleanly", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("upstream exploded");
  });
  await assert.rejects(
    getPullRequest("token", "example/repo", 7, { baseUrl }),
    (error: unknown) => error instanceof GitHubError && error.status === 500 && error.message.includes("request failed"),
  );
});

test("a 3xx redirect is an error and is never followed", async (t) => {
  const { baseUrl, requests } = await mockServer(t, (_request, response) => {
    response.writeHead(302, { location: "https://example.com/elsewhere" });
    response.end();
  });
  await assert.rejects(
    githubFetch({ token: "token", path: "/repos/example/repo/pulls/7", baseUrl }),
    (error: unknown) => error instanceof GitHubError && error.status === 302 && error.fields.includes("redirect"),
  );
  assert.equal(requests.length, 1);
});

test("a non-JSON success body is reported as a body error", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not json at all");
  });
  await assert.rejects(
    getPullRequest("token", "example/repo", 7, { baseUrl }),
    (error: unknown) => error instanceof GitHubError && error.fields.includes("body"),
  );
});

test("invalid repository names are rejected before the request", async () => {
  await assert.rejects(getPullRequest("token", "../evil/repo", 7), (error: unknown) => error instanceof GitHubError);
});

test("parseNextLink only follows same-origin links", () => {
  assert.equal(parseNextLink(null, "https://api.github.com"), null);
  assert.equal(
    parseNextLink('<https://api.github.com/repos/o/r/pulls/1/files?page=2>; rel="next"', "https://api.github.com"),
    "/repos/o/r/pulls/1/files?page=2",
  );
  assert.throws(
    () => parseNextLink('<https://evil.example/repos/o/r>; rel="next"', "https://api.github.com"),
    (error: unknown) => error instanceof GitHubError && error.fields.includes("Link"),
  );
});

test("verifyHeadCurrent accepts the event head and rejects a moved head", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => json(response, 200, prBody));
  const pr = await verifyHeadCurrent("token", "example/repo", 7, "1".repeat(40), { baseUrl });
  assert.equal(pr.head.sha, "1".repeat(40));
  await assert.rejects(
    verifyHeadCurrent("token", "example/repo", 7, "3".repeat(40), { baseUrl }),
    (error: unknown) => error instanceof HeadChangedError && error.actualSha === "1".repeat(40),
  );
});

// --- Phase 5 inline payload and publication --------------------------------

function publishable(overrides: Partial<PublishableFinding> = {}): PublishableFinding {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    skill: "pr-review",
    path: "src/example.ts",
    commitId: "1111111111111111111111111111111111111111",
    startLine: 12,
    endLine: 12,
    side: "RIGHT",
    severity: "high",
    title: "指摘タイトル",
    body: "発生条件、根拠、影響。",
    ...overrides,
  };
}

function payloadFixture(name: string): InlineCommentPayload {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/publish/${name}`, import.meta.url), "utf8"),
  ) as InlineCommentPayload;
}

test("buildInlinePayload matches the documented multi-line golden fixture", () => {
  const payload = buildInlinePayload(publishable({ startLine: 10, endLine: 12 }));
  assert.deepEqual(payload, payloadFixture("payload-multi.json"));
  assert.deepEqual(Object.keys(payload), ["commit_id", "path", "start_line", "start_side", "line", "side", "body"]);
  assert.ok(!("position" in payload));
});

test("buildInlinePayload omits start_line and start_side for a single-line comment", () => {
  const payload = buildInlinePayload(publishable());
  assert.deepEqual(payload, payloadFixture("payload-single.json"));
  assert.deepEqual(Object.keys(payload), ["commit_id", "path", "line", "side", "body"]);
  assert.equal(payload.line, 12);
  assert.equal(payload.side, "RIGHT");
});

test("buildInlinePayload always prefixes severity and title and lowercases the commit", () => {
  const payload = buildInlinePayload(publishable({ commitId: "A".repeat(40), severity: "low", title: "T", body: "B" }));
  assert.equal(payload.commit_id, "a".repeat(40));
  assert.equal(payload.body, "[low] T\n\nB");
});

test("postInlineComment POSTs the payload and validates the 201 body", async (t) => {
  const requests: Array<{ method?: string; body: string; authorization?: string; contentType?: string }> = [];
  const { baseUrl } = await mockServer(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      });
      json(response, 201, { id: 551, url: "https://github.com/example/repo/pull/7#discussion_r551", body: "extra" });
    });
  });
  const payload = buildInlinePayload(publishable({ startLine: 10, endLine: 12 }));
  const posted = await postInlineComment("token", "example/repo", 7, payload, { baseUrl });
  assert.equal(posted.id, 551);
  assert.equal(posted.url, "https://github.com/example/repo/pull/7#discussion_r551");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.authorization, "Bearer token");
  assert.equal(requests[0]?.contentType, "application/json");
  assert.deepEqual(JSON.parse(requests[0]!.body), payload);
});

test("postInlineComment rejects a 201 body without id or url", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) => json(response, 201, { message: "created" }));
  await assert.rejects(
    postInlineComment("token", "example/repo", 7, buildInlinePayload(publishable()), { baseUrl }),
    (error: unknown) =>
      error instanceof GitHubError &&
      error.status === 201 &&
      error.message.includes("unexpected inline comment response shape") &&
      error.fields.length > 0,
  );
});

test("postInlineComment surfaces 403 bodies with status and fields but never the token", async (t) => {
  const token = "ghp_publisher_secret_value";
  const { baseUrl } = await mockServer(t, (_request, response) =>
    json(response, 403, { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com" }),
  );
  await assert.rejects(
    postInlineComment(token, "example/repo", 7, buildInlinePayload(publishable()), { baseUrl }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 403);
      assert.ok(error.message.includes("Resource not accessible by integration"));
      assert.ok(!error.message.includes(token));
      return true;
    },
  );
});

test("postInlineComment surfaces the real 422 validation envelope", async (t) => {
  const { baseUrl } = await mockServer(t, (_request, response) =>
    json(response, 422, {
      message: "Validation Failed",
      errors: [{ resource: "PullRequestReviewComment", code: "custom", field: "line", message: "line must be part of the diff" }],
      documentation_url: "https://docs.github.com/rest/pulls/comments",
    }),
  );
  await assert.rejects(
    postInlineComment("token", "example/repo", 7, buildInlinePayload(publishable()), { baseUrl }),
    (error: unknown) =>
      error instanceof GitHubError &&
      error.status === 422 &&
      error.message.includes("Validation Failed") &&
      error.fields.includes("errors"),
  );
});

test("a destroyed socket after the request was sent is an ambiguous status-0 error", async (t) => {
  const { baseUrl, requests } = await mockServer(t, (_request, response) => {
    response.destroy();
  });
  await assert.rejects(
    postInlineComment("token", "example/repo", 7, buildInlinePayload(publishable()), { baseUrl }),
    (error: unknown) => error instanceof GitHubError && error.status === 0 && error.fields.includes("network"),
  );
  assert.equal(requests.length, 1);
});
