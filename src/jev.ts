// Jev Validator transport (Phase 4): TypeSafe AI System One through the
// OpenCode Zen gateway.
//
// Wire contract (docs/architecture.md "Jev ValidatorとPublish Gate",
// decisions.md D20/D24, Phase 0 fixtures):
//   - POST https://opencode.ai/zen/v1/systemone with Content-Type:
//     application/json and Authorization: Bearer <OPENCODE_API_KEY>.
//   - The body is built by finding.ts (`jevRequestBody`): a fixed `state` and
//     three program-fixed questions. Finding text never becomes an instruction.
//   - The response is read as text first and only then JSON.parse'd, because
//     the live gateway returned 401 as `text/plain` with a JSON body.
//   - `redirect: "manual"`; any 3xx is a run error instead of a silent follow.
//
// Retry policy (separate budget from the one-shot range re-resolution):
//   - attempts <= JEV_MAX_ATTEMPTS per finding (first try + two retries);
//   - 429/529/5xx may be retried after Retry-After seconds (capped at
//     JEV_RETRY_MAX_WAIT_MS) or exponential backoff (JEV_RETRY_BASE_MS base);
//   - per-attempt timeout JEV_ATTEMPT_TIMEOUT_MS via AbortSignal.timeout;
//   - 401/403, 3xx, non-retryable 4xx, response-schema mismatch, non-JSON,
//     missing answers, out-of-range noul values and unknown choice values are
//     immediate run errors. A malformed response is never coerced into a pass.
//
// The token never appears in messages; only status codes and parsed error
// `type` strings (bounded) are formatted.
import * as v from "valibot";
import {
  buildJevState,
  fitJevState,
  jevRequestBody,
  jevResponseSchema,
  JEV_STATE_LIMIT_CODE_UNITS,
  jevStateSize,
  validationResultFromJev,
  type Finding,
  type JevEvidence,
  type JevRequestModel,
  type JevResponse,
  type JevSkillCriteria,
  type JevStateLevel,
  type ResolvedRange,
  type ValidationResult,
} from "./finding.ts";

/** Compiled endpoint. It is not configurable by inputs or environment. */
export const JEV_ENDPOINT = "https://opencode.ai/zen/v1/systemone";

/** Total attempts per finding: first try plus two retries. */
export const JEV_MAX_ATTEMPTS = 3;
/**
 * Per-attempt HTTP timeout. The run-level timeout (inputs.timeout-seconds)
 * bounds the whole pipeline; a single Jev call is fixed so a hung gateway
 * cannot consume it all with one attempt.
 */
export const JEV_ATTEMPT_TIMEOUT_MS = 60_000;
/** Exponential backoff base used when the gateway sends no Retry-After. */
export const JEV_RETRY_BASE_MS = 1_000;
/** Wait cap; a longer Retry-After fails the run instead of sleeping it. */
export const JEV_RETRY_MAX_WAIT_MS = 30_000;

export type JevFailureKind =
  | "network"
  | "timeout"
  | "redirect"
  | "auth"
  | "rate_limit"
  | "provider"
  | "request_invalid"
  | "response_invalid"
  | "status";

/**
 * Run error: the validation could not be completed. Per the failure table in
 * docs/architecture.md, Jev unavailability or an invalid response stops the run
 * and nothing is published (D16).
 */
export class JevRunError extends Error {
  readonly kind: JevFailureKind;
  readonly fields: string[];

  constructor(kind: JevFailureKind, message: string, fields: string[] = ["jev"]) {
    super(message);
    this.name = "JevRunError";
    this.kind = kind;
    this.fields = fields;
  }
}

export type JevValidateInput = {
  finding: Finding;
  resolved: ResolvedRange;
  skillCriteria: JevSkillCriteria;
  evidence: JevEvidence;
  signal?: AbortSignal;
};

export type JevValidationOutcome =
  | {
      kind: "validated";
      validation: ValidationResult;
      /** Evidence ladder level actually sent (L0-L4). */
      stateLevel: JevStateLevel;
      /** Echoed response model; recorded, never gated. */
      model: string;
    }
  | { kind: "evidence_overflow"; message: string };

export type JevClient = {
  readonly model: JevRequestModel;
  validateFinding(input: JevValidateInput): Promise<JevValidationOutcome>;
};

export type JevClientOptions = {
  token: string;
  model: JevRequestModel;
  /**
   * @internal Test seam only. Production code must not pass `fetchImpl`; the
   * Action always uses the global fetch against JEV_ENDPOINT.
   */
  fetchImpl?: typeof fetch;
  /** @internal Test seam only (deterministic retry-wait assertions). */
  sleepImpl?: (ms: number) => Promise<void>;
};

function excerpt(text: string, limit = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "unknown error";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// Tolerant envelope reader for gateway errors. Zen returned the 401 body as
// JSON with Content-Type text/plain; a 422 may be either the gateway
// `server_error` envelope or the TypeSafe `invalid_request_error` shape.
const jevErrorBodySchema = v.object({
  error: v.object({
    type: v.string(),
    message: v.optional(v.string()),
    param: v.optional(v.string()),
  }),
});

function parseErrorBody(text: string): { type: string; param: string | null } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = v.safeParse(jevErrorBodySchema, json);
  if (!parsed.success) {
    return null;
  }
  return { type: parsed.output.error.type, param: parsed.output.error.param ?? null };
}

/**
 * Classify a 422 body: the observed Zen gateway envelope is
 * `error.type = "server_error"` (a provider failure, retryable at the run
 * level by the operator, not by us); a TypeSafe validation shape
 * (`invalid_request_error` or a `param` field) means our builder sent a bad
 * request, which is a run error so the bug is not silently skipped.
 */
function classify422(text: string): { kind: "provider" | "request_invalid"; detail: string } {
  const parsed = parseErrorBody(text);
  if (parsed === null) {
    return { kind: "provider", detail: "unclassified 422 body" };
  }
  if (parsed.type === "invalid_request_error" || parsed.param !== null) {
    return { kind: "request_invalid", detail: `invalid_request_error${parsed.param === null ? "" : ` (${excerpt(parsed.param)})`}` };
  }
  return { kind: "provider", detail: excerpt(parsed.type) };
}

/** Retry-After seconds; HTTP-date values are ignored (treated as absent). */
function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  return seconds * 1000;
}

/** Exponential backoff after `attempt` completed attempts (1s, 2s, ...). */
function backoffMs(attempt: number): number {
  return Math.min(JEV_RETRY_BASE_MS * 2 ** (attempt - 1), JEV_RETRY_MAX_WAIT_MS);
}

function parseResponse(text: string): JevResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevRunError("response_invalid", "Jev response is not valid JSON", ["jev", "body"]);
  }
  const parsed = v.safeParse(jevResponseSchema, json);
  if (!parsed.success) {
    const paths = [
      ...new Set(
        parsed.issues.map((issue) => {
          const path = issue.path?.map((item) => String(item.key)).join(".");
          return path && path.length > 0 ? path : "body";
        }),
      ),
    ].slice(0, 5);
    throw new JevRunError(
      "response_invalid",
      `Jev response does not match the expected schema (${paths.join(", ")})`,
      paths,
    );
  }
  return parsed.output;
}

type AttemptResult = { kind: "response"; text: string } | { kind: "retry"; waitMs: number };

type SendOptions = {
  token: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

function retryOrThrow(
  attempt: number,
  kind: JevFailureKind,
  detail: string,
  fields: string[],
): AttemptResult {
  if (attempt >= JEV_MAX_ATTEMPTS) {
    throw new JevRunError(kind, `Jev ${detail} after ${JEV_MAX_ATTEMPTS} attempts`, fields);
  }
  return { kind: "retry", waitMs: backoffMs(attempt) };
}

async function attemptRequest(
  request: unknown,
  send: SendOptions,
  attempt: number,
): Promise<AttemptResult> {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(JEV_ATTEMPT_TIMEOUT_MS);
    const signal = send.signal ? AbortSignal.any([send.signal, timeoutSignal]) : timeoutSignal;
    response = await send.fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${send.token}`,
      },
      body: JSON.stringify(request),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (send.signal?.aborted) {
      throw new JevRunError("network", "Jev request was aborted", ["jev", "aborted"]);
    }
    const kind: JevFailureKind = isTimeoutError(error) ? "timeout" : "network";
    return retryOrThrow(attempt, kind, `request failed (${errorName(error)})`, ["jev", kind]);
  }

  const status = response.status;
  if (status >= 300 && status < 400) {
    throw new JevRunError("redirect", "Jev endpoint returned a redirect; refusing to follow", ["jev", "redirect"]);
  }
  if (status >= 200 && status < 300) {
    try {
      return { kind: "response", text: await response.text() };
    } catch (error) {
      return retryOrThrow(attempt, "network", `response body could not be read (${errorName(error)})`, ["jev", "network"]);
    }
  }

  const text = await response.text().catch(() => "");
  if (status === 401 || status === 403) {
    const parsed = parseErrorBody(text);
    const type = parsed === null ? "" : ` ${excerpt(parsed.type, 64)}`;
    // Never echo the response body: it could reflect request headers.
    throw new JevRunError("auth", `Jev authentication failed (${status}${type})`, ["jev", "auth"]);
  }
  if (status === 422) {
    const classified = classify422(text);
    throw new JevRunError(
      classified.kind,
      `Jev rejected the request (422 ${classified.detail})`,
      ["jev", classified.kind === "provider" ? "provider" : "request"],
    );
  }
  if (status === 429 || status >= 500) {
    const wait = retryAfterMs(response.headers.get("retry-after"));
    const kind: JevFailureKind = status === 429 ? "rate_limit" : "provider";
    if (wait !== null && wait > JEV_RETRY_MAX_WAIT_MS) {
      throw new JevRunError(
        kind,
        `Jev asked to retry after ${Math.ceil(wait / 1000)}s, above the ${JEV_RETRY_MAX_WAIT_MS / 1000}s cap`,
        ["jev", "retry-after"],
      );
    }
    if (attempt >= JEV_MAX_ATTEMPTS) {
      throw new JevRunError(kind, `Jev API error ${status} after ${JEV_MAX_ATTEMPTS} attempts`, ["jev", kind]);
    }
    return { kind: "retry", waitMs: wait ?? backoffMs(attempt) };
  }
  throw new JevRunError("status", `Jev API error ${status}`, ["jev", "status"]);
}

async function sendRequest(request: unknown, send: SendOptions): Promise<JevResponse> {
  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptRequest(request, send, attempt);
    if (result.kind === "response") {
      return parseResponse(result.text);
    }
    await send.sleep(result.waitMs);
  }
  // attemptRequest throws on the final attempt, so this is unreachable.
  throw new JevRunError("network", "Jev retry loop ended without a response", ["jev"]);
}

/**
 * Build one Jev client. The `fetchImpl` / `sleepImpl` fields exist only so the
 * unit suite can point at test/jev/mock-server.mjs deterministically; the
 * Action never passes them (D24/D28: the token comes from OPENCODE_API_KEY only).
 */
export function createJevClient(options: JevClientOptions): JevClient {
  const send: SendOptions = {
    token: options.token,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    model: options.model,
    async validateFinding(input: JevValidateInput): Promise<JevValidationOutcome> {
      const state = buildJevState({
        finding: input.finding,
        resolved: input.resolved,
        skillCriteria: input.skillCriteria,
        evidence: input.evidence,
      });
      const fitted = fitJevState(state);
      if (fitted.kind === "evidence_overflow") {
        return {
          kind: "evidence_overflow",
          message: `Jev state exceeds ${JEV_STATE_LIMIT_CODE_UNITS} UTF-16 code units after evidence degradation (${jevStateSize(state)})`,
        };
      }
      // Rebuilding from the fitted evidence is deterministic and keeps the
      // request exactly the state the size check measured.
      const request = jevRequestBody({
        model: options.model,
        finding: input.finding,
        resolved: input.resolved,
        skillCriteria: input.skillCriteria,
        evidence: fitted.state.evidence,
      });
      const response = await sendRequest(request, { ...send, signal: input.signal });
      return {
        kind: "validated",
        validation: validationResultFromJev(response),
        stateLevel: fitted.level,
        model: response.model,
      };
    },
  };
}
