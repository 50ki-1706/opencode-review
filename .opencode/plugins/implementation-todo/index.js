import { fileURLToPath } from "node:url";
import { formatContext, nextPhase, readState, statuses, updateTask } from "./store.js";

const statePath = fileURLToPath(new URL("../../context/implementation-todo.json", import.meta.url));

// V2 accepts a default-exported { id, setup } definition; no SDK import is needed.
export function createImplementationTodoPlugin(path) {
  return {
    id: "opencode-review.implementation-todo",
    async setup(ctx) {
      await ctx.session.hook("context", async (event) => {
        let text;
        try {
          text = formatContext(await readState(path));
        } catch (error) {
          text = `Implementation TODO context is unavailable: ${error.message}. Do not assume tasks are completed.`;
        }
        event.system.push({ type: "text", text });
      });

      await ctx.tool.transform((editor) => {
        editor.add({
          name: "implementation_todo_read",
          description: "Read persistent project implementation TODOs, their revision and next phase. Use scope all for the complete backlog.",
          input: {
            type: "object",
            properties: { scope: { type: "string", enum: ["next", "all"] } },
            additionalProperties: false,
          },
          async execute(input) {
            const state = await readState(path);
            const next = nextPhase(state);
            const phases = input.scope === "all" ? state.phases : state.phases.filter((phase) =>
              phase.id === next?.id || phase.tasks.some((task) => ["in_progress", "blocked"].includes(task.status)));
            return { content: JSON.stringify({ revision: state.revision, references: state.references, phases }) };
          },
        });
        editor.add({
          name: "implementation_todo_update",
          description: "Update one persistent implementation task. Provide the current revision and a verification or blocker note; stale updates are rejected. This does not edit code or start work.",
          input: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: statuses },
              expectedRevision: { type: "integer", minimum: 0 },
              note: { type: "string", maxLength: 2000 },
            },
            required: ["id", "status", "expectedRevision", "note"],
            additionalProperties: false,
          },
          async execute(input) {
            try {
              return { content: JSON.stringify({ updated: true, ...await updateTask(path, input) }) };
            } catch (error) {
              return { content: JSON.stringify({ updated: false, reason: error.message }) };
            }
          },
        });
      });
    },
  };
}

export default createImplementationTodoPlugin(statePath);
