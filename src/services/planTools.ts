import { recordTurn } from "./sessions";
import type { TodoItem } from "./sessions";
import type { Tool } from "./tools";
import type { Session } from "../types";

/**
 * Discord-side adapter the plan tools call. Kept small so `services/` stays
 * Discord-free; the `/feature` command provides a Discord-backed implementation
 * and tests provide a mock.
 */
export interface PlanToolHooks {
  /** Render or update the live TodoWrite progress message. */
  renderTodoList(items: readonly TodoItem[]): Promise<void>;
  /**
   * Post the plan + [✅ Run] [✏️ Revise] [❌ Cancel] buttons. Returns the
   * Discord message id (caller may want to track it).
   */
  postPlanForApproval(planText: string, scopeId: string): Promise<string>;
}

/** Build the TodoWrite + ExitPlanMode + RequestCheckpoint tool registry. */
export function buildPlanTools(opts: {
  session: Session;
  hooks: PlanToolHooks;
  /** Stable id used to scope button customIds back to this feature loop. */
  scopeId: string;
}): readonly Tool[] {
  return [makeTodoWriteTool(opts), makeExitPlanModeTool(opts), makeRequestCheckpointTool()];
}

function makeTodoWriteTool(opts: { session: Session; hooks: PlanToolHooks }): Tool {
  return {
    name: "TodoWrite",
    description:
      "Maintain a live progress checklist. Pass the entire current list of " +
      "todo items each time you call (it replaces the previous snapshot). " +
      "The bot renders it as a single live-edited Discord message — call " +
      "this whenever the plan changes, when you start an item " +
      "(`in_progress`), and when you finish one (`completed`). Allowed in " +
      "every mode; readonly with respect to the repo.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Full current todo list (replaces previous snapshot).",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Imperative description of the step.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    isReadOnly: true,
    isDestructive: false,
    async execute(args) {
      const items = parseTodoItems(args.items);
      await opts.hooks.renderTodoList(items);
      // Stash the snapshot on the active feature so extractLatestTodoList can
      // find it after a pause-resume cycle. Encoded into the prompt field so
      // we don't bloat the Turn schema.
      recordTurn(opts.session, {
        kind: "tool",
        paths: [],
        prompt: `TodoWrite:${JSON.stringify(items)}`,
        summary: null,
        timestamp: Date.now(),
      });
      return `Todo list updated (${items.length} item${items.length === 1 ? "" : "s"}).`;
    },
  };
}

function makeExitPlanModeTool(opts: {
  session: Session;
  hooks: PlanToolHooks;
  scopeId: string;
}): Tool {
  return {
    name: "ExitPlanMode",
    description:
      "Signal that you are ready to leave plan mode and execute the plan. " +
      "Pass the human-readable plan text — the bot posts it to Discord with " +
      "[✅ Run] [✏️ Revise] [❌ Cancel] buttons. The agent loop pauses here " +
      "until the user clicks. Only call this when you have a concrete plan " +
      "the user can decide on; for clarification questions, just reply in " +
      "chat without calling any tool.",
    parameters: {
      type: "object",
      properties: {
        plan_text: {
          type: "string",
          description:
            "The full plan, formatted as markdown. The user will see this " +
            "verbatim in Discord, so make it skimmable: short intro + " +
            "numbered or bulleted steps + any callouts.",
        },
      },
      required: ["plan_text"],
      additionalProperties: false,
    },
    isReadOnly: true,
    isDestructive: false,
    pauseAfter: true,
    async execute(args) {
      const planText = requireString(args, "plan_text");
      // Stash the plan on the running agent so the post-execution verifier
      // can compare it to the resulting diffs. Survives the pause-resume
      // cycle on `runningAgent`; cleared with the agent on completion.
      if (opts.session.runningAgent) {
        opts.session.runningAgent.planText = planText;
      }
      await opts.hooks.postPlanForApproval(planText, opts.scopeId);
      // Loop pauses after this returns; result is appended to the message
      // log but the model only sees it when the loop resumes.
      return planText;
    },
  };
}

function makeRequestCheckpointTool(): Tool {
  return {
    name: "RequestCheckpoint",
    description:
      "Call this when reads ≤ 3, writes ≤ 1, or tokens ≤ 5 000 and you still have " +
      "staged changes to Commit. This arms a one-time reserved wrap-up budget " +
      "(2 writes + 5 reads + 10 K tokens) that activates on the next budget-exhaustion " +
      "check. Use it ONLY to call Commit and write a brief summary — do NOT start new " +
      "exploration or new file writes after calling this. Calling it again after the " +
      "reserve has already been used has no effect.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    isReadOnly: true,
    isDestructive: false,
    async execute() {
      return "Checkpoint armed. Wrap-up budget will activate on exhaustion — call Commit immediately, then summarise.";
    },
  };
}

/** Validate + narrow `args.items` into a TodoItem[]. Throws on malformed input. */
function parseTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error("`items` must be an array.");
  }
  return raw.map((entry, idx) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`items[${idx}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    const content = e.content;
    const status = e.status;
    if (typeof content !== "string") {
      throw new Error(`items[${idx}].content must be a string.`);
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error(`items[${idx}].status must be pending|in_progress|completed.`);
    }
    return { content, status };
  });
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`Argument \`${key}\` is required and must be a string.`);
  }
  return v;
}
