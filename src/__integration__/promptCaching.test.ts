import { describe, expect, it } from "vitest";
import { APIError } from "openai";
import { chatCompletion, extractCachedTokens, extractCacheWriteTokens } from "../services/llm";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

const hasOpenRouter = !!process.env.OPENROUTER_API_KEY?.trim();
const describeIfOpenRouter = hasOpenRouter ? describe : describe.skip;

/**
 * Build a synthetic ≥1024-token system prompt by repeating a paragraph until
 * we clear Sonnet's cacheable-prefix minimum. Independent of Onyx's real
 * system prompt content so this test stays stable as prompts evolve.
 */
function bigSystemPrompt(): string {
  const para =
    "You are a careful code assistant. Read files before editing them. " +
    "Prefer small, focused changes. Always run tests after a change. " +
    "When uncertain about a refactor, ask before acting. ";
  // ~110 chars × 50 = ~5500 chars ≈ ~1375 tokens, comfortably above the
  // 1024-token Sonnet cache minimum with ~30% safety margin.
  return Array.from({ length: 50 }, () => para).join("");
}

interface CacheSignals {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function readSignals(usage: unknown): CacheSignals {
  const u = (usage ?? {}) as Record<string, unknown>;
  return {
    promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    cachedTokens: extractCachedTokens(usage) ?? 0,
    cacheWriteTokens: extractCacheWriteTokens(usage) ?? 0,
    costUsd: typeof u.cost === "number" ? u.cost : 0,
  };
}

/** Caching is Anthropic-only; no `:free` model can stand in for it. */
const CACHE_MODEL = "anthropic/claude-sonnet-4.6";

describeIfOpenRouter("Prompt caching — real OpenRouter", () => {
  it("passes cache_control to Anthropic and produces measurable cache hits on the second call", async (ctx) => {
    const systemBase = bigSystemPrompt();

    // Build the same two-block content array continueLoop produces. The
    // cache marker on block 0 should drive cache writes on req 1 and cache
    // reads on req 2.
    const makeMessages = (userText: string): ChatCompletionMessageParam[] => [
      {
        role: "system",
        content: [
          // cache_control is not in the OpenAI SDK types; OpenRouter
          // forwards it to Anthropic.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { type: "text", text: systemBase, cache_control: { type: "ephemeral" } } as any,
        ],
      } as ChatCompletionMessageParam,
      { role: "user", content: userText } as ChatCompletionMessageParam,
    ];

    // Prompt caching is an Anthropic feature, so this test has to spend real
    // credits: there is no `:free` model that exercises it. A 402 means the
    // precondition is unmet, like a missing key - skip rather than fail, so a
    // credit-less account doesn't report a red suite for working code.
    let s1: CacheSignals;
    let s2: CacheSignals;
    try {
      const c1 = await chatCompletion({
        model: CACHE_MODEL,
        max_tokens: 32,
        messages: makeMessages("Reply with the single word: alpha."),
      });
      s1 = readSignals(c1.usage);

      const c2 = await chatCompletion({
        model: CACHE_MODEL,
        max_tokens: 32,
        messages: makeMessages("Reply with the single word: beta."),
      });
      s2 = readSignals(c2.usage);
    } catch (err) {
      if (err instanceof APIError && err.status === 402) {
        ctx.skip(
          `${CACHE_MODEL} needs OpenRouter credits - caching cannot be tested on free models.`,
        );
      }
      throw err;
    }

    // Three convergent signals. Pass if at least two hold — partial-metric
    // exposure shouldn't fool the test, but no-cache-at-all must fail it.
    const hitsCover80pct = s2.cachedTokens > 0 && s2.cachedTokens >= 0.8 * (s1.promptTokens - 50);
    const writeDropOnReq2 =
      s1.cacheWriteTokens > 0
        ? s2.cacheWriteTokens <= 0.1 * s1.cacheWriteTokens
        : s2.cacheWriteTokens === 0;
    const costDrop30pct = s1.costUsd > 0 ? s2.costUsd <= 0.7 * s1.costUsd : false;

    const signals = [hitsCover80pct, writeDropOnReq2, costDrop30pct];
    const passing = signals.filter(Boolean).length;

    // Print all three numbers regardless of outcome — invaluable for future
    // debugging if this test starts failing after a provider drift.
    console.log("[promptCaching.test] req1:", s1);
    console.log("[promptCaching.test] req2:", s2);
    console.log("[promptCaching.test] signals (≥80% hits / write-drop / 30% cost-drop):", {
      hitsCover80pct,
      writeDropOnReq2,
      costDrop30pct,
    });

    expect(passing).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
