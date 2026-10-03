#!/usr/bin/env node
// Deterministic fake producer CLI for the two-skill separation check. Not part
// of the unit suite and never used by the Action bundle. It reads the selected
// skill from the prompt (last argv), derives the anchor from the staged HEAD
// workspace so it matches byte-for-byte, and appends exactly one finding whose
// title is unique to that skill. This lets the check prove that two sequential
// invocations with different skills do not share staging, findings or results.
import { appendFile, readFile, writeFile } from "node:fs/promises";

const ndjsonPath = process.env.REVIEW_NDJSON_PATH;
const canaryPath = process.env.REVIEW_CANARY_MARKER;
if (!ndjsonPath || !canaryPath) {
  console.error("two-skill fake producer: REVIEW_NDJSON_PATH / REVIEW_CANARY_MARKER missing");
  process.exit(3);
}

const prompt = process.argv[process.argv.length - 1] ?? "";
const skill = /Load the "([^"]+)" skill/.exec(prompt)?.[1] ?? "unknown";

const fileText = await readFile("src/value.ts", "utf8");
const lines = fileText.replace(/\r\n/g, "\n").split("\n");
const anchor = skill === "skill-a" ? lines[0] : lines.slice(0, 2).join("\n");
const title = skill === "skill-a" ? "Skill A finding" : "Skill B finding";
const severity = skill === "skill-a" ? "high" : "medium";
const end = skill === "skill-a" ? 1 : 2;

const record = {
  path: "src/value.ts",
  candidateStart: 1,
  candidateEnd: end,
  anchor,
  severity,
  title,
  body: `Finding emitted by the deterministic fake producer for ${skill}.`,
};

await writeFile(canaryPath, "loaded", "utf8");
await appendFile(ndjsonPath, `${JSON.stringify(record)}\n`, "utf8");
console.log(JSON.stringify({ type: "text", text: `two-skill fake producer: 1 finding for ${skill}` }));
process.exit(0);
