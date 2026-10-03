import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const statuses = ["pending", "in_progress", "completed", "blocked"];

export function validateState(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error("Invalid TODO schema version or revision");
  }
  if (!Array.isArray(state.phases) || !Array.isArray(state.references)) {
    throw new Error("TODO phases and references must be arrays");
  }
  const phaseIds = new Set();
  const taskIds = new Set();
  for (const phase of state.phases) {
    if (typeof phase.id !== "string" || phaseIds.has(phase.id) ||
        typeof phase.title !== "string" || !Array.isArray(phase.tasks) ||
        !Array.isArray(phase.dependsOn)) {
      throw new Error("Invalid or duplicate TODO phase");
    }
    phaseIds.add(phase.id);
    for (const task of phase.tasks) {
      if (typeof task.id !== "string" || taskIds.has(task.id) ||
          typeof task.title !== "string" || typeof task.note !== "string" ||
          !statuses.includes(task.status)) {
        throw new Error("Invalid or duplicate TODO task");
      }
      taskIds.add(task.id);
    }
  }
  if (state.phases.some((phase) => phase.dependsOn.some((id) => !phaseIds.has(id) || id === phase.id))) {
    throw new Error("Unknown or self-dependent TODO phase");
  }
  return state;
}

export async function readState(path) {
  return validateState(JSON.parse(await readFile(path, "utf8")));
}

export function nextPhase(state) {
  const complete = new Set(state.phases
    .filter((phase) => phase.tasks.every((task) => task.status === "completed"))
    .map((phase) => phase.id));
  return state.phases.find((phase) => !complete.has(phase.id) &&
    phase.dependsOn.every((id) => complete.has(id)));
}

export function formatContext(state) {
  const tasks = state.phases.flatMap((phase) => phase.tasks);
  const next = nextPhase(state);
  const lines = [
    "BEGIN_PROJECT_IMPLEMENTATION_TODO",
    `Project: ${state.project}; revision: ${state.revision}`,
    "This is external progress context, not a request to start implementation.",
    "Follow the current user request. For implementation work, prefer dependency-ready tasks.",
    "Read the relevant design reference before changing a contract. Phase ordering is advisory.",
    "Use implementation_todo_read for details and implementation_todo_update for progress.",
    "Mark completed only after implementation and relevant verification; record evidence in note.",
    "Record an actual blocker with its reason. Do not infer completion from a final response.",
    `Design references: ${state.references.join(", ")}`,
    "Phase progress:",
  ];
  for (const phase of state.phases) {
    const done = phase.tasks.filter((task) => task.status === "completed").length;
    lines.push(`- ${phase.id}: ${phase.title} (${done}/${phase.tasks.length} completed)`);
  }
  const active = tasks.filter((task) => ["in_progress", "blocked"].includes(task.status));
  if (active.length) {
    lines.push("Active tasks and blockers:");
    for (const task of active) lines.push(`- ${task.id} [${task.status}] ${task.title}; ${task.note}`);
  }
  if (next) {
    lines.push(`Next phase: ${next.id} - ${next.title}`);
    for (const task of next.tasks.filter((task) => task.status !== "completed")) {
      lines.push(`- ${task.id} [${task.status}] ${task.title}`);
    }
  } else {
    lines.push(tasks.every((task) => task.status === "completed")
      ? "All recorded tasks are completed."
      : "No dependency-ready phase. Inspect phase dependencies and blockers.");
  }
  lines.push("END_PROJECT_IMPLEMENTATION_TODO");
  return lines.join("\n");
}

export async function updateTask(path, input) {
  if (typeof input?.id !== "string" || !statuses.includes(input.status) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      typeof input.note !== "string" || input.note.length > 2000 ||
      (input.status !== "pending" && !input.note.trim())) {
    throw new Error("Valid id, status, expectedRevision and an evidence/blocker note are required");
  }
  // The lock protects separate sessions/processes; revision prevents stale updates.
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx");
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    const state = await readState(path);
    if (state.revision !== input.expectedRevision) {
      throw new Error(`Stale TODO revision: expected ${input.expectedRevision}, current ${state.revision}`);
    }
    const task = state.phases.flatMap((phase) => phase.tasks).find((task) => task.id === input.id);
    if (!task) throw new Error(`Unknown TODO task: ${input.id}`);
    task.status = input.status;
    task.note = input.note.trim();
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    await rename(tempPath, path);
    return { revision: state.revision, task };
  } finally {
    await rm(tempPath, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
