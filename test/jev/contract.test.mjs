// Contract tests for the frozen Jev (System One) HTTP contract and its mock.
//
// Response validation here is hand-rolled and stays independent from the
// Valibot schema in `finding.ts` (see docs/architecture.md, "Jev Validatorと
// Publish Gate").
//
// Run with: node --test test/jev/

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { startJeveMock, TEST_TOKEN, RANGE_QUALITY } from "./mock-server.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const readText = (name) => readFileSync(join(FIXTURE_DIR, name), "utf8");

const REQUIRED_ANSWERS = ["supported", "commentWorthy", "rangeQuality"];
const sorted = (values) => [...values].sort().join(",");

// Hand-rolled response validator covering the published schema:
// model + answers{supported:noul, commentWorthy:noul, rangeQuality:choice} + usage.
// `cost` is accepted because the live Zen response carries it (see live-sample.json).
function validateResponse(body) {
  const errors = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return ["response must be a JSON object"];
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    errors.push("model must be a non-empty string");
  }
  if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
    return [...errors, "answers must be an object"];
  }
  if (sorted(Object.keys(body.answers)) !== sorted(REQUIRED_ANSWERS)) {
    errors.push(`answers must contain exactly ${REQUIRED_ANSWERS.join(", ")}`);
  }

  for (const id of ["supported", "commentWorthy"]) {
    const answer = body.answers[id];
    if (answer === undefined) {
      continue;
    }
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      errors.push(`${id} must be an object`);
      continue;
    }
    if (answer.type !== "noul") {
      errors.push(`${id}.type must be "noul"`);
    }
    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      errors.push(`${id}.noul must be a finite number in 0..1`);
    }
    const extra = Object.keys(answer).filter((key) => !["type", "noul"].includes(key));
    if (extra.length > 0) {
      errors.push(`${id} has unexpected fields: ${extra.join(", ")}`);
    }
  }

  const choice = body.answers.rangeQuality;
  if (choice !== undefined) {
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
      errors.push("rangeQuality must be an object");
    } else {
      if (choice.type !== "choice") {
        errors.push('rangeQuality.type must be "choice"');
      }
      if (!RANGE_QUALITY.includes(choice.choice)) {
        errors.push(`rangeQuality.choice must be one of ${RANGE_QUALITY.join(", ")}`);
      }
      const probabilities = choice.probabilities;
      if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities)) {
        errors.push("rangeQuality.probabilities must be an object");
      } else {
        const options = Object.keys(probabilities);
        if (sorted(options) !== sorted(RANGE_QUALITY)) {
          errors.push("rangeQuality.probabilities must cover exactly the four options");
        }
        let sum = 0;
        let validValues = true;
        for (const option of options) {
          const value = probabilities[option];
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            errors.push(`rangeQuality.probabilities.${option} must be a finite number in 0..1`);
            validValues = false;
          } else {
            sum += value;
          }
        }
        if (validValues && Math.abs(sum - 1) > 1e-9) {
          errors.push(`rangeQuality.probabilities must sum to 1 (got ${sum})`);
        }
        if (validValues && RANGE_QUALITY.includes(choice.choice) && Math.abs(probabilities[choice.choice] - Math.max(...options.map((key) => probabilities[key]))) > 1e-9) {
          errors.push("rangeQuality.choice must be the highest-probability option");
        }
      }
      if (typeof choice.confidence !== "number" || !Number.isFinite(choice.confidence) || choice.confidence < 0 || choice.confidence > 1) {
        errors.push("rangeQuality.confidence must be a finite number in 0..1");
      }
    }
  }

  if (typeof body.usage !== "object" || body.usage === null || Array.isArray(body.usage)) {
    errors.push("usage must be an object");
  } else {
    for (const key of ["input_tokens", "output_tokens"]) {
      if (!Number.isInteger(body.usage[key]) || body.usage[key] < 0) {
        errors.push(`usage.${key} must be a non-negative integer`);
      }
    }
  }
  if (body.cost !== undefined && !(typeof body.cost === "string" || typeof body.cost === "number")) {
    errors.push("cost, when present, must be a string or number");
  }
  const unknown = Object.keys(body).filter((key) => !["model", "answers", "usage", "cost"].includes(key));
  if (unknown.length > 0) {
    errors.push(`unexpected top-level fields: ${unknown.join(", ")}`);
  }
  return errors;
}

// Publish gate under test (thresholds are the Phase 0 candidate values).
function gate(response) {
  const supported = response.answers.supported.noul;
  const commentWorthy = response.answers.commentWorthy.noul;
  const rangeQuality = response.answers.rangeQuality.choice;
  return supported >= 0.7 && commentWorthy >= 0.6 && rangeQuality === "correct";
}

const mock = await startJeveMock();

test.after(async () => {
  await mock.close();
});

async function post(body, { scenario, token = TEST_TOKEN, signal } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (scenario !== undefined) {
    headers["x-mock-scenario"] = scenario;
  }
  const response = await fetch(mock.url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

test("canonical request is accepted and the response conforms", async () => {
  const request = readFixture("request-expected.json");
  assert.equal(request.questions.rangeQuality.criteria.correct, null, "null choice criterion must be accepted");

  const { status, headers, json } = await post(request);
  assert.equal(status, 200);
  assert.match(headers.get("content-type"), /application\/json/);
  assert.deepEqual(validateResponse(json), []);
  assert.equal(json.model, request.model, "Zen echoes the requested model id");
  assert.deepEqual(Object.keys(json.answers).sort(), [...REQUIRED_ANSWERS].sort());
});

test("golden response fixtures conform and gate thresholds hold", () => {
  const valid = readFixture("response-valid.json");
  assert.deepEqual(validateResponse(valid), []);
  assert.equal(gate(valid), true);

  const at = readFixture("response-threshold-at.json");
  assert.deepEqual(validateResponse(at), []);
  assert.equal(gate(at), true, "supported=0.7 and commentWorthy=0.6 must pass a >= gate");

  const below = readFixture("response-threshold-below.json");
  assert.deepEqual(validateResponse(below), []);
  assert.equal(gate(below), false);

  const above = readFixture("response-threshold-above.json");
  assert.deepEqual(validateResponse(above), []);
  assert.equal(gate(above), true);
});

test("malformed response fixtures are rejected for the intended reason", () => {
  const invalidCases = [
    ["response-invalid-missing-answer.json", /rangeQuality/],
    ["response-invalid-noul-range.json", /supported\.noul/],
    ["response-invalid-choice-enum.json", /rangeQuality\.choice/],
    ["response-invalid-type.json", /supported\.type/],
  ];
  for (const [file, expected] of invalidCases) {
    const errors = validateResponse(readFixture(file));
    assert.ok(errors.length > 0, `${file} must be invalid`);
    assert.ok(errors.some((error) => expected.test(error)), `${file}: ${errors.join("; ")}`);
  }
});

test("non-JSON fixture is raw text", () => {
  assert.throws(() => JSON.parse(readText("response-invalid-non-json.txt")));
});

test("missing Authorization header is rejected with the observed 401 envelope", async () => {
  const { status, json } = await post(readFixture("request-expected.json"), { token: null });
  assert.equal(status, 401);
  assert.equal(json.type, "error");
  assert.equal(json.error.type, "AuthError");
  assert.equal(typeof json.error.message, "string");
});

test("invalid token is rejected with 401", async () => {
  const { status, json } = await post(readFixture("request-expected.json"), { token: "wrong-token" });
  assert.equal(status, 401);
  assert.equal(json.error.type, "AuthError");
});

test("allowAnonymous emulates the observed free-model behavior", async () => {
  const anonymous = await startJeveMock({ allowAnonymous: true });
  try {
    const response = await fetch(anonymous.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readFixture("request-expected.json")),
    });
    assert.equal(response.status, 200);
  } finally {
    await anonymous.close();
  }
});

test("schema-invalid requests return 422 with the offending field", async () => {
  const cases = [
    [{ model: "jev-1.13", questions: { supported: { type: "noul", instructions: "q" } } }, "state"],
    [{ model: "jev-1.13", state: "x", questions: {} }, "questions"],
    [{ model: "jev-1.13", state: "x", questions: { q: { type: "boolean", instructions: "q" } } }, "questions.q.type"],
    [{ model: "jev-1.13", state: "x", questions: { q: { type: "choice", instructions: "q" } } }, "questions.q.criteria"],
  ];
  for (const [body, param] of cases) {
    const { status, json } = await post(body);
    assert.equal(status, 422, JSON.stringify(body));
    assert.equal(json.error.type, "invalid_request_error");
    assert.equal(json.error.param, param);
  }

  const forced = await post(readFixture("request-expected.json"), { scenario: "schema-invalid" });
  assert.equal(forced.status, 422);
  assert.equal(forced.json.error.type, "invalid_request_error");
});

test("429 carries Retry-After: 1", async () => {
  const { status, headers, json } = await post(readFixture("request-expected.json"), { scenario: "rate-limit" });
  assert.equal(status, 429);
  assert.equal(headers.get("retry-after"), "1");
  assert.equal(json.error.type, "rate_limit_error");
});

test("529 and 500 scenarios surface the documented status codes", async () => {
  const overloaded = await post(readFixture("request-expected.json"), { scenario: "overloaded" });
  assert.equal(overloaded.status, 529);
  assert.equal(overloaded.json.error.type, "overloaded_error");

  const serverError = await post(readFixture("request-expected.json"), { scenario: "server-error" });
  assert.equal(serverError.status, 500);
  assert.equal(serverError.json.error.type, "server_error");
});

test("timeout scenario holds the socket until the client aborts", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(
    fetch(mock.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
        "x-mock-scenario": "timeout",
      },
      body: JSON.stringify(readFixture("request-expected.json")),
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
  );
  clearTimeout(timer);
  assert.ok(Date.now() - started < 2000, "client must abort rather than wait for a response");

  const after = await post(readFixture("request-expected.json"));
  assert.equal(after.status, 200, "server must stay usable after the held socket is destroyed");
});

test("malformed response scenarios are caught by client-side validation", async () => {
  const request = readFixture("request-expected.json");
  const cases = [
    ["missing-answer", /rangeQuality/],
    ["noul-range", /supported\.noul/],
    ["choice-enum", /rangeQuality\.choice/],
    ["type-mismatch", /supported\.type/],
  ];
  for (const [scenario, expected] of cases) {
    const { status, json } = await post(request, { scenario });
    assert.equal(status, 200, `${scenario} must return HTTP 200 with a malformed body`);
    const errors = validateResponse(json);
    assert.ok(errors.some((error) => expected.test(error)), `${scenario}: ${errors.join("; ")}`);
  }

  const nonJson = await post(request, { scenario: "non-json" });
  assert.equal(nonJson.status, 200);
  assert.match(nonJson.headers.get("content-type"), /text\/plain/);
  assert.throws(() => JSON.parse(nonJson.text));
});

test("MOCK_SCENARIO selects the default scenario", async () => {
  process.env.MOCK_SCENARIO = "rate-limit";
  const rateLimited = await startJeveMock();
  try {
    const response = await fetch(rateLimited.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(readFixture("request-expected.json")),
    });
    assert.equal(response.status, 429);
  } finally {
    await rateLimited.close();
    delete process.env.MOCK_SCENARIO;
  }
});

test("MOCK_SCENARIO may point at a scenario file", async () => {
  process.env.MOCK_SCENARIO = join(FIXTURE_DIR, "scenario-custom.json");
  const custom = await startJeveMock();
  try {
    const response = await fetch(custom.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(readFixture("request-expected.json")),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-mock-custom"), "yes");
    const json = await response.json();
    assert.deepEqual(validateResponse(json), []);
    assert.equal(json.answers.rangeQuality.choice, "too_narrow");
  } finally {
    await custom.close();
    delete process.env.MOCK_SCENARIO;
  }
});
