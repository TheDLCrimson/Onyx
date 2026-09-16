import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions/completions";
import type { Mode } from "../types";

/**
 * Cap each tool result at this many characters before sending it back to the
 * model — keeps a 100 KB Read from blowing out the context window.
 */
export const TOOL_RESULT_MAX_CHARS = 8000;

/**
 * Max content chars per paginated tool result (Read, Edit echo, MultiEdit
 * echo). Leaves ~300-char headroom for JSON metadata so the full serialised
 * result never exceeds TOOL_RESULT_MAX_CHARS.
 */
export const TOOL_RESULT_PAGE_SIZE = TOOL_RESULT_MAX_CHARS - 300; // 7700

/** Per-tool execution context — set by /ask (or PR C's /feature) per call. */
export interface ToolContext {
  mode: Mode;
  /**
   * The session's active feature branch, if any. Read / List use this
   * (falling back to the default branch) so the model sees the in-flight
   * feature's contents, not just main.
   */
  activeBranch?: string;
  /**
   * Discord channel ID — used by read/write tools to resolve the per-channel
   * GitHub repo binding set via `/repo set`. Falls back to env defaults when absent.
   */
  channelId?: string;
}

/**
 * A tool the model can call. Description is load-bearing — it's what the
 * model uses to choose between tools, so write it like a mini system prompt.
 */
export interface Tool {
  name: string;
  /** Model-facing prose: what the tool does, what it sees, when to prefer it. */
  description: string;
  /** JSON-schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Allowed in `plan` mode (PR A: every tool is readonly). */
  isReadOnly: boolean;
  /** Always asks the user in `pr` / `direct` modes. */
  isDestructive: boolean;
  /**
   * If true, the agent loop pauses *after* this tool dispatches successfully —
   * the loop returns a `RunAgentPaused` state instead of continuing to the
   * next model round-trip. Used by `ExitPlanMode` to wait for a button click.
   */
  pauseAfter?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Result of dispatching one tool call — never throws to the caller. */
export type DispatchResult = { ok: true; result: string } | { ok: false; error: string };

/**
 * Find + execute the named tool with the model-supplied arguments. Returns
 * `{ ok: false }` (with a stringified reason) for: unknown tool, plan-mode
 * gate, thrown executor errors, JSON-parse failures. The model sees these as
 * `is_error: true` tool messages and decides what to do.
 */
export async function dispatchTool(
  tools: readonly Tool[],
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<DispatchResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (ctx.mode === "plan" && !tool.isReadOnly) {
    return {
      ok: false,
      error: `Tool ${name} is blocked in plan mode. Approve or cancel the plan first.`,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON arguments for ${name}: ${(err as Error).message}`,
    };
  }
  try {
    const result = await tool.execute(args, ctx);
    return { ok: true, result: truncateResult(result) };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/** Format a tool's spec as the OpenAI/OpenRouter `tools` array entry. */
export function toolsForOpenAI(tools: readonly Tool[]): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as ChatCompletionFunctionTool["function"]["parameters"],
    },
  }));
}

/** Re-export of the SDK call shape so callers don't need the OpenAI import. */
export type ToolCall = ChatCompletionMessageFunctionToolCall;

function truncateResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return (
    text.slice(0, TOOL_RESULT_MAX_CHARS) +
    `\n\n…(truncated; full result was ${text.length} chars, capped at ${TOOL_RESULT_MAX_CHARS})`
  );
}
