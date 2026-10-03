// Contract mock for the frozen Jev (System One) HTTP contract.
//
// Primary sources (fetched 2026-10-02/03):
//   https://opencode.ai/docs/zen      endpoint, model ids, Authorization header
//   https://docs.typesafe.ai/api      request/response shapes, status codes
//   https://docs.typesafe.ai/models   context and rate limits, model ids/aliases
//
// Live gateway deltas are recorded in fixtures/probe-401.json, probe-422.json and
// live-sample.json (captured 2026-10-02 on the Zen origin). The mock is stricter than
// the observed live behavior: it requires Bearer auth by default, while Zen answered
// unauthenticated requests for jev-1.13-free on the capture date.
//
// Scenario selection (one of):
//   - request header  x-mock-scenario: <name>
//   - option          startJeveMock({ scenario: "<name>" })
//   - env var         MOCK_SCENARIO=<name> or MOCK_SCENARIO=/path/to/scenarios.json
//   - extraScenarios  startJeveMock({ extraScenarios: { name: { status, headers, body } } })
//
// Built-in scenario names:
//   valid (default), threshold-at, threshold-below, threshold-above,
//   missing-answer, noul-range, choice-enum, type-mismatch, non-json,
//   unauthorized, schema-invalid, rate-limit, overloaded, server-error, timeout
//
// This file uses node built-ins only.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const TEST_TOKEN = "test-token";
export const ACCEPTED_MODELS = ["jev-1.13", "jev-1.13-free", "jev-1.13.0"];
export const RANGE_QUALITY = ["correct", "too_narrow", "too_wide", "wrong_location"];

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const FIXTURE_SCENARIOS = {
  valid: "response-valid.json",
  "threshold-at": "response-threshold-at.json",
  "threshold-below": "response-threshold-below.json",
  "threshold-above": "response-threshold-above.json",
  "missing-answer": "response-invalid-missing-answer.json",
  "noul-range": "response-invalid-noul-range.json",
  "choice-enum": "response-invalid-choice-enum.json",
  "type-mismatch": "response-invalid-type.json",
  "non-json": "response-invalid-non-json.txt",
};

const BUILTIN_SCENARIOS = new Set([
  "unauthorized",
  "schema-invalid",
  "rate-limit",
  "overloaded",
  "server-error",
  "timeout",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDescriptionLike(value) {
  return typeof value === "string" || Array.isArray(value) || isPlainObject(value);
}

// Minimal hand-rolled validation mirroring the published request schema.
// Returns null when valid, or { param, message } for the offending field.
function validateRequest(body) {
  if (!isPlainObject(body)) {
    return { message: "body must be a JSON object" };
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { param: "model", message: "model is required and must be a non-empty string" };
  }
  if (!Object.hasOwn(body, "state")) {
    return { param: "state", message: "state is required" };
  }
  const state = body.state;
  if (!(typeof state === "string" || isPlainObject(state) || Array.isArray(state))) {
    return { param: "state", message: "state must be a string, object, or array" };
  }
  if (!isPlainObject(body.questions)) {
    return { param: "questions", message: "questions is required and must be a map" };
  }
  const ids = Object.keys(body.questions);
  if (ids.length === 0) {
    return { param: "questions", message: "questions must contain at least one question" };
  }
  for (const id of ids) {
    const question = body.questions[id];
    const where = `questions.${id}`;
    if (!isPlainObject(question)) {
      return { param: where, message: "question must be an object" };
    }
    if (!["noul", "choice", "score"].includes(question.type)) {
      return { param: `${where}.type`, message: 'type must be "noul", "choice", or "score"' };
    }
    if (!isDescriptionLike(question.instructions)) {
      return { param: `${where}.instructions`, message: "instructions must be a string, object, or array" };
    }
    if (question.type === "choice") {
      if (!isPlainObject(question.criteria)) {
        return { param: `${where}.criteria`, message: "choice criteria must be a map of options" };
      }
      const options = Object.keys(question.criteria);
      if (options.length === 0) {
        return { param: `${where}.criteria`, message: "choice criteria must contain at least one option" };
      }
      if (options.length > 255) {
        return { param: `${where}.criteria`, message: "choice criteria accepts at most 255 options" };
      }
      for (const option of options) {
        const description = question.criteria[option];
        if (description !== null && !isDescriptionLike(description)) {
          return { param: `${where}.criteria.${option}`, message: "option description must be a string, object, array, or null" };
        }
      }
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        return { param: `${where}.criteria`, message: "score criteria must be an array of 2 to 10 levels" };
      }
      for (const level of question.criteria) {
        if (!isDescriptionLike(level)) {
          return { param: `${where}.criteria`, message: "score levels must be strings, objects, or arrays" };
        }
      }
    } else if (Object.hasOwn(question, "criteria") && question.criteria !== undefined) {
      if (!isPlainObject(question.criteria)) {
        return { param: `${where}.criteria`, message: "noul criteria must be an object with true/false descriptions" };
      }
    }
  }
  return null;
}

function errorBody(type, message, param) {
  const error = { type, message };
  if (param !== undefined) {
    error.param = param;
  }
  return { error };
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function loadScenarioFile(value) {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(value, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sendCustomScenario(response, scenario) {
  const headers = isPlainObject(scenario.headers) ? scenario.headers : {};
  const body = scenario.body;
  if (typeof body === "string") {
    response.writeHead(scenario.status, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    });
    response.end(body);
    return;
  }
  sendJson(response, scenario.status, body, headers);
}

/**
 * Start the Jev contract mock on 127.0.0.1.
 *
 * @param {{ port?: number, validToken?: string, allowAnonymous?: boolean,
 *           scenario?: string, extraScenarios?: Record<string, object> }} [options]
 * @returns {Promise<{ port: number, url: string, server: import("node:http").Server,
 *                     close: () => Promise<void> }>}
 */
export async function startJeveMock({
  port = 0,
  validToken = TEST_TOKEN,
  allowAnonymous = false,
  scenario,
  extraScenarios = {},
} = {}) {
  const scenarioSource = scenario ?? process.env.MOCK_SCENARIO;
  const fileScenarios = loadScenarioFile(scenarioSource);
  const customScenarios = { ...fileScenarios, ...extraScenarios };
  const knownCustom = Object.keys(customScenarios);
  const defaultScenario =
    typeof scenarioSource === "string" &&
    (scenarioSource in FIXTURE_SCENARIOS || BUILTIN_SCENARIOS.has(scenarioSource) || knownCustom.includes(scenarioSource))
      ? scenarioSource
      : typeof customScenarios.default === "string"
        ? customScenarios.default
        : "valid";

  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/v1/systemone")) {
      sendJson(response, 404, errorBody("not_found_error", "POST /v1/systemone only"));
      return;
    }

    const rawScenario = request.headers["x-mock-scenario"];
    const name = String(Array.isArray(rawScenario) ? rawScenario[0] : (rawScenario ?? defaultScenario));

    if (name === "unauthorized") {
      sendJson(response, 401, { type: "error", error: { type: "AuthError", message: "Invalid API key." } });
      return;
    }

    const authorization = request.headers.authorization;
    const hasValidAuth = typeof authorization === "string" && authorization === `Bearer ${validToken}`;
    const anonymousAllowed = allowAnonymous && authorization === undefined;
    if (!hasValidAuth && !anonymousAllowed) {
      sendJson(response, 401, { type: "error", error: { type: "AuthError", message: "Invalid API key." } });
      return;
    }

    if (name === "schema-invalid") {
      sendJson(response, 422, errorBody("invalid_request_error", "forced schema-invalid scenario", "state"));
      return;
    }
    if (name === "rate-limit") {
      sendJson(response, 429, errorBody("rate_limit_error", "Rate limit exceeded."), { "Retry-After": "1" });
      return;
    }
    if (name === "overloaded") {
      sendJson(response, 529, errorBody("overloaded_error", "Service overloaded. Retry after a short delay."));
      return;
    }
    if (name === "server-error") {
      sendJson(response, 500, errorBody("server_error", "Internal error."));
      return;
    }
    if (name === "timeout") {
      // Hold the socket open, send no headers and no body; the client must time out.
      return;
    }

    let body;
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(response, 422, errorBody("invalid_request_error", "body must be valid JSON"));
      return;
    }

    const invalid = validateRequest(body);
    if (invalid !== null) {
      sendJson(response, 422, errorBody("invalid_request_error", invalid.message, invalid.param));
      return;
    }

    if (name in customScenarios) {
      sendCustomScenario(response, customScenarios[name]);
      return;
    }

    const fixture = FIXTURE_SCENARIOS[name];
    if (fixture === undefined) {
      sendJson(response, 500, errorBody("server_error", `unknown mock scenario: ${name}`));
      return;
    }

    const raw = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
    if (fixture.endsWith(".json")) {
      const payload = JSON.parse(raw);
      payload.model = body.model;
      sendJson(response, 200, payload);
    } else {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(raw) });
      response.end(raw);
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/v1/systemone`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}
