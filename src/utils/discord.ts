import type { SendableChannels } from "discord.js";
import { describeModelError } from "./modelErrors";

/** Per-message length limit we render up to (Discord's hard cap is 2000). */
export const DISCORD_MSG_LIMIT = 1900;

/** Prefix attached to each continuation chunk so users know the response continues. */
export const CONTINUATION_PREFIX = "↪️ ";

/** Truncate text to fit a single Discord message, with a marker if cut. */
export function truncate(text: string): string {
  return text.length <= DISCORD_MSG_LIMIT
    ? text
    : `${text.slice(0, DISCORD_MSG_LIMIT)}\n…(truncated)`;
}

/** Best-effort error → string for user-facing replies. */
export function errText(err: unknown): string {
  const modelError = describeModelError(err);
  if (modelError) return modelError;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Split long text into Discord-sized chunks, preferring newline break points.
 * Used when a single message (e.g. a long plan) must span multiple sends,
 * with buttons attached only to the last chunk.
 */
export function splitMessage(text: string, limit: number = DISCORD_MSG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const lastNewline = slice.lastIndexOf("\n");
    // Prefer a newline boundary if it's past the halfway point (avoids tiny chunks).
    const cut = lastNewline > Math.floor(limit / 2) ? lastNewline + 1 : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Send potentially long content to a Discord channel, splitting into as many
 * messages as needed. Continuation chunks carry CONTINUATION_PREFIX so users
 * know the response is continuing. No-ops on empty content.
 */
export async function sendLong(channel: SendableChannels, content: string): Promise<void> {
  if (!content.trim()) return;
  const chunks = splitMessage(content);
  await channel.send(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await channel.send(`${CONTINUATION_PREFIX}${chunks[i]}`);
  }
}

/**
 * Reply to a Discord message with potentially long content. The first chunk uses
 * `msg.reply()` to keep the visual reply arrow; overflow chunks go to the channel.
 * No-ops on empty content.
 */
export async function replyLong(
  msg: {
    reply(content: string): Promise<unknown>;
    channel: Pick<SendableChannels, "send">;
  },
  content: string,
): Promise<void> {
  if (!content.trim()) return;
  const chunks = splitMessage(content);
  await msg.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await msg.channel.send(`${CONTINUATION_PREFIX}${chunks[i]}`);
  }
}
