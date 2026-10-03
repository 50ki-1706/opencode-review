#!/usr/bin/env node
// Live-validation fake producer CLI. Replaces only the OpenCode model process:
// the production producer path (staging, spawn, canary, NDJSON ingestion) is
// exercised for real. It writes two fixture records for the planted defects in
// the scratch PR's src/counter.ts, matching the HEAD file verbatim.
import { appendFile, writeFile } from "node:fs/promises";

const ndjsonPath = process.env.REVIEW_NDJSON_PATH;
const canaryPath = process.env.REVIEW_CANARY_MARKER;
if (!ndjsonPath || !canaryPath) {
  console.error("fake producer: REVIEW_NDJSON_PATH / REVIEW_CANARY_MARKER missing");
  process.exit(3);
}

const records = [
  {
    path: "src/counter.ts",
    candidateStart: 2,
    candidateEnd: 2,
    anchor: "  return n - 1;",
    severity: "high",
    title: "increment() decrements instead of incrementing",
    body:
      "The changed return statement subtracts one instead of adding one. " +
      "Calling increment(5) yields 4, so every caller observes a value one below the expected result.",
  },
  {
    path: "src/counter.ts",
    candidateStart: 12,
    candidateEnd: 14,
    anchor: "  if (value !== value) {\n    return min;\n  }",
    severity: "medium",
    title: "NaN is clamped to min instead of propagating",
    body:
      "The added branch detects NaN but returns min. A NaN input therefore becomes the minimum bound " +
      "instead of staying NaN, silently corrupting downstream arithmetic.",
  },
];

await writeFile(canaryPath, "loaded", "utf8");
await appendFile(ndjsonPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ type: "text", text: "fake producer: 2 findings reported" }));
process.exit(0);
