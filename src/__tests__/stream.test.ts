import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_MSG_LIMIT } from "../utils/discord";
import { streamToInteraction } from "../utils/stream";

/** Build a fake interaction that records editReply / followUp calls. */
function mockInteraction() {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUpMsg = { edit: vi.fn().mockResolvedValue(undefined) };
  const followUp = vi.fn().mockResolvedValue(followUpMsg);
  const i = { editReply, followUp } as unknown as ChatInputCommandInteraction;
  return { i, editReply, followUp, followUpMsg };
}

async function* fromArray(chunks: string[]): AsyncGenerator<string, void, void> {
  for (const c of chunks) yield c;
}

describe("streamToInteraction()", () => {
  it("renders short streams via editReply only", async () => {
    const { i, editReply, followUp } = mockInteraction();
    await streamToInteraction(i, fromArray(["hello ", "world"]));
    expect(editReply).toHaveBeenCalled();
    expect(editReply).toHaveBeenLastCalledWith("hello world");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("shows '(no response)' if the stream yields nothing", async () => {
    const { i, editReply } = mockInteraction();
    await streamToInteraction(i, fromArray([]));
    expect(editReply).toHaveBeenLastCalledWith("(no response)");
  });

  it("splits into follow-up messages when output exceeds the limit", async () => {
    const { i, editReply, followUp } = mockInteraction();
    const long = "x".repeat(DISCORD_MSG_LIMIT * 2 + 100);
    await streamToInteraction(i, fromArray([long]));
    expect(editReply).toHaveBeenCalled();
    // 1 editReply (slot 0) + 2 followUps (slots 1 and 2) for ~3900 chars.
    expect(followUp).toHaveBeenCalledTimes(2);
  });

  it("breaks at the last newline when one is available in the second half", async () => {
    const { i, editReply } = mockInteraction();
    // Newline at position 1500 — well past the cap/2 threshold of 950.
    const text = "a".repeat(1500) + "\n" + "b".repeat(300) + "\n" + "c".repeat(300);
    await streamToInteraction(i, fromArray([text]));
    const firstSlotText = editReply.mock.calls[0]?.[0] as string;
    expect(firstSlotText.endsWith("\n")).toBe(true);
    expect(firstSlotText.length).toBeLessThanOrEqual(DISCORD_MSG_LIMIT);
  });
});
