import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions";
import { chatCompletion, withHistory } from "./llm";
import { isAnthropicModel, modelRequestFields, type ModelTier } from "./models";
import type { Tool, ToolContext } from "./tools";
import { dispatchTool, toolsForOpenAI } from "./tools";
import type { AgentBudget } from "../types";

/** A line that opens a numbered or bulleted step. */
const STEP_LINE = /^\s*(?:\d+[.)]|[-*•])\s+\S/;

/**
 * Does a plan-mode reply read as a finished plan rather than a question?
 *
 * Models that reliably call `ExitPlanMode` never reach this check; it exists
 * for the ones that answer with the plan as prose. Deliberately strict: a
 * misread question becomes an approval prompt for a plan nobody wrote, which
 * is worse than the clarification pause it replaces. Requires at least two
 * enumerated steps, and treats a trailing question mark as a question even
 * when options are listed above it.
 *
 * Exported for testing.
 */
export function looksLikePlan(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.endsWith("?")) return false;
  const steps = trimmed.split("\n").filter((line) => STEP_LINE.test(line));
  return steps.length >= 2;
}

/** Legacy iteration cap — used when no `budget` is provided (e.g. tests). */
export const DEFAULT_MAX_ITERATIONS = 10;

/** Default three-axis budget for /feature and /refine loops. */
export const DEFAULT_BUDGET: AgentBudget = { reads: 50, writes: 20, tokens: 200_000 };

/** Reduced budget for auto-fix loops (build gate re-runs). */
export const BUILD_FIX_BUDGET: AgentBudget = { reads: 10, writes: 5, tokens: 30_000 };

/** Reserve granted when the model calls RequestCheckpoint before exhaustion. */
const WRAP_UP_RESERVE: AgentBudget = { reads: 5, writes: 2, tokens: 10_000 };

const AGENT_MAX_TOKENS = 4096;

/** One tool call surfaced to the caller (for status messages). */
export interface ToolCallEvent {
  name: string;
  args: string;
}

/** Args for an initial agent run. */
export interface RunAgentParams {
  system: string;
  user: string;
  tools: readonly Tool[];
  ctx: ToolContext;
  /** Prior conversation messages (no system message) prepended before the user turn. */
  initialMessages?: ChatCompletionMessageParam[];
  /** Optional history block (from sessions.formatHistory) appended to user message. */
  history?: string;
  /** Defaults to "heavy". */
  tier?: ModelTier;
  /**
   * Three-axis budget — preferred over `maxIterations`. When provided, the loop
   * stops when any axis reaches zero (unless `RequestCheckpoint` was called to arm
   * a one-time wrap-up reserve). Budget is decremented per tool dispatch and per
   * LLM completion (tokens).
   */
  budget?: AgentBudget;
  /** Fallback iteration cap when no `budget` is provided. Defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
  /** Per-tool-call hook — receives the call before dispatch. */
  onToolCall?(event: ToolCallEvent): void | Promise<void>;
  /** Called after each iteration's tool calls complete. Receives the full messages
   *  array and the remaining budget (when budget-mode is active). */
  onIteration?(messages: ChatCompletionMessageParam[], budget?: AgentBudget): void;
}

/** Args for resuming a paused loop with a new user input. */
export interface ResumeAgentParams {
  /** Resume point — the messages array from a previous RunAgentPaused. */
  messages: ChatCompletionMessageParam[];
  tools: readonly Tool[];
  ctx: ToolContext;
  next: ResumeInput;
  tier?: ModelTier;
  /** Three-axis budget for this resume cycle. See RunAgentParams for details. */
  budget?: AgentBudget;
  /** Fallback iteration cap when no `budget` is provided. Defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
  onToolCall?(event: ToolCallEvent): void | Promise<void>;
  /** Called after each iteration's tool calls complete. See RunAgentParams for details. */
  onIteration?(messages: ChatCompletionMessageParam[], budget?: AgentBudget): void;
}

/** Inputs the loop accepts when resuming from a pause. */
export type ResumeInput =
  | { kind: "user-text"; text: string }
  | { kind: "button-approve"; planText?: string }
  | { kind: "button-revise"; instructions: string }
  | { kind: "button-cancel" }
  | { kind: "button-continue" }
  | { kind: "button-retry" }
  | { kind: "button-build-fix" };

/** Outcome of an agent invocation. */
export type RunAgentOutput = RunAgentResult | RunAgentTruncated | RunAgentPaused;

/** The model produced a clean text-only answer; loop is done. */
export interface RunAgentResult {
  paused: false;
  truncated: false;
  /** Final assistant text. */
  text: string;
  /** Number of round-trips used. */
  iterations: number;
  /** True if any tool call returned `is_error` during the loop. */
  hadToolError: boolean;
  /** Full conversation messages — available so callers can stash them for retry. */
  messages: ChatCompletionMessageParam[];
}

/**
 * The iteration cap fired before the model produced a text-only answer. We
 * carry `messages` so the runner can offer the user [▶️ Continue] / [✅ Finish]
 * / [❌ Cancel] instead of forcing a /reset.
 */
export interface RunAgentTruncated {
  paused: false;
  truncated: true;
  text: string;
  /** Resume point — feed back into `resumeAgent` with `button-continue`. */
  messages: ChatCompletionMessageParam[];
  iterations: number;
  hadToolError: boolean;
}

export interface RunAgentPaused {
  paused: true;
  /** Why the loop stopped. */
  reason: "awaiting-button" | "awaiting-user-text";
  /** Resume point — feed back into `resumeAgent`. */
  messages: ChatCompletionMessageParam[];
  /** Last user-facing text from the model (for rendering). */
  text: string;
  iterations: number;
}

/**
 * Drive the model through tool calls until it returns a text-only response,
 * the iteration cap is hit, the model calls a `pauseAfter` tool, or — in
 * `plan` mode — it returns text + no tool calls (clarification request).
 * Errors from individual tool calls are returned to the model as `is_error`
 * tool messages; the loop only throws on transport / SDK failures.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentOutput> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: params.system },
    ...(params.initialMessages ?? []),
    { role: "user", content: withHistory(params.user, params.history) },
  ];
  return continueLoop(messages, params);
}

/**
 * Resume a paused agent loop. Appends a synthetic user message describing
 * `next`, then continues the same loop until completion / next pause.
 */
export async function resumeAgent(params: ResumeAgentParams): Promise<RunAgentOutput> {
  const next = params.next;
  const userMsg = synthUserMessageFor(next);
  const messages: ChatCompletionMessageParam[] = [
    ...params.messages,
    { role: "user", content: userMsg },
  ];
  return continueLoop(messages, params);
}

interface ContinueOpts {
  tools: readonly Tool[];
  ctx: ToolContext;
  tier?: ModelTier;
  budget?: AgentBudget;
  maxIterations?: number;
  onToolCall?(event: ToolCallEvent): void | Promise<void>;
  onIteration?(messages: ChatCompletionMessageParam[], budget?: AgentBudget): void;
}

/**
 * Checkpoint state machine for the wrap-up reserve (PR L).
 * - "none": no checkpoint requested yet
 * - "armed": model called RequestCheckpoint; reserve will activate on next exhaustion check
 * - "used": reserve was granted; any further exhaustion truncates immediately
 */
type CheckpointState = "none" | "armed" | "used";

/**
 * Extract the static system-prompt text from `messages[0]`, tolerating both
 * the initial string form (set by `runAgent`) and the structured-array form
 * (left behind by a previous `continueLoop` after the cache_control rewrite).
 * Exported for tests.
 */
export function extractSystemBase(msg: ChatCompletionMessageParam | undefined): string {
  if (!msg || msg.role !== "system") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text"
      ) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

/** FNV-1a 32-bit string hash — small, fast, no crypto dep. Exported for tests. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Opt-in cache diagnostics: set `DEBUG=cache` (or any DEBUG containing `cache`
 * or `*`) to print per-iteration cache metrics. Off by default to avoid
 * log spam. Exported for tests.
 */
export function shouldDebugCache(): boolean {
  const dbg = (process.env.DEBUG || "").toLowerCase();
  return dbg.includes("cache") || dbg === "*";
}

/**
 * Opt-in tool tracing: set `DEBUG=tools` to log every tool call's arguments and
 * the head of its result. The point is answering "why did the model say that?"
 * — without it, a model that misreads a correct tool result is indistinguishable
 * from a tool that returned the wrong thing. Exported for tests.
 */
export function shouldDebugTools(): boolean {
  const dbg = (process.env.DEBUG || "").toLowerCase();
  return dbg.includes("tools") || dbg === "*";
}

/** Head of a tool result, for one-line debug output. */
function previewResult(text: string, max = 300): string {
  const flat = text.replace(/s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function continueLoop(
  messages: ChatCompletionMessageParam[],
  opts: ContinueOpts,
): Promise<RunAgentOutput> {
  const tier = opts.tier ?? "heavy";
  const oaiTools = toolsForOpenAI(opts.tools);

  // Budget-mode: copy opts.budget into a mutable object; fall back to maxIterations.
  const remaining: AgentBudget | null = opts.budget ? { ...opts.budget } : null;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Static prefix that will be cached. Extracted once and rewritten into a
  // 2-block content array each iteration (static block carries cache_control;
  // dynamic budget suffix follows in a separate block so cache hits survive
  // budget decrements).
  const systemMsg = messages[0];
  const systemBase = extractSystemBase(systemMsg);

  // Hash guardrail: lock the cacheable prefix at iteration 1 and verify the
  // tool array hasn't been mutated mid-run. Tool ordering / serialisation
  // drift here would silently kill the cache.
  const initialSystemBaseHash = systemBase ? hashString(systemBase) : 0;
  const initialToolsHash = hashString(JSON.stringify(oaiTools));

  let checkpointState: CheckpointState = "none";
  let lastText = "";
  let hadToolError = false;
  let iteration = 0;

  // When budget-mode: loop is effectively infinite (budget is the stop condition).
  // When legacy-mode: bounded by maxIterations.
  const iterLimit = remaining ? Infinity : maxIterations;

  for (iteration = 1; iteration <= iterLimit; iteration++) {
    // Mid-run mutation check — catches a tool that accidentally mutates the
    // tools array, or any other state drift that would defeat caching.
    if (iteration > 1 && systemBase) {
      const driftedTools = hashString(JSON.stringify(oaiTools)) !== initialToolsHash;
      const driftedBase = hashString(systemBase) !== initialSystemBaseHash;
      if (driftedTools || driftedBase) {
        const what =
          driftedTools && driftedBase
            ? "systemBase and tools"
            : driftedTools
              ? "tools"
              : "systemBase";
        const message = `[CACHE WARNING] ${what} changed mid-run — this destroys prompt cache hits. Investigate before deploying.`;
        if (process.env.NODE_ENV === "test") throw new Error(message);
        console.warn(message);
      }
    }

    // Rewrite messages[0] as a structured content array: cache_control on the
    // static block, dynamic budget suffix in a second non-cached block.
    if (systemMsg && systemBase) {
      const budgetSuffix = remaining
        ? `\n\nRemaining budget: reads=${remaining.reads}, writes=${remaining.writes}, ` +
          `tokens=${remaining.tokens}. When reads ≤ 3, writes ≤ 1, or tokens ≤ 5 000, ` +
          `call RequestCheckpoint immediately.`
        : "";
      // cache_control is not in the OpenAI SDK type but OpenRouter passes it
      // through to Anthropic. Build the blocks as `unknown` and cast.
      const blocks: unknown[] = [
        { type: "text", text: systemBase, cache_control: { type: "ephemeral" } },
      ];
      if (budgetSuffix) blocks.push({ type: "text", text: budgetSuffix });
      messages[0] = {
        role: "system",
        content: blocks as ChatCompletionMessageParam["content"],
      } as ChatCompletionMessageParam;

      // Per-iteration cache diagnostic (opt-in via DEBUG=cache or DEBUG=*).
      if (shouldDebugCache()) {
        const approxTokens = Math.round(systemBase.length / 4);
        console.log(`[CACHE] iter ${iteration}: stable prefix ~${approxTokens} tokens`);
      }
    }

    const modelFields = modelRequestFields(tier);
    const completion: ChatCompletion = await chatCompletion(
      {
        ...modelFields,
        max_tokens: AGENT_MAX_TOKENS,
        messages,
        tools: oaiTools,
      },
      opts.ctx.channelId,
    );
    // `choices` can be absent entirely: OpenRouter answers 200 with an `error`
    // body when an upstream provider fails, which free models trigger regularly.
    const choice = completion.choices?.[0];
    if (!choice) {
      const providerError = (completion as unknown as { error?: { message?: string } }).error;
      throw new Error(
        providerError?.message
          ? `OpenRouter returned an error instead of a completion: ${providerError.message}`
          : "OpenRouter returned no choices.",
      );
    }

    // Decrement token budget immediately after the completion returns.
    // A single large completion can overshoot the remaining budget (token overspend);
    // this is a known limitation — future work can clamp max_tokens before the call.
    const rawUsage = completion.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          cache_read_input_tokens?: number;
          cached_tokens?: number;
        }
      | null
      | undefined;
    if (remaining && rawUsage) {
      remaining.tokens -= (rawUsage.prompt_tokens ?? 0) + (rawUsage.completion_tokens ?? 0);
    }

    // Cache observability: emit a loud warning when a stable system prefix
    // exists but the response shows zero cache hits after iteration 1 — the
    // cache should be warm by then. Catches silent regressions in the
    // provider's cache handling at runtime. Also feeds the DEBUG diagnostic.
    // Only meaningful for Anthropic models (the only ones honouring our
    // cache_control marker); checked against the model that actually served.
    const servedModel = completion.model || modelFields.model;
    if (systemBase && iteration > 1 && rawUsage && isAnthropicModel(servedModel)) {
      const cached =
        rawUsage.prompt_tokens_details?.cached_tokens ??
        rawUsage.cache_read_input_tokens ??
        rawUsage.cached_tokens ??
        0;
      if (cached === 0) {
        console.warn(
          `[CACHE WARNING] iter ${iteration}: cached_tokens=0 despite stable prefix — cache may be evicted or broken`,
        );
      } else if (shouldDebugCache()) {
        const prompt = rawUsage.prompt_tokens ?? 0;
        const hitPct = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
        console.log(
          `[CACHE] iter ${iteration}: cached_tokens=${cached}/${prompt} (${hitPct}% hit)`,
        );
      }
    }

    const msg = choice.message;
    lastText = msg.content?.trim() ?? "";

    const toolCalls = (msg.tool_calls ?? []).filter(isFunctionCall);
    if (toolCalls.length === 0) {
      if (opts.ctx.mode === "plan") {
        // Weaker models write the plan out as prose instead of calling
        // ExitPlanMode. Treating that as a clarification strands the user:
        // they get a reply hint and a Cancel button, with no way to approve
        // the plan the model just wrote. Dispatch the call the model meant to
        // make, so the normal approval buttons appear.
        const hasExitPlanMode = opts.tools.some((t) => t.name === "ExitPlanMode");
        if (hasExitPlanMode && looksLikePlan(lastText)) {
          messages.push({ role: "assistant", content: lastText });
          const dispatched = await dispatchTool(
            opts.tools,
            "ExitPlanMode",
            JSON.stringify({ plan_text: lastText }),
            opts.ctx,
          );
          // No tool message is appended: there is no tool_call_id to pair it
          // with, and the plan is already in the assistant turn above.
          if (dispatched.ok) {
            opts.onIteration?.(messages, remaining ?? undefined);
            return {
              paused: true,
              reason: "awaiting-button",
              messages,
              text: dispatched.result,
              iterations: iteration,
            };
          }
          // Dispatch failed (hooks unavailable): fall through and let the user
          // drive the conversation rather than dropping the turn.
          messages.pop();
        }
        // Plan mode: text + no tool calls = clarification request → pause.
        return {
          paused: true,
          reason: "awaiting-user-text",
          messages,
          text: lastText,
          iterations: iteration,
        };
      }
      // PR / direct mode: text + no tool calls = done.
      if (!lastText) throw new Error("OpenRouter returned no text content.");
      return {
        paused: false,
        truncated: false,
        text: lastText,
        iterations: iteration,
        hadToolError,
        messages,
      };
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    let pauseRequested = false;
    let pauseText = lastText;
    for (const call of toolCalls) {
      if (opts.onToolCall) {
        await opts.onToolCall({
          name: call.function.name,
          args: call.function.arguments,
        });
      }
      const dispatched = await dispatchTool(
        opts.tools,
        call.function.name,
        call.function.arguments,
        opts.ctx,
      );
      if (shouldDebugTools()) {
        console.log(
          `[tools] ${call.function.name}(${previewResult(call.function.arguments, 200)}) -> ` +
            (dispatched.ok
              ? previewResult(dispatched.result)
              : `ERROR ${previewResult(String(dispatched.error))}`),
        );
      }
      const tool = opts.tools.find((t) => t.name === call.function.name);

      // Budget decrement: registered before checking dispatch success so that
      // failed writes still consume budget (prevents retry loops from being "free").
      // RequestCheckpoint is a control-flow signal — exempt from budget decrement.
      if (remaining && call.function.name === "RequestCheckpoint") {
        // Arm the checkpoint if not already used; idempotent on "armed".
        if (checkpointState === "none" || checkpointState === "armed") {
          checkpointState = "armed";
        }
        // If already "used", re-arming is silently ignored (no double-grant).
      } else if (remaining) {
        if (tool?.isReadOnly) {
          remaining.reads--;
        } else {
          // Note: MultiEdit counts as 1 write per invocation regardless of how many
          // edits it applies — per-invocation pricing, not per-mutation.
          remaining.writes--;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: dispatched.ok ? dispatched.result : `is_error: true\nerror: ${dispatched.error}`,
      });
      if (!dispatched.ok) hadToolError = true;
      if (dispatched.ok && tool?.pauseAfter) {
        pauseRequested = true;
        // For ExitPlanMode-like tools, the tool's `result` is the user-facing
        // text we want to render; prefer it over the assistant content.
        pauseText = dispatched.result;
      }
    }

    opts.onIteration?.(messages, remaining ?? undefined);

    if (pauseRequested) {
      return {
        paused: true,
        reason: "awaiting-button",
        messages,
        text: pauseText,
        iterations: iteration,
      };
    }

    // Budget exhaustion check (budget-mode only).
    if (remaining) {
      if (checkpointState === "armed") {
        // Reserve activated: grant wrap-up budget and skip exhaustion this iteration.
        remaining.reads += WRAP_UP_RESERVE.reads;
        remaining.writes += WRAP_UP_RESERVE.writes;
        remaining.tokens += WRAP_UP_RESERVE.tokens;
        checkpointState = "used";
        // Always allow one more full iteration after granting reserve — do NOT
        // re-check exhaustion here even if axes are still <= 0.
        continue;
      }
      if (remaining.reads <= 0 || remaining.writes <= 0 || remaining.tokens <= 0) {
        const prefix = `Budget exhausted (reads=${remaining.reads}, writes=${remaining.writes}, tokens=${remaining.tokens}).`;
        const truncatedText = lastText ? `${prefix} ${lastText}` : prefix;
        return {
          paused: false,
          truncated: true,
          text: truncatedText,
          messages,
          iterations: iteration,
          hadToolError,
        };
      }
    }
  }

  // Legacy maxIterations path (only reached when remaining === null).
  const prefix = `Tool-call limit (${maxIterations}) reached.`;
  const truncatedText = lastText ? `${prefix} ${lastText}` : prefix;
  return {
    paused: false,
    truncated: true,
    text: truncatedText,
    messages,
    iterations: maxIterations,
    hadToolError,
  };
}

/** Translate a ResumeInput into the synthetic user message we feed back. */
export function synthUserMessageFor(next: ResumeInput): string {
  switch (next.kind) {
    case "user-text":
      return next.text;
    case "button-approve":
      if (next.planText) {
        return (
          "The user has approved the following plan. Execute it now step-by-step " +
          "using Write / Edit / Delete tools. Do not ask for clarification — proceed immediately.\n\n" +
          next.planText
        );
      }
      return "Approved. Proceed with the plan.";
    case "button-revise":
      return `Revise the plan: ${next.instructions}`;
    case "button-cancel":
      return "Cancelled by user. Stop and acknowledge.";
    case "button-continue":
      return (
        "The previous run stopped before finishing (budget limit, model error, or bot restart). " +
        "Continue from where you left off — finish the remaining plan items."
      );
    case "button-retry":
      return (
        "The user has reviewed the issue and it may now be resolved. " +
        "You MUST attempt every failed write operation now by actually calling " +
        "the Write / Edit / Delete tools — do not skip them or explain why they " +
        "might fail. Let the tool results tell you whether the operation succeeded. " +
        "If a tool call fails again, report the exact error. " +
        "Do not repeat work that already succeeded."
      );
    case "button-build-fix":
      // The caller (resumeFeature) injects the actual error text as a separate
      // message before calling resumeAgent — this case is a no-op sentinel.
      return "";
  }
}

/** Type guard: only function tool calls are supported. */
function isFunctionCall(
  c: ChatCompletionMessageToolCall,
): c is ChatCompletionMessageToolCall & { type: "function" } {
  return c.type === "function";
}
