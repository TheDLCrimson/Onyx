import type { ChatInputCommandInteraction } from "discord.js";
import { DISCORD_MSG_LIMIT } from "./discord";

const STREAM_EDIT_INTERVAL_MS = 1000;

type FollowUpMessage = Awaited<ReturnType<ChatInputCommandInteraction["followUp"]>>;

/**
 * Pipe an async text stream into a deferred interaction, editing the reply
 * at most once per STREAM_EDIT_INTERVAL_MS to respect Discord rate limits.
 * Splits across follow-up messages when the response exceeds Discord's per-
 * message limit, preferring to break at newline boundaries.
 */
export async function streamToInteraction(
  i: ChatInputCommandInteraction,
  stream: AsyncGenerator<string, void, void>,
): Promise<void> {
  let buffer = "";
  let slotIndex = 0;
  let currentFollowUp: FollowUpMessage | null = null;
  let lastEdit = 0;

  const render = async (): Promise<void> => {
    if (!buffer) return;
    if (slotIndex === 0) {
      await i.editReply(buffer);
    } else if (!currentFollowUp) {
      currentFollowUp = await i.followUp(buffer);
    } else {
      await currentFollowUp.edit(buffer);
    }
  };

  const overflow = async (): Promise<void> => {
    while (buffer.length > DISCORD_MSG_LIMIT) {
      const cutoff = findBreakpoint(buffer, DISCORD_MSG_LIMIT);
      const head = buffer.slice(0, cutoff);
      const tail = buffer.slice(cutoff);
      buffer = head;
      await render();
      buffer = tail;
      slotIndex++;
      currentFollowUp = null;
    }
  };

  for await (const chunk of stream) {
    buffer += chunk;
    await overflow();
    const now = Date.now();
    if (now - lastEdit >= STREAM_EDIT_INTERVAL_MS) {
      await render();
      lastEdit = now;
    }
  }
  await overflow();
  if (!buffer.trim() && slotIndex === 0) {
    await i.editReply("(no response)");
    return;
  }
  await render();
}

/** Find a safe split point ≤ cap, preferring the last newline in the second half. */
function findBreakpoint(text: string, cap: number): number {
  const slice = text.slice(0, cap);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > cap / 2 ? lastNewline + 1 : cap;
}
