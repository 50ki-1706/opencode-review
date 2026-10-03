// Phase 4 calibration probe (manual, NOT part of the unit suite: the file name
// does not match the Node test-runner patterns).
//
// Run with the pinned toolchain (anonymous free model works today; an optional
// JEV_API_KEY switches to the authenticated request):
//   vp env exec node test/live/jev-calibration.mjs
//
// It sends 6 hand-authored findings derived from the Phase 2/3 fixture repos
// (the counter.ts / decrement pattern) through the production request builder
// and the production Jev client to the real Zen gateway:
//   2 correct high-confidence claims, 2 false claims, 2 bad ranges.
// Results are printed as one JSON line per case; nothing is written to the repo.
//
// Privacy: the inputs are synthetic fixture code. Zen documents that "Jev
// APIs: Prompts and other inputs are not used for training" (2026-10-03).
import { jevQuestions } from "../../src/finding.ts";
import { createJevClient, JEV_ENDPOINT } from "../../src/jev.ts";

const MODEL = process.env["CALIBRATION_MODEL"] ?? "jev-1.13-free";
const TOKEN = process.env["JEV_API_KEY"] ?? "";
const DELAY_MS = Number.parseInt(process.env["CALIBRATION_DELAY_MS"] ?? "1500", 10);

const COMMIT_ID = "0123456789abcdef0123456789abcdef01234567";
const HEAD_LINES = [
  "export function increment(n: number) {",
  "  return n - 1;",
  "}",
  "",
  "export function decrement(n: number) {",
  "  return n + 1;",
  "}",
];

const DIFF_HUNK = [
  "@@ -1,7 +1,7 @@",
  " export function increment(n: number) {",
  "-  return n + 1;",
  "+  return n - 1;",
  " }",
  " ",
  " export function decrement(n: number) {",
  "-  return n - 1;",
  "+  return n + 1;",
  " }",
].join("\n");

const skillCriteria = {
  name: "fixture-skill",
  criteria:
    "Report only concrete, demonstrated harm. Ignore style preferences unless they cause a defect. " +
    "The finding must identify a real trigger and impact in the presented HEAD code.",
};

function finding(id, title, body, start, end) {
  return {
    id,
    skill: skillCriteria.name,
    path: "counter.ts",
    candidateRange: { start, end, anchor: HEAD_LINES.slice(start - 1, end).join("\n") },
    severity: "high",
    title,
    body,
  };
}

function resolved(start, end) {
  return {
    path: "counter.ts",
    commitId: COMMIT_ID,
    startLine: start,
    endLine: end,
    anchorStartLine: start,
    side: "RIGHT",
    code: HEAD_LINES.slice(start - 1, end).join("\n"),
  };
}

function evidence(start, end, diffHunks = [DIFF_HUNK]) {
  return {
    contextBefore: HEAD_LINES.slice(Math.max(0, start - 2), start - 1),
    contextAfter: HEAD_LINES.slice(end, end + 2),
    diffHunks,
    evidenceTruncated: false,
  };
}

const cases = [
  {
    id: "correct-1",
    label: "correct: increment returns n - 1",
    finding: finding(
      "calibration-correct-1",
      "increment decrements instead of incrementing",
      "increment(n) returns n - 1. Callers that expect increment(0) === 1 now receive -1, so every counter built on this helper is off by two.",
      2,
      2,
    ),
    resolved: resolved(2, 2),
    evidence: evidence(2, 2),
  },
  {
    id: "correct-2",
    label: "correct: decrement returns n + 1",
    finding: finding(
      "calibration-correct-2",
      "decrement increments instead of decrementing",
      "decrement(n) returns n + 1. A caller that decrements from 0 gets 1 and loops upward, so the helper has the opposite effect of its name.",
      6,
      6,
    ),
    resolved: resolved(6, 6),
    evidence: evidence(6, 6),
  },
  {
    id: "false-1",
    label: "false: claims behavior that is not in the code",
    finding: finding(
      "calibration-false-1",
      "increment clamps the result to avoid overflow",
      "increment(n) clamps the result to Number.MAX_SAFE_INTEGER before returning, so a caller can pass a huge n safely. The clamp is what prevents the counter from wrapping.",
      1,
      3,
    ),
    resolved: resolved(1, 3),
    evidence: evidence(1, 3),
  },
  {
    id: "false-2",
    label: "false: pure style preference",
    finding: finding(
      "calibration-false-2",
      "prefer an arrow function declaration",
      "The function declaration style is inconsistent with modern code and should be rewritten as a const arrow function.",
      1,
      3,
    ),
    resolved: resolved(1, 3),
    evidence: evidence(1, 3),
  },
  {
    id: "range-wrong",
    label: "bad range: claim about increment, range points at decrement",
    finding: finding(
      "calibration-range-wrong",
      "increment decrements instead of incrementing",
      "increment(n) returns n - 1, so increment(0) returns -1 instead of 1.",
      2,
      2,
    ),
    resolved: resolved(5, 6),
    evidence: evidence(5, 6),
  },
  {
    id: "range-wide",
    label: "bad range: comment range covers both functions",
    finding: finding(
      "calibration-range-wide",
      "increment decrements instead of incrementing",
      "increment(n) returns n - 1, so increment(0) returns -1 instead of 1.",
      2,
      2,
    ),
    resolved: resolved(1, 6),
    evidence: evidence(1, 6),
  },
];

const clientOptions = { token: TOKEN, model: MODEL };
if (TOKEN.length === 0) {
  // Anonymous runs must send no Authorization header at all; a "Bearer " value
  // with an empty token would be treated as an invalid key by the gateway.
  clientOptions.fetchImpl = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return fetch(input, { ...init, headers });
  };
}
const client = createJevClient(clientOptions);

console.log(
  JSON.stringify({
    event: "calibration-start",
    endpoint: JEV_ENDPOINT,
    model: MODEL,
    auth: TOKEN.length > 0 ? "JEV_API_KEY" : "anonymous",
    cases: cases.length,
    startedAt: new Date().toISOString(),
  }),
);

const results = [];
for (const testCase of cases) {
  const started = Date.now();
  try {
    const outcome = await client.validateFinding({
      finding: testCase.finding,
      resolved: testCase.resolved,
      skillCriteria,
      evidence: testCase.evidence,
    });
    const latencyMs = Date.now() - started;
    if (outcome.kind === "evidence_overflow") {
      results.push({ case: testCase.id, label: testCase.label, kind: outcome.kind, message: outcome.message, latencyMs });
    } else {
      results.push({
        case: testCase.id,
        label: testCase.label,
        kind: outcome.kind,
        supported: outcome.validation.supported,
        commentWorthy: outcome.validation.commentWorthy,
        rangeQuality: outcome.validation.rangeQuality,
        stateLevel: outcome.stateLevel,
        model: outcome.model,
        latencyMs,
      });
    }
  } catch (error) {
    results.push({
      case: testCase.id,
      label: testCase.label,
      kind: "run_error",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    });
  }
  console.log(JSON.stringify(results.at(-1)));
  // Be polite to the shared gateway; the rate-limit contract is undocumented.
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

const validated = results.filter((result) => result.kind === "validated");
const publishable = validated.filter(
  (result) => result.supported >= 0.7 && result.commentWorthy >= 0.6 && result.rangeQuality === "correct",
);
const latencies = validated.map((result) => result.latencyMs).sort((a, b) => a - b);
console.log(
  JSON.stringify({
    event: "calibration-summary",
    finishedAt: new Date().toISOString(),
    endpoint: JEV_ENDPOINT,
    model: MODEL,
    auth: TOKEN.length > 0 ? "JEV_API_KEY" : "anonymous",
    thresholds: { supported: 0.7, commentWorthy: 0.6, rangeQuality: "correct" },
    observed: results.map((result) => ({
      case: result.case,
      kind: result.kind,
      supported: result.supported ?? null,
      commentWorthy: result.commentWorthy ?? null,
      rangeQuality: result.rangeQuality ?? null,
    })),
    publishableByThreshold: publishable.map((result) => result.case),
    latencyMs: latencies.length > 0 ? { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) } : null,
    questionKeys: Object.keys(jevQuestions),
  }),
);
