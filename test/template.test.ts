import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import reportFindingPlugin from "../templates/report-finding.plugin.ts";

type Tool = {
  name: string;
  description: string;
  input: { additionalProperties?: boolean };
  options: { codemode?: boolean };
  execute: (input: unknown) => Promise<{ content: string }>;
};

const validFinding = {
  path: "src/counter.ts",
  candidateStart: 2,
  candidateEnd: 2,
  anchor: "  return n + 1;",
  severity: "medium",
  title: "Off-by-one in increment",
  body: "increment(0) returns 1, but callers expect 0.",
};

async function harness(
  t: TestContext,
  changedPaths: string[] = ["src/counter.ts"],
  env: { maxFindings?: string; recordLimitBytes?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "report-finding-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ndjsonPath = join(directory, "findings.ndjson");
  const changedPathsFile = join(directory, "changed.json");
  await writeFile(ndjsonPath, "");
  await writeFile(changedPathsFile, JSON.stringify(changedPaths));
  process.env.REVIEW_NDJSON_PATH = ndjsonPath;
  process.env.REVIEW_CHANGED_PATHS = changedPathsFile;
  process.env.REVIEW_MAX_FINDINGS = env.maxFindings ?? "100";
  process.env.REVIEW_RECORD_LIMIT_BYTES = env.recordLimitBytes ?? "32768";
  t.after(() => {
    delete process.env.REVIEW_NDJSON_PATH;
    delete process.env.REVIEW_CHANGED_PATHS;
    delete process.env.REVIEW_MAX_FINDINGS;
    delete process.env.REVIEW_RECORD_LIMIT_BYTES;
  });

  const tools = new Map<string, Tool>();
  const ctx = {
    tool: {
      async transform(callback: (editor: { add: (tool: Tool) => void }) => void) {
        callback({ add: (tool) => void tools.set(tool.name, tool) });
      },
    },
  };
  await reportFindingPlugin.setup(ctx);
  const tool = tools.get("report_finding");
  assert.ok(tool, "report_finding must be registered");
  return { ndjsonPath, tool };
}

const receipt = async (tool: Tool, input: unknown) => JSON.parse((await tool.execute(input)).content) as { queued: boolean; reason?: string };

test("setup registers report_finding with JSON Schema and codemode disabled", async (t) => {
  const { tool } = await harness(t);
  assert.equal(tool.name, "report_finding");
  assert.equal(tool.options.codemode, false);
  assert.equal(tool.input.additionalProperties, false);
});

test("a valid call appends one exact JSON line and returns queued", async (t) => {
  const { tool, ndjsonPath } = await harness(t);
  assert.deepEqual(await receipt(tool, validFinding), { queued: true });
  assert.equal(await readFile(ndjsonPath, "utf8"), `${JSON.stringify(validFinding)}\n`);
});

test("lightweight checks reject before anything is appended", async (t) => {
  const { tool, ndjsonPath } = await harness(t);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["start after end", { ...validFinding, candidateStart: 3, candidateEnd: 2 }],
    ["zero line", { ...validFinding, candidateStart: 0 }],
    ["unknown severity", { ...validFinding, severity: "urgent" }],
    ["blank title", { ...validFinding, title: "   " }],
    ["blank body", { ...validFinding, body: "" }],
    ["path not changed", { ...validFinding, path: "src/other.ts" }],
  ];
  for (const [name, input] of cases) {
    const result = await receipt(tool, input);
    assert.equal(result.queued, false, name);
    assert.equal(typeof result.reason, "string", name);
  }
  assert.equal(await readFile(ndjsonPath, "utf8"), "");
});

test("concurrent calls are serialized into intact lines", async (t) => {
  const { tool, ndjsonPath } = await harness(t);
  await Promise.all(
    [1, 2, 3].map((index) => tool.execute({ ...validFinding, title: `finding ${index}` })),
  );
  const lines = (await readFile(ndjsonPath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => JSON.parse(line).title), ["finding 1", "finding 2", "finding 3"]);
});

test("records larger than 32 KiB are rejected by byte length", async (t) => {
  const { tool, ndjsonPath } = await harness(t);
  const result = await receipt(tool, { ...validFinding, body: "x".repeat(33 * 1024) });
  assert.equal(result.queued, false);
  assert.match(result.reason ?? "", /32 KiB|32768/);
  assert.equal(await readFile(ndjsonPath, "utf8"), "");
});

test("the record byte limit comes from REVIEW_RECORD_LIMIT_BYTES", async (t) => {
  const { tool, ndjsonPath } = await harness(t, ["src/counter.ts"], { recordLimitBytes: "10" });
  const result = await receipt(tool, validFinding);
  assert.equal(result.queued, false);
  assert.match(result.reason ?? "", /10 bytes/);
  assert.equal(await readFile(ndjsonPath, "utf8"), "");
});

test("the max-findings limit rejects further records", async (t) => {
  const { tool, ndjsonPath } = await harness(t, ["src/counter.ts"], { maxFindings: "1" });
  assert.deepEqual(await receipt(tool, validFinding), { queued: true });
  const second = await receipt(tool, { ...validFinding, title: "second" });
  assert.equal(second.queued, false);
  assert.match(second.reason ?? "", /max-findings limit \(1\)/);
  assert.equal((await readFile(ndjsonPath, "utf8")).trimEnd().split("\n").length, 1);
});

test("append creates the findings file when the Action did not pre-create it", async (t) => {
  const { tool, ndjsonPath } = await harness(t);
  await rm(ndjsonPath, { force: true });
  assert.deepEqual(await receipt(tool, validFinding), { queued: true });
  assert.equal(await readFile(ndjsonPath, "utf8"), `${JSON.stringify(validFinding)}\n`);
});
