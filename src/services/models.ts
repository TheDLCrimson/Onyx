/**
 * Model configuration. Onyx talks to OpenRouter, so any OpenRouter model id
 * works. Two tiers: `heavy` for the agent loop and code generation, `light`
 * for cheap utility calls (summaries, verification, single-file Q&A).
 *
 * Each tier accepts a comma-separated list. The first entry is the primary
 * model; the rest become OpenRouter's `models` fallback array, tried in order
 * when the primary is rate-limited or down (useful with free models).
 */

/** Model tier names. */
export type ModelTier = "heavy" | "light";

/** Defaults used when no env var is set for a tier. */
export const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  heavy: "anthropic/claude-sonnet-4.6",
  light: "anthropic/claude-haiku-4.5",
};

/**
 * Env vars read per tier, in priority order. `CLAUDE_MODEL*` are the legacy
 * names from before Onyx was model-agnostic and are still honoured.
 */
const TIER_ENV_KEYS: Readonly<Record<ModelTier, readonly string[]>> = {
  heavy: ["ONYX_MODEL", "CLAUDE_MODEL"],
  light: ["ONYX_MODEL_LIGHT", "CLAUDE_MODEL_LIGHT"],
};

/** Split a comma-separated model list, trimming blanks and duplicates. */
export function parseModelList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Ordered model ids for a tier: primary first, then fallbacks. Read at call time. */
export function modelsForTier(tier: ModelTier): string[] {
  for (const key of TIER_ENV_KEYS[tier]) {
    const list = parseModelList(process.env[key] || "");
    if (list.length > 0) return list;
  }
  return [DEFAULT_MODELS[tier]];
}

/** Resolve a tier to its primary model id. */
export function resolveModel(tier: ModelTier): string {
  return modelsForTier(tier)[0];
}

/** Request fields that select a tier's model(s) on an OpenRouter completion. */
export interface ModelRequestFields {
  model: string;
  /** OpenRouter fallback routing; only present when more than one model is configured. */
  models?: string[];
}

/**
 * Most ids OpenRouter accepts in one `models` array. Sending more fails the
 * whole request with "'models' array must have 3 items or fewer".
 */
export const MAX_FALLBACK_MODELS = 3;

/**
 * The models actually sent for a tier: primary first, capped at
 * {@link MAX_FALLBACK_MODELS}. Extra entries are dropped rather than passed on,
 * because OpenRouter rejects the whole request when the array is too long.
 */
export function effectiveModels(tier: ModelTier): string[] {
  return modelsForTier(tier).slice(0, MAX_FALLBACK_MODELS);
}

/**
 * Build the model-selection fields for a completion request. Adds OpenRouter's
 * `models` fallback array only when the tier lists more than one model, so a
 * single-model config sends exactly what it always did.
 */
export function modelRequestFields(tier: ModelTier): ModelRequestFields {
  const list = effectiveModels(tier);
  return list.length > 1 ? { model: list[0], models: list } : { model: list[0] };
}

/**
 * True for Anthropic models. Onyx marks its static system prompt with
 * Anthropic's `cache_control`; other providers ignore the marker, so cache
 * diagnostics only mean something for these ids.
 */
export function isAnthropicModel(id: string): boolean {
  return id.startsWith("anthropic/");
}

/** One-line startup summary of the configured models, for operator logs. */
export function describeModelConfig(): string {
  const heavy = modelsForTier("heavy");
  const light = modelsForTier("light");
  const caching = [...heavy, ...light].some(isAnthropicModel)
    ? " (Anthropic prompt caching enabled for stable system prefixes)"
    : "";
  const dropped = [...heavy.slice(MAX_FALLBACK_MODELS), ...light.slice(MAX_FALLBACK_MODELS)];
  const note =
    dropped.length > 0
      ? ` [ignored, past OpenRouter's ${MAX_FALLBACK_MODELS}-model limit: ${dropped.join(", ")}]`
      : "";
  return (
    `[models] heavy: ${effectiveModels("heavy").join(" -> ")} | ` +
    `light: ${effectiveModels("light").join(" -> ")}${caching}${note}`
  );
}
