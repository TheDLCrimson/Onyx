import { APIConnectionError, APIError } from "openai";

/** Longest provider detail we echo back to Discord. */
const DETAIL_MAX_CHARS = 200;

/**
 * Turn an OpenRouter / OpenAI-SDK error into a message a Discord user can act
 * on. Returns null for anything that is not a model-API error so callers can
 * fall back to the raw message (GitHub errors, programming errors, ...).
 */
export function describeModelError(err: unknown): string | null {
  if (err instanceof APIConnectionError) {
    return "Couldn't reach OpenRouter (network error or timeout). Try again in a moment.";
  }
  if (!(err instanceof APIError)) return null;

  const status = err.status;
  const detail = providerDetail(err);
  switch (status) {
    case 401:
      return "OpenRouter rejected the API key (401). The bot operator needs to check `OPENROUTER_API_KEY`.";
    case 402:
      return (
        "OpenRouter reports insufficient credits (402). The bot operator can add credits " +
        "or switch to a free (`:free`) model."
      );
    case 429:
      return (
        "The model provider is rate-limiting requests (429). This is common with free models - " +
        "wait a minute and try again, or configure fallback models."
      );
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
      return `The model provider is temporarily unavailable (${status}). Try again in a moment.`;
  }
  const hint = /model/i.test(detail)
    ? " Check the configured model ids (`ONYX_MODEL` / `ONYX_MODEL_LIGHT`)."
    : "";
  const sentence = /[.!?]$/.test(detail) ? detail : `${detail}.`;
  return `Model request failed (${status ?? "no status"}): ${sentence}${hint}`;
}

/**
 * What to hand `console.error` for a failed call: a one-line summary for
 * model-API errors (the SDK error object drags every response header along),
 * the original error — stack included — for everything else.
 */
export function loggableError(err: unknown): unknown {
  if (err instanceof APIError)
    return `OpenRouter API error ${err.status ?? "(no status)"}: ${providerDetail(err)}`;
  return err;
}

/** Provider message without the SDK's leading status code, capped for Discord. */
function providerDetail(err: APIError): string {
  const text = err.message.replace(/^\d{3}\s+/, "").trim() || "unknown error";
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS - 1)}…` : text;
}
