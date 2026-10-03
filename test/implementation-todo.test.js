import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createImplementationTodoPlugin } from "../.opencode/plugins/implementation-todo/index.js";
import { formatContext, nextPhase, readState, updateTask } from "../.opencode/plugins/implementation-todo/store.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "implementation-todo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "todo.json");
  const state = {
    schemaVersion: 1, revision: 0, project: "fixture", references: ["docs/architecture.md"],
    phases: [
      { id: "first", title: "First", dependsOn: [], tasks: [{ id: "one", title: "Task one", status: "pending", note: "" }] },
      { id: "second", title: "Second", dependsOn: ["first"], tasks: [{ id: "two", title: "Task two", status: "pending", note: "" }] },
    ],
  };
  await writeFile(path, JSON.stringify(state));
  return { path, state };
}

test("context advances only after the prerequisite phase is complete", async (t) => {
  const { path, state } = await fixture(t);
  assert.equal(nextPhase(state).id, "first");
  assert.match(formatContext(state), /one \[pending\]/);
  assert.doesNotMatch(formatContext(state), /two \[pending\]/);
  await updateTask(path, { id: "one", status: "completed", expectedRevision: 0, note: "Fixture checks passed" });
  assert.equal(nextPhase(await readState(path)).id, "second");
});

test("completion requires evidence and leaves the file unchanged when rejected", async (t) => {
  const { path } = await fixture(t);
  const before = await readFile(path, "utf8");
  await assert.rejects(updateTask(path, { id: "one", status: "completed", expectedRevision: 0, note: " " }));
  assert.equal(await readFile(path, "utf8"), before);
});

test("stale revisions cannot overwrite a completed task", async (t) => {
  const { path } = await fixture(t);
  await updateTask(path, { id: "one", status: "completed", expectedRevision: 0, note: "Verified" });
  await assert.rejects(updateTask(path, { id: "one", status: "pending", expectedRevision: 0, note: "" }), /Stale/);
  assert.equal((await readState(path)).phases[0].tasks[0].status, "completed");
});

test("concurrent updates cannot silently lose progress", async (t) => {
  const { path } = await fixture(t);
  const results = await Promise.allSettled([
    updateTask(path, { id: "one", status: "in_progress", expectedRevision: 0, note: "Started" }),
    updateTask(path, { id: "two", status: "blocked", expectedRevision: 0, note: "Missing credential" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readState(path)).revision, 1);
});

test("unknown task IDs and corrupt state are rejected", async (t) => {
  const { path } = await fixture(t);
  await assert.rejects(updateTask(path, { id: "missing", status: "pending", expectedRevision: 0, note: "" }), /Unknown/);
  await writeFile(path, "{broken");
  await assert.rejects(readState(path));
});

test("the context hook reads fresh progress and tools persist updates", async (t) => {
  const { path } = await fixture(t);
  const hooks = new Map();
  const tools = new Map();
  await createImplementationTodoPlugin(path).setup({
    session: { async hook(name, callback) { hooks.set(name, callback); } },
    tool: { async transform(callback) { callback({ add(tool) { tools.set(tool.name, tool); } }); } },
  });
  assert.deepEqual([...hooks.keys()], ["context"]);
  assert.equal(tools.size, 2);
  const first = { system: [] };
  await hooks.get("context")(first);
  assert.match(first.system[0].text, /revision: 0/);
  const receipt = JSON.parse((await tools.get("implementation_todo_update").execute({
    id: "one", status: "completed", expectedRevision: 0, note: "Implementation and checks passed",
  })).content);
  assert.equal(receipt.updated, true);
  const next = { system: [] };
  await hooks.get("context")(next);
  assert.match(next.system[0].text, /Next phase: second/);
  const backlog = JSON.parse((await tools.get("implementation_todo_read").execute({ scope: "all" })).content);
  assert.equal(backlog.revision, 1);
  assert.equal(backlog.phases.length, 2);
  await writeFile(path, "{}");
  const broken = { system: [] };
  await hooks.get("context")(broken);
  assert.match(broken.system[0].text, /unavailable/);
});

test("the project backlog is valid and all task IDs are unique", async () => {
  const path = new URL("../.opencode/context/implementation-todo.json", import.meta.url);
  const state = await readState(path);
  assert.equal(state.project, "opencode-review");
  assert.ok(state.phases.length >= 7);
});
