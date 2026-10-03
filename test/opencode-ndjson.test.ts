import assert from "node:assert/strict";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_NDJSON_BYTES, ReviewRunError, isCoreFindingId, readFindings } from "../src/opencode.ts";

const validRecord = {
  path: "src/counter.ts",
  candidateStart: 2,
  candidateEnd: 2,
  anchor: "  return n + 1;",
  severity: "medium",
  title: "Off-by-one in increment",
  body: "increment(0) returns 1, but callers expect 0.",
};

async function ndjsonFile(t: TestContext, content: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-review-ndjson-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "findings.ndjson");
  if (typeof content === "string" || Buffer.isBuffer(content)) {
    await writeFile(path, content);
  }
  return path;
}

const read = (path: string, maxFindings = 100) => readFindings({ ndjsonPath: path, skill: "fixture-skill", maxFindings });

test("a missing findings file is a run error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-review-ndjson-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    read(join(directory, "absent.ndjson")),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_missing",
  );
});

test("an empty file is a successful zero-finding result", async (t) => {
  const path = await ndjsonFile(t, "");
  assert.deepEqual(await read(path), { findings: [], rejected: [], lineCount: 0 });
});

test("valid records become canonical findings with Core ids and skill", async (t) => {
  const second = { ...validRecord, title: "Second finding", candidateStart: 3, candidateEnd: 3 };
  const path = await ndjsonFile(t, `${JSON.stringify(validRecord)}\n${JSON.stringify(second)}\n`);
  const result = await read(path);
  assert.equal(result.findings.length, 2);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.lineCount, 2);
  for (const finding of result.findings) {
    assert.equal(finding.skill, "fixture-skill");
    assert.ok(isCoreFindingId(finding.id), finding.id);
  }
  assert.notEqual(result.findings[0]?.id, result.findings[1]?.id);
  assert.deepEqual(result.findings[0]?.candidateRange, { start: 2, end: 2, anchor: "  return n + 1;" });
  assert.equal(result.findings[1]?.title, "Second finding");
});

test("an id or skill injected by the model is rejected as an unknown field", async (t) => {
  const path = await ndjsonFile(t, `${JSON.stringify({ ...validRecord, id: "model-chosen", skill: "evil-skill" })}\n`);
  const result = await read(path);
  assert.equal(result.findings.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.line, 1);
  assert.ok((result.rejected[0]?.reason.length ?? 0) > 0);
});

test("blank-only and over-long strings are per-record rejects", async (t) => {
  const cases = [
    { ...validRecord, title: "   " },
    { ...validRecord, anchor: "\t" },
    { ...validRecord, body: " " },
    { ...validRecord, title: "x".repeat(201) },
    { ...validRecord, anchor: "x".repeat(5001) },
    { ...validRecord, body: "x".repeat(20001) },
    { ...validRecord, candidateStart: 5, candidateEnd: 4 },
    { ...validRecord, severity: "urgent" },
  ];
  const path = await ndjsonFile(t, `${cases.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const result = await read(path);
  assert.equal(result.findings.length, 0);
  assert.equal(result.rejected.length, cases.length);
  assert.deepEqual(result.rejected.map((entry) => entry.line), cases.map((_, index) => index + 1));
});

test("rejects do not stop later valid records", async (t) => {
  const path = await ndjsonFile(t, `${JSON.stringify({ ...validRecord, id: "injected" })}\n${JSON.stringify(validRecord)}\n`);
  const result = await read(path);
  assert.equal(result.findings.length, 1);
  assert.equal(result.rejected.length, 1);
});

test("an unparseable line is a corrupt-file run error", async (t) => {
  const path = await ndjsonFile(t, `{broken json}\n${JSON.stringify(validRecord)}\n`);
  await assert.rejects(
    read(path),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_corrupt" && error.message.includes("line 1"),
  );
});

test("a partial final line is a corrupt-file run error", async (t) => {
  const path = await ndjsonFile(t, JSON.stringify(validRecord));
  await assert.rejects(
    read(path),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_corrupt" && error.message.includes("partial"),
  );
});

test("interior empty lines and non-object records are corrupt-file run errors", async (t) => {
  const emptyLine = await ndjsonFile(t, `${JSON.stringify(validRecord)}\n\n${JSON.stringify(validRecord)}\n`);
  await assert.rejects(read(emptyLine), (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_corrupt");
  const arrayLine = await ndjsonFile(t, `${JSON.stringify([validRecord])}\n`);
  await assert.rejects(read(arrayLine), (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_corrupt");
  const stringLine = await ndjsonFile(t, `"just a string"\n`);
  await assert.rejects(read(stringLine), (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_corrupt");
});

test("more accepted records than max-findings is a limit run error", async (t) => {
  const path = await ndjsonFile(t, `${JSON.stringify(validRecord)}\n${JSON.stringify(validRecord)}\n`);
  await assert.rejects(
    read(path, 1),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "limit_exceeded",
  );
});

test("a findings file larger than the total cap is a size run error", async (t) => {
  const path = await ndjsonFile(t, Buffer.alloc(MAX_NDJSON_BYTES + 1, 0x20));
  await assert.rejects(
    read(path),
    (error: unknown) => error instanceof ReviewRunError && error.kind === "ndjson_too_large",
  );
});
