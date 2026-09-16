import { describe, expect, it, vi } from "vitest";
import {
  CONTINUATION_PREFIX,
  DISCORD_MSG_LIMIT,
  errText,
  replyLong,
  sendLong,
  splitMessage,
  truncate,
} from "../utils/discord";

describe("truncate()", () => {
  it("returns short input unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("returns input exactly at the limit unchanged", () => {
    const s = "x".repeat(DISCORD_MSG_LIMIT);
    expect(truncate(s)).toBe(s);
  });

  it("appends a marker when over the limit", () => {
    const s = "x".repeat(DISCORD_MSG_LIMIT + 100);
    const result = truncate(s);
    expect(result.startsWith("x".repeat(DISCORD_MSG_LIMIT))).toBe(true);
    expect(result).toContain("…(truncated)");
  });
});

describe("splitMessage()", () => {
  it("returns a single chunk when text fits the limit", () => {
    const result = splitMessage("short text", 100);
    expect(result).toEqual(["short text"]);
  });

  it("returns a single chunk when text is exactly the limit", () => {
    const s = "x".repeat(100);
    expect(splitMessage(s, 100)).toEqual([s]);
  });

  it("splits into multiple chunks each within the limit", () => {
    const s = "x".repeat(250);
    const chunks = splitMessage(s, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(s);
  });

  it("prefers splitting at a newline near the limit", () => {
    // Build a string where a newline sits past the halfway point.
    const first = "a".repeat(60) + "\n";
    const second = "b".repeat(60);
    const result = splitMessage(first + second, 100);
    // Should split after the newline, not at char 100.
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  it("falls back to a hard cut when the newline is in the first half", () => {
    const s = "a\n" + "b".repeat(98); // newline at index 1, well before midpoint
    const chunks = splitMessage(s, 100);
    expect(chunks[0]?.length).toBe(100);
  });

  it("uses DISCORD_MSG_LIMIT as default", () => {
    const short = "hi";
    expect(splitMessage(short)).toEqual([short]);
    const long = "x".repeat(DISCORD_MSG_LIMIT + 1);
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("errText()", () => {
  it("returns the message of an Error", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errText("oops")).toBe("oops");
    expect(errText(42)).toBe("42");
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });
});

describe("sendLong()", () => {
  it("sends a single message when content fits the limit", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { send } as unknown as Parameters<typeof sendLong>[0];
    await sendLong(channel, "hello");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("splits long content and prefixes continuation chunks", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { send } as unknown as Parameters<typeof sendLong>[0];
    const content = "A".repeat(1950); // > 1900 → 2 chunks
    await sendLong(channel, content);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe("A".repeat(1900));
    expect((send.mock.calls[1] as unknown as [string])[0]).toBe(
      `${CONTINUATION_PREFIX}${"A".repeat(50)}`,
    );
  });

  it("no-ops on empty or whitespace-only content", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { send } as unknown as Parameters<typeof sendLong>[0];
    await sendLong(channel, "");
    await sendLong(channel, "   ");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("replyLong()", () => {
  it("uses reply() for the first chunk and send() for overflow", async () => {
    const reply = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const msg = { reply, channel: { send } } as unknown as Parameters<typeof replyLong>[0];
    const content = "B".repeat(1950);
    await replyLong(msg, content);
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("B".repeat(1900));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(`${CONTINUATION_PREFIX}${"B".repeat(50)}`);
  });

  it("uses only reply() when content fits in one message", async () => {
    const reply = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const msg = { reply, channel: { send } } as unknown as Parameters<typeof replyLong>[0];
    await replyLong(msg, "short answer");
    expect(reply).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops on empty content", async () => {
    const reply = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const msg = { reply, channel: { send } } as unknown as Parameters<typeof replyLong>[0];
    await replyLong(msg, "");
    expect(reply).not.toHaveBeenCalled();
  });
});
