import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import { appendUsage } from "../utils/usageLog";
import { describeModelConfig, modelRequestFields, type ModelTier } from "./models";
import { loggableError } from "../utils/modelErrors";

export type { ModelTier } from "./models";

const MAX_TOKENS = 4096;
const SUMMARY_MAX_TOKENS = 400;
/**
 * Output cap for the verifier. Higher than a summary because reasoning models
 * (common among free OpenRouter models) spend tokens thinking before they emit
 * the JSON verdict, and an exhausted budget returns empty content.
 */
const VERIFY_MAX_TOKENS = 1000;

/**
 * Completion params plus OpenRouter's `models` fallback array, which the
 * OpenAI SDK types don't know about but forward verbatim.
 */
export type OpenRouterCompletionParams = ChatCompletionCreateParamsNonStreaming & {
  models?: string[];
};

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    // Optional attribution headers for the OpenRouter app rankings page.
    "HTTP-Referer": "https://github.com/TheDLCrimson/Onyx",
    "X-Title": "Onyx",
  },
});

// One-line boot banner so operators reading logs see which models are live.
// Anthropic caching may still silently fail at the provider edge; the
// integration test in src/__integration__/promptCaching.test.ts proves it works.
if (process.env.NODE_ENV !== "test") {
  console.log(describeModelConfig());
}

/**
 * OpenRouter extends `usage` with a `cost` field (USD) not present in the
 * standard OpenAI type. Cast to this shape before reading it. Cache fields
 * may appear in several shapes depending on which provider OpenRouter is
 * fronting — see {@link extractCachedTokens} / {@link extractCacheWriteTokens}.
 */
interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
}

/**
 * Defensive lookup for prompt-cache hit count. The same datum surfaces under
 * different keys depending on payload version: OpenRouter normalises to
 * `prompt_tokens_details.cached_tokens`, Anthropic native uses
 * `cache_read_input_tokens`, and some responses inline a top-level
 * `cached_tokens`. Missing on all three → undefined so the caller logs the
 * entry without cache metrics. Exported for tests.
 */
export function extractCachedTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const detail =
    typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  const candidates = [detail?.cached_tokens, u.cache_read_input_tokens, u.cached_tokens];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Defensive lookup for prompt-cache *write* count (the premium-priced tokens
 * inserted into the cache on a miss). Same drift pattern as
 * {@link extractCachedTokens}. Exported for tests.
 */
export function extractCacheWriteTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const detail =
    typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  const candidates = [
    detail?.cache_creation_tokens,
    u.cache_creation_input_tokens,
    u.cache_creation_tokens,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Single instrumentation point for every OpenRouter call. Logs token counts
 * and cost to data/usage.json after every successful completion. Passing
 * `channelId` is optional — calls without channel context (e.g. internal
 * light-tier summarisers) log with an empty string.
 */
async function coreCompletion(
  params: OpenRouterCompletionParams,
  channelId?: string,
): Promise<ChatCompletion> {
  const completion = await client.chat.completions.create(params);
  const usage = completion.usage as OpenRouterUsage | null | undefined;
  if (usage && typeof usage.prompt_tokens === "number") {
    appendUsage({
      timestamp: Date.now(),
      channelId: channelId ?? "",
      // With a fallback list, the model that actually served the call can
      // differ from the requested primary — log the one that was billed.
      model: completion.model || params.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: usage.cost ?? 0,
      cachedTokens: extractCachedTokens(usage),
      cacheWriteTokens: extractCacheWriteTokens(usage),
    });
  }
  return completion;
}

/**
 * Low-level chat-completion helper for the agent loop. Accepts an optional
 * `channelId` so per-channel cost is tracked in data/usage.json.
 */
export async function chatCompletion(
  params: OpenRouterCompletionParams,
  channelId?: string,
): Promise<ChatCompletion> {
  return coreCompletion(params, channelId);
}

/**
 * Prepend a "Recent activity" block to a user message when history is non-empty.
 * Exported for tests; default behavior unchanged when history is omitted.
 */
export function withHistory(user: string, history?: string): string {
  if (!history || !history.trim()) return user;
  return (
    `Recent activity in this conversation:\n${history.trim()}\n\n` + `Current request:\n${user}`
  );
}

/**
 * Read the assistant text out of a completion, tolerating a response with no
 * `choices` at all. OpenRouter answers 200 with an `error` body when an
 * upstream provider fails, and free models hit that often; indexing straight
 * into `choices[0]` threw "Cannot read properties of undefined" and surfaced as
 * a mysterious missing summary rather than the provider's actual complaint.
 */
function firstChoiceContent(completion: ChatCompletion): string {
  const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
  if (text) return text;
  const providerError = (completion as unknown as { error?: { message?: string } }).error;
  if (providerError?.message) {
    throw new Error(`OpenRouter returned an error instead of text: ${providerError.message}`);
  }
  throw new Error("OpenRouter returned no text content.");
}

/** Send one prompt to the tier's model via OpenRouter and return the assistant's text. */
async function ask(
  system: string,
  user: string,
  tier: ModelTier = "heavy",
  maxTokens: number = MAX_TOKENS,
  history?: string,
): Promise<string> {
  const completion = await coreCompletion({
    ...modelRequestFields(tier),
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: withHistory(user, history) },
    ],
  });

  const text = firstChoiceContent(completion);
  return text;
}

/** Stream one prompt's response as text deltas as they arrive. */
async function* askStream(
  system: string,
  user: string,
  tier: ModelTier = "heavy",
  history?: string,
): AsyncGenerator<string, void, void> {
  const params: ChatCompletionCreateParamsStreaming & { models?: string[] } = {
    ...modelRequestFields(tier),
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: withHistory(user, history) },
    ],
  };
  const stream = await client.chat.completions.create(params);

  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/** Strip a single surrounding ```lang … ``` fence if present. */
export function stripFences(raw: string): string {
  const match = raw.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : raw;
}

/**
 * Generate the contents of a new file from a natural-language description.
 * Returns raw file content with no markdown fences.
 */
export async function generateFile(
  path: string,
  description: string,
  history?: string,
): Promise<string> {
  const system =
    "You write production-quality source files. Reply with ONLY the file contents — " +
    "no prose, no explanation, no markdown fences. Your first character is the first " +
    "character of the file written to disk.";
  return stripFences(
    await ask(
      system,
      `Create a file at \`${path}\`.\n\n${description}`,
      "heavy",
      MAX_TOKENS,
      history,
    ),
  );
}

/** Apply an instruction to an existing file and return the full updated body. */
export async function editFile(
  path: string,
  current: string,
  instruction: string,
  history?: string,
): Promise<string> {
  const system =
    "You edit source files. Reply with ONLY the complete updated file contents — " +
    "no prose, no diff, no markdown fences. Preserve unrelated code exactly.";
  const user =
    `File: \`${path}\`\n\nCurrent contents:\n\`\`\`\n${current}\n\`\`\`\n\n` +
    `Instruction:\n${instruction}`;
  return stripFences(await ask(system, user, "heavy", MAX_TOKENS, history));
}

const ANSWER_SYSTEM_PROMPT =
  "You are a concise programming buddy. Answer questions about the supplied " +
  "code directly. Use markdown when helpful, but DO NOT use markdown tables — " +
  "Discord does not render them. Use bulleted or numbered lists instead.";

/**
 * Answer a free-form question about a single file's contents. Uses the
 * `light` tier (Haiku) — single-file Q&A doesn't require Sonnet-grade
 * reasoning and the cost difference is ~10× per call. Cost-reduction PR β.
 */
export async function answerQuestion(
  path: string,
  content: string,
  question: string,
  history?: string,
): Promise<string> {
  return ask(
    ANSWER_SYSTEM_PROMPT,
    `File: \`${path}\`\n\n\`\`\`\n${content}\n\`\`\`\n\nQuestion: ${question}`,
    "light",
    MAX_TOKENS,
    history,
  );
}

/** Streaming variant of answerQuestion — yields text deltas as they arrive.
 *  Same `light` tier as the non-streaming form. */
export function answerQuestionStream(
  path: string,
  content: string,
  question: string,
  history?: string,
): AsyncGenerator<string, void, void> {
  const user = `File: \`${path}\`\n\n\`\`\`\n${content}\n\`\`\`\n\nQuestion: ${question}`;
  return askStream(ANSWER_SYSTEM_PROMPT, user, "light", history);
}

const SUMMARY_SYSTEM_PROMPT =
  "You write tight pull-request descriptions. Given a file and a reason for the " +
  "change, output 3–6 markdown bullet points describing what changed and why. " +
  "No preamble, no headings, no code fences — just the bullets.";

/**
 * Produce a short bullet-list summary of a create/edit for a PR body.
 * Uses the `light` tier — never throws; on failure returns `null` so the
 * caller can fall back to a static body.
 */
export async function summarizeChange(
  kind: "create" | "edit",
  path: string,
  prompt: string,
  content: string,
): Promise<string | null> {
  const verb = kind === "create" ? "Created" : "Edited";
  const user =
    `${verb} \`${path}\`.\n\nUser prompt:\n${prompt}\n\n` +
    `Resulting file contents:\n\`\`\`\n${content}\n\`\`\``;
  try {
    return await ask(SUMMARY_SYSTEM_PROMPT, user, "light", SUMMARY_MAX_TOKENS);
  } catch (err) {
    // Logged because a missing summary is not cosmetic: the PR body shows
    // "(summary unavailable)" and the verifier reads these summaries as its
    // evidence of what changed.
    console.warn("[summary] change summary failed:", loggableError(err));
    return null;
  }
}

/** Possible outcomes of a plan-vs-execution comparison. */
export type VerifyVerdict = "match" | "partial" | "mismatch";

/** Result of {@link verifyPlan}. */
export interface VerifyResult {
  verdict: VerifyVerdict;
  notes: string;
}

/** Hard cap on the diff summary fed into the verifier prompt. */
export const VERIFY_DIFF_MAX_CHARS = 4000;

/**
 * Marker note meaning "the verifier never produced a verdict". Rendered
 * differently from a real verdict so a PR never shows an invented result.
 */
export const VERIFY_UNAVAILABLE_NOTE = "(verification unavailable)";

const VERIFY_FALLBACK: VerifyResult = {
  verdict: "partial",
  notes: VERIFY_UNAVAILABLE_NOTE,
};

const VERIFY_SYSTEM_PROMPT =
  "You are a strict reviewer that verifies whether a code change matches a " +
  "plan. Reply with strict JSON only — no preamble, no code fences, no prose.";

/**
 * Cap the diff summary to {@link VERIFY_DIFF_MAX_CHARS}. Appends a
 * `... (truncated)` marker when clipping; exported for tests.
 */
export function truncateForVerifier(raw: string, max: number = VERIFY_DIFF_MAX_CHARS): string {
  if (raw.length <= max) return raw;
  const marker = "\n... (truncated)";
  return raw.slice(0, Math.max(0, max - marker.length)) + marker;
}

/**
 * Compare a plan to a diff summary and return a verdict. Light tier; never
 * throws — on any error returns the partial fallback so the caller can still
 * post a Verification section without blocking the PR.
 */
export async function verifyPlan(input: {
  planText: string;
  diffSummary: string;
}): Promise<VerifyResult> {
  const diff = truncateForVerifier(input.diffSummary);
  const user =
    "You are verifying whether a code change matches a plan.\n\n" +
    `Plan:\n${input.planText}\n\n` +
    `Changes:\n${diff}\n\n` +
    "Evaluate:\n" +
    "- Did the changes implement what the plan described?\n" +
    "- Are any planned steps missing?\n" +
    "- Are there unexpected or unrelated changes?\n\n" +
    "Reply in strict JSON:\n" +
    `{\n  "verdict": "match" | "partial" | "mismatch",\n  "notes": "<short explanation, max 2 sentences>"\n}`;
  try {
    const raw = await ask(VERIFY_SYSTEM_PROMPT, user, "light", VERIFY_MAX_TOKENS);
    return parseVerifyResponse(raw);
  } catch (err) {
    // Never blocks the PR, but stays visible: a silently degraded verifier
    // looked like a real "partial" verdict before this was logged.
    console.warn("[verify] verifier call failed:", loggableError(err));
    return VERIFY_FALLBACK;
  }
}

/** Parse the model's JSON reply; falls back on any malformed shape. Exported for tests. */
export function parseVerifyResponse(raw: string): VerifyResult {
  const stripped = stripFences(raw).trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (typeof parsed !== "object" || parsed === null) return VERIFY_FALLBACK;
    const obj = parsed as Record<string, unknown>;
    const verdict = obj.verdict;
    const notes = obj.notes;
    if (
      (verdict === "match" || verdict === "partial" || verdict === "mismatch") &&
      typeof notes === "string"
    ) {
      return { verdict, notes };
    }
    return VERIFY_FALLBACK;
  } catch {
    return VERIFY_FALLBACK;
  }
}
