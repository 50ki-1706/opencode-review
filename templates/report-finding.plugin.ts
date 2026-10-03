// @ts-nocheck -- This file is an OpenCode v2 plugin TEXT ASSET, not part of the
// TypeScript program. It is excluded from `tsconfig.json` and loaded by esbuild
// through the ".plugin.ts": "text" loader; only src/templates.ts imports it, and
// the Action writes the raw string into the OpenCode temp config at runtime.
//
// Contract shape: `export default { id, setup }` with no static imports
// (docs/decisions.md D06/D07, measured with @opencode/cli@2.0.22). Tool gating
// stays on the agent permissions entry for `report_finding`; do NOT set
// `options.permission` here.
//
// Environment contract (set by the Action when spawning OpenCode; the template
// only reads these names, it never chooses paths from model input):
//   REVIEW_NDJSON_PATH          File pre-created by the Action; one JSON line per record.
//   REVIEW_CHANGED_PATHS        JSON array of repo-relative changed paths for this PR.
//   REVIEW_RECORD_LIMIT_BYTES   Per-record byte limit (default 32768).
//   REVIEW_MAX_FINDINGS         Accepted-record limit for this invocation (default 100).
const SEVERITIES = ["critical", "high", "medium", "low"];
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024;
const DEFAULT_MAX_FINDINGS = 100;

function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const REPORT_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "candidateStart", "candidateEnd", "anchor", "severity", "title", "body"],
  properties: {
    path: { type: "string", minLength: 1 },
    candidateStart: { type: "integer", minimum: 1 },
    candidateEnd: { type: "integer", minimum: 1 },
    anchor: { type: "string", minLength: 1 },
    severity: { type: "string", enum: SEVERITIES },
    title: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
  },
};

function rejectionFor(input, allowedPaths) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be an object";
  }
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    return "path must be a non-empty string";
  }
  if (!allowedPaths.has(input.path)) {
    return "path is not a changed file in this invocation";
  }
  if (!Number.isInteger(input.candidateStart) || !Number.isInteger(input.candidateEnd)
      || input.candidateStart < 1 || input.candidateEnd < 1) {
    return "candidateStart and candidateEnd must be positive integers";
  }
  if (input.candidateStart > input.candidateEnd) {
    return "candidateStart must be <= candidateEnd";
  }
  if (!SEVERITIES.includes(input.severity)) {
    return "severity must be one of critical, high, medium, low";
  }
  for (const field of ["anchor", "title", "body"]) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      return `${field} must be a non-blank string`;
    }
  }
  return null;
}

export default {
  id: "report-finding",
  async setup(ctx) {
    const fs = await import("node:fs/promises");
    const ndjsonPath = process.env.REVIEW_NDJSON_PATH;
    const changedPathsPath = process.env.REVIEW_CHANGED_PATHS;
    if (!ndjsonPath || !changedPathsPath) {
      throw new Error("report-finding: REVIEW_NDJSON_PATH and REVIEW_CHANGED_PATHS are required");
    }
    const maxRecordBytes = positiveIntegerEnv("REVIEW_RECORD_LIMIT_BYTES", DEFAULT_MAX_RECORD_BYTES);
    const maxFindings = positiveIntegerEnv("REVIEW_MAX_FINDINGS", DEFAULT_MAX_FINDINGS);
    let allowedPaths;
    try {
      const parsed = JSON.parse(await fs.readFile(changedPathsPath, "utf8"));
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
        throw new Error("expected a JSON array of strings");
      }
      allowedPaths = new Set(parsed);
    } catch (error) {
      throw new Error(`report-finding: cannot load REVIEW_CHANGED_PATHS: ${error.message}`);
    }

    // One promise-chain mutex serializes appends across concurrent tool calls.
    let tail = Promise.resolve();
    let accepted = 0;
    const serialize = (operation) => {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };

    await ctx.tool.transform((editor) => editor.add({
      name: "report_finding",
      description: "Report one candidate review finding with HEAD line numbers, the exact anchor code, severity, title and body.",
      input: REPORT_FINDING_SCHEMA,
      options: { codemode: false },
      async execute(input) {
        const rejection = rejectionFor(input, allowedPaths);
        if (rejection !== null) {
          return { content: JSON.stringify({ queued: false, reason: rejection }) };
        }
        return serialize(async () => {
          if (accepted >= maxFindings) {
            return { content: JSON.stringify({ queued: false, reason: `max-findings limit (${maxFindings}) reached` }) };
          }
          const line = JSON.stringify(input);
          if (Buffer.byteLength(line, "utf8") > maxRecordBytes) {
            return { content: JSON.stringify({ queued: false, reason: `record exceeds ${maxRecordBytes} bytes` }) };
          }
          await fs.appendFile(ndjsonPath, `${line}\n`, "utf8");
          accepted += 1;
          return { content: JSON.stringify({ queued: true }) };
        });
      },
    }));
  },
};
