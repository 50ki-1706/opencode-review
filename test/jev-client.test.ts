// Phase 4 Jev transport tests against the Phase 0 contract mock. The client is
// the production `createJevClient`; only `fetchImpl` and `sleepImpl` are test
// seams, so retries are asserted deterministically without real waits.
//
// Run with: node --test test/jev-client.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JEV_ENDPOINT, JevRunError, createJevClient, type JevClient } from "../src/jev.ts";
import type { Finding, JevEvidence, JevSkillCriteria, ResolvedRange } from "../src/finding.ts";
import { startJeveMock, TEST_TOKEN } from "./jev/mock-server.mjs";

const mock = await startJeveMock();

test.after(async () => {
  await mock.close();
});

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./jev/fixtures/${name}`, import.meta.url), "utf8"));

const finding: Finding = {
  id: "finding-1",
  skill: "bug-review",
  path: "src/counter.ts",
  candidateRange: { start: 2, end: 2, anchor: "  return n + 1;" },
  severity: "medium",
  title: "Off-by-one in increment",
  body: "increment(0) returns 1, but callers expect 0.",
};

const resolved: ResolvedRange = {
  path: "src/counter.ts",
  commitId: "0123456789abcdef0123456789abcdef01234567",
  startLine: 2,
  endLine: 2,
  anchorStartLine: 2,
  side: "RIGHT",
  code: "  return n + 1;",
};

const skillCriteria: JevSkillCriteria = { name: "bug-review", criteria: "Report concrete, demonstrated harm." };

const evidence: JevEvidence = {
  contextBefore: ["export function increment(n: number) {"],
  contextAfter: ["}"],
  diffHunks: ["@@ -1,3 +1,3 @@", " export function increment(n: number) {", "-  return n;", "+  return n + 1;", " }"],
  evidenceTruncated: false,
};

type Call = { url: string; init: RequestInit };

function makeClient(options: {
  scenarioFor?: (call: number) => string | undefined;
  sleepLog?: number[];
  decorate?: (init: RequestInit) => RequestInit;
} = {}): { client: JevClient; calls: () => number; requests: Call[] } {
  let calls = 0;
  const requests: Call[] = [];
  const client = createJevClient({
    token: TEST_TOKEN,
    model: "jev-1.13-free",
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      calls += 1;
      requests.push({ url: String(input), init: init as RequestInit });
      const decorated = options.decorate ? options.decorate(init as RequestInit) : (init as RequestInit);
      const headers = new Headers(decorated.headers);
      const scenario = options.scenarioFor?.(calls);
      if (scenario !== undefined) {
        headers.set("x-mock-scenario", scenario);
      }
      return fetch(mock.url, { ...decorated, headers });
    }) as typeof fetch,
    sleepImpl: async (ms) => {
      options.sleepLog?.push(ms);
    },
  });
  return { client, calls: () => calls, requests };
}

async function run(
  client: JevClient,
): Promise<Awaited<ReturnType<JevClient["validateFinding"]>>> {
  return client.validateFinding({ finding, resolved, skillCriteria, evidence });
}

async function expectRunError(
  promise: Promise<unknown>,
  kind: JevRunError["kind"],
  pattern?: RegExp,
): Promise<JevRunError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevRunError, `expected JevRunError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    assert.ok(!error.message.includes(TEST_TOKEN), "error messages must not contain the token");
    return error;
  }
  throw new Error(`expected JevRunError (${kind})`);
}

test("sends the fixed endpoint, bearer auth, manual redirect and the exact request body", async () => {
  const { client, calls, requests } = makeClient();
  const outcome = await run(client);
  assert.equal(calls(), 1);
  assert.deepEqual(outcome, { kind: "validated", validation: { supported: 0.92, commentWorthy: 0.81, rangeQuality: "correct" }, stateLevel: 0, model: "jev-1.13-free" });

  const request = requests[0]!;
  assert.equal(request.url, JEV_ENDPOINT);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), `Bearer ${TEST_TOKEN}`);

  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["model", "state", "questions"]);
  assert.equal(body["model"], "jev-1.13-free");
  const state = body["state"] as Record<string, unknown>;
  assert.deepEqual(Object.keys(state), ["skill", "finding", "range", "evidence"]);
  const range = state["range"] as Record<string, unknown>;
  assert.deepEqual(range["code"], ["  return n + 1;"]);
  assert.equal(range["commitId"], resolved.commitId);
  const questions = body["questions"] as Record<string, unknown>;
  assert.deepEqual(Object.keys(questions), ["supported", "commentWorthy", "rangeQuality"]);
  assert.deepEqual(questions, (fixture("request-expected.json") as { questions: unknown }).questions);
});

test("gate thresholds compare inclusively at 0.7 / 0.6 for response fixtures", async () => {
  const gate = (supported: number, commentWorthy: number, quality: string): boolean =>
    supported >= 0.7 && commentWorthy >= 0.6 && quality === "correct";
  const rows: Array<[string, number, number, string, boolean]> = [
    ["valid", 0.92, 0.81, "correct", true],
    ["threshold-at", 0.7, 0.6, "correct", true],
    ["threshold-below", 0.69999, 0.59999, "correct", false],
    ["threshold-above", 0.71, 0.61, "correct", true],
  ];
  for (const [name, supported, commentWorthy, quality, expected] of rows) {
    const { client } = makeClient({ scenarioFor: () => name });
    const outcome = await run(client);
    assert.equal(outcome.kind, "validated", name);
    if (outcome.kind !== "validated") {
      continue;
    }
    assert.deepEqual(outcome.validation, { supported, commentWorthy, rangeQuality: quality });
    assert.equal(gate(outcome.validation.supported, outcome.validation.commentWorthy, outcome.validation.rangeQuality), expected, name);
  }
});

test("malformed responses are response_invalid run errors, never a pass", async () => {
  const cases: Array<[string, RegExp]> = [
    ["missing-answer", /rangeQuality/],
    ["noul-range", /supported\.noul/],
    ["choice-enum", /rangeQuality\.choice/],
    ["type-mismatch", /supported\.type/],
    ["non-json", /not valid JSON/],
  ];
  for (const [scenario, pattern] of cases) {
    const { client, calls } = makeClient({ scenarioFor: () => scenario });
    await expectRunError(run(client), "response_invalid", pattern);
    assert.equal(calls(), 1, `${scenario} must not retry`);
  }
});

test("401 posts text/plain and fails as auth without echoing the token", async () => {
  const { client, calls } = makeClient({ scenarioFor: () => "unauthorized" });
  const error = await expectRunError(run(client), "auth", /401 AuthError/);
  assert.equal(calls(), 1);
  assert.ok(!error.message.includes("Bearer"));
});

test("422 with the gateway server_error envelope is a provider run error", async () => {
  const gateway = await startJeveMock({
    extraScenarios: {
      "gateway-422": {
        status: 422,
        body: { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
      },
    },
  });
  try {
    const client = createJevClient({
      token: TEST_TOKEN,
      model: "jev-1.13-free",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set("x-mock-scenario", "gateway-422");
        return fetch(gateway.url, { ...init, headers });
      }) as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expectRunError(run(client), "provider", /422 server_error/);
  } finally {
    await gateway.close();
  }
  const mockScenario = fixture("probe-422.json") as { response: { body: { error: { type: string } } } };
  assert.equal(mockScenario.response.body.error.type, "server_error", "live probe fixture stays gateway-shaped");
});

test("422 with a validation shape is a request_invalid run error (builder bug)", async () => {
  const { client, calls } = makeClient({ scenarioFor: () => "schema-invalid" });
  await expectRunError(run(client), "request_invalid", /422 invalid_request_error \(state\)/);
  assert.equal(calls(), 1);
});

test("429 honors Retry-After seconds and then succeeds", async () => {
  const sleepLog: number[] = [];
  const { client, calls } = makeClient({
    scenarioFor: (call) => (call === 1 ? "rate-limit" : "valid"),
    sleepLog,
  });
  const outcome = await run(client);
  assert.equal(outcome.kind, "validated");
  assert.equal(calls(), 2);
  assert.deepEqual(sleepLog, [1000]);
});

test("a Retry-After above the 30s cap fails immediately without sleeping", async () => {
  const capped = await startJeveMock({
    extraScenarios: {
      "retry-later": {
        status: 429,
        headers: { "Retry-After": "31" },
        body: { error: { type: "rate_limit_error", message: "Rate limit exceeded." } },
      },
    },
  });
  try {
    const sleepLog: number[] = [];
    let calls = 0;
    const client = createJevClient({
      token: TEST_TOKEN,
      model: "jev-1.13-free",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        headers.set("x-mock-scenario", "retry-later");
        return fetch(capped.url, { ...init, headers });
      }) as typeof fetch,
      sleepImpl: async (ms) => {
        sleepLog.push(ms);
      },
    });
    await expectRunError(run(client), "rate_limit", /above the 30s cap/);
    assert.equal(calls, 1);
    assert.deepEqual(sleepLog, []);
  } finally {
    await capped.close();
  }
});

test("529 retries with exponential backoff and fails after three attempts", async () => {
  const sleepLog: number[] = [];
  const { client, calls } = makeClient({ scenarioFor: () => "overloaded", sleepLog });
  await expectRunError(run(client), "provider", /overloaded|529|3 attempts/i);
  assert.equal(calls(), 3);
  assert.deepEqual(sleepLog, [1000, 2000]);
});

test("500 then success uses one retry and the separate transport budget", async () => {
  const sleepLog: number[] = [];
  const { client, calls } = makeClient({
    scenarioFor: (call) => (call === 1 ? "server-error" : "valid"),
    sleepLog,
  });
  const outcome = await run(client);
  assert.equal(outcome.kind, "validated");
  assert.equal(calls(), 2);
  assert.deepEqual(sleepLog, [1000]);
});

test("an aborted per-attempt request is a timeout after bounded retries", async () => {
  const sleepLog: number[] = [];
  const { client, calls } = makeClient({
    scenarioFor: () => "timeout",
    sleepLog,
    decorate: (init) => ({ ...init, signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(25)]) }),
  });
  const started = Date.now();
  await expectRunError(run(client), "timeout", /failed \(TimeoutError\) after 3 attempts/);
  assert.equal(calls(), 3);
  assert.deepEqual(sleepLog, [1000, 2000]);
  assert.ok(Date.now() - started < 10_000, "timeout must not wait for the held socket");
});

test("an unexpected 4xx status is a non-retryable status run error", async () => {
  const teapot = await startJeveMock({
    extraScenarios: { teapot: { status: 418, body: { error: { type: "weird_error", message: "short and stout" } } } },
  });
  try {
    let calls = 0;
    const client = createJevClient({
      token: TEST_TOKEN,
      model: "jev-1.13-free",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        headers.set("x-mock-scenario", "teapot");
        return fetch(teapot.url, { ...init, headers });
      }) as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expectRunError(run(client), "status", /418/);
    assert.equal(calls, 1);
  } finally {
    await teapot.close();
  }
});

test("a network failure is retried with backoff and reported as network", async () => {
  const sleepLog: number[] = [];
  let calls = 0;
  const client = createJevClient({
    token: TEST_TOKEN,
    model: "jev-1.13-free",
    fetchImpl: (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    sleepImpl: async (ms) => {
      sleepLog.push(ms);
    },
  });
  await expectRunError(run(client), "network", /request failed \(TypeError\)/);
  assert.equal(calls, 3);
  assert.deepEqual(sleepLog, [1000, 2000]);
});

test("3xx responses are redirect run errors and are not followed", async () => {
  const redirecting = await startJeveMock({
    extraScenarios: {
      redirect: { status: 302, headers: { Location: "https://example.invalid/" }, body: {} },
    },
  });
  try {
    let calls = 0;
    const client = createJevClient({
      token: TEST_TOKEN,
      model: "jev-1.13-free",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        headers.set("x-mock-scenario", "redirect");
        return fetch(redirecting.url, { ...init, headers });
      }) as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await expectRunError(run(client), "redirect", /redirect/);
    assert.equal(calls, 1);
  } finally {
    await redirecting.close();
  }
});

test("an already-aborted outer signal fails without a request", async () => {
  const { client, calls } = makeClient();
  const controller = new AbortController();
  controller.abort();
  await expectRunError(
    client.validateFinding({ finding, resolved, skillCriteria, evidence, signal: controller.signal }),
    "network",
    /aborted/,
  );
  // The fetch call is attempted once with an aborted signal; no retry loop.
  assert.equal(calls(), 1);
});

test("cost is tolerated and a model echo mismatch is recorded, not gated", async () => {
  const echoing = await startJeveMock({
    extraScenarios: {
      echo: {
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: {
            supported: { type: "noul", noul: 0.9 },
            commentWorthy: { type: "noul", noul: 0.8 },
            rangeQuality: { type: "choice", choice: "correct", confidence: 0.9 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
          cost: 0,
        },
      },
    },
  });
  try {
    const client = createJevClient({
      token: TEST_TOKEN,
      model: "jev-1.13-free",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set("x-mock-scenario", "echo");
        return fetch(echoing.url, { ...init, headers });
      }) as typeof fetch,
      sleepImpl: async () => undefined,
    });
    const outcome = await run(client);
    assert.equal(outcome.kind, "validated");
    if (outcome.kind === "validated") {
      assert.equal(outcome.model, "jev-1.13.0");
      assert.deepEqual(outcome.validation, { supported: 0.9, commentWorthy: 0.8, rangeQuality: "correct" });
    }
  } finally {
    await echoing.close();
  }
});

test("state overflow skips without any request", async () => {
  let calls = 0;
  const client = createJevClient({
    token: TEST_TOKEN,
    model: "jev-1.13-free",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    sleepImpl: async () => undefined,
  });
  const hugeResolved: ResolvedRange = { ...resolved, code: "x".repeat(25_000) };
  const outcome = await client.validateFinding({ finding, resolved: hugeResolved, skillCriteria, evidence });
  assert.equal(outcome.kind, "evidence_overflow");
  assert.equal(calls, 0);
});
