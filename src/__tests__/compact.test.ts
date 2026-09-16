import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// Prevent disk I/O from sessions.ts
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";
import { buildAskContext, compactMessages, COMPACT_RECENT } from "../utils/compact";
import compact from "../commands/compact";

// ---------------------------------------------------------------------------
// compactMessages
// ---------------------------------------------------------------------------

describe("compactMessages", () => {
  it("starts with the header line", () => {
    const result = compactMessages([{ role: "user", content: "hello" }]);
    expect(result.startsWith("[Earlier conversation — summarised:]")).toBe(true);
  });

  it("includes user messages truncated to 300 chars", () => {
    const long = "a".repeat(400);
    const result = compactMessages([{ role: "user", content: long }]);
    expect(result).toContain(`• User: ${"a".repeat(300)}`);
    expect(result).not.toContain("a".repeat(301));
  });

  it("includes assistant text responses", () => {
    const result = compactMessages([{ role: "assistant", content: "I found the file." }]);
    expect(result).toContain("• Said: I found the file.");
  });

  it("includes tool call names for assistant tool-call messages", () => {
    const msg = {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ function: { name: "Read" } }, { function: { name: "Grep" } }],
    };
    const result = compactMessages([msg as Parameters<typeof compactMessages>[0][number]]);
    expect(result).toContain("• Called: Read, Grep");
  });

  it("skips tool-result messages (role: tool)", () => {
    const result = compactMessages([
      { role: "tool" as const, content: "file contents here", tool_call_id: "tc-1" },
    ]);
    // Only the header line — no bullet for the tool result
    expect(result.split("\n")).toHaveLength(1);
  });

  it("skips blank assistant content", () => {
    const result = compactMessages([{ role: "assistant", content: "   " }]);
    expect(result.split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildAskContext
// ---------------------------------------------------------------------------

describe("buildAskContext", () => {
  it("returns messages unchanged when at or below the threshold", () => {
    const msgs = Array.from({ length: COMPACT_RECENT }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    expect(buildAskContext(msgs)).toBe(msgs);
  });

  it("returns unchanged when empty", () => {
    const msgs: Parameters<typeof buildAskContext>[0] = [];
    expect(buildAskContext(msgs)).toBe(msgs);
  });

  it("returns 3 output messages when input is COMPACT_RECENT + 1", () => {
    const msgs = Array.from({ length: COMPACT_RECENT + 1 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    const out = buildAskContext(msgs);
    // summary user msg + "Understood." + COMPACT_RECENT recent msgs
    expect(out).toHaveLength(COMPACT_RECENT + 2);
  });

  it("first output message is a user-role compacted summary", () => {
    const msgs = Array.from({ length: COMPACT_RECENT + 5 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    const out = buildAskContext(msgs);
    expect(out[0]?.role).toBe("user");
    expect(typeof out[0]?.content).toBe("string");
    expect((out[0]?.content as string).startsWith("[Earlier conversation — summarised:]")).toBe(
      true,
    );
  });

  it("second output message is the Understood ack", () => {
    const msgs = Array.from({ length: COMPACT_RECENT + 2 }, (_, i) => ({
      role: "user" as const,
      content: `q${i}`,
    }));
    const out = buildAskContext(msgs);
    expect(out[1]).toEqual({ role: "assistant", content: "Understood." });
  });

  it("preserves the last COMPACT_RECENT messages verbatim", () => {
    const msgs = Array.from({ length: COMPACT_RECENT + 3 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    const out = buildAskContext(msgs);
    const recent = out.slice(2);
    const expected = msgs.slice(-COMPACT_RECENT);
    expect(recent).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// /compact command
// ---------------------------------------------------------------------------

function makeInteraction(channelId: string) {
  const editReply = vi.fn(async () => ({}));
  const deferReply = vi.fn(async () => ({}));
  return {
    i: { channelId, deferReply, editReply } as unknown as ChatInputCommandInteraction,
    editReply,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
});

describe("/compact command", () => {
  it("replies with 'nothing to compact' when messages are at or below threshold", async () => {
    const { i, editReply } = makeInteraction("ch-compact-1");
    const session = getOrCreateSession("ch-compact-1");
    session.messages = Array.from({ length: COMPACT_RECENT }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    await compact.execute(i);
    expect(editReply).toHaveBeenCalledOnce();
    expect((editReply.mock.calls as unknown as any[])[0]?.[0] as string).toContain(
      "Nothing to compact",
    );
  });

  it("mutates session.messages when above threshold", async () => {
    const { i } = makeInteraction("ch-compact-2");
    const session = getOrCreateSession("ch-compact-2");
    const total = COMPACT_RECENT + 10;
    session.messages = Array.from({ length: total }, (_, j) => ({
      role: "user" as const,
      content: `msg ${j}`,
    }));
    await compact.execute(i);
    // summary pair + COMPACT_RECENT recent
    expect(session.messages).toHaveLength(COMPACT_RECENT + 2);
  });

  it("reports the before → after count in the reply", async () => {
    const { i, editReply } = makeInteraction("ch-compact-3");
    const session = getOrCreateSession("ch-compact-3");
    const total = COMPACT_RECENT + 5;
    session.messages = Array.from({ length: total }, (_, j) => ({
      role: "user" as const,
      content: `msg ${j}`,
    }));
    await compact.execute(i);
    const reply = (editReply.mock.calls as unknown as any[])[0]?.[0] as string;
    expect(reply).toContain("✅");
    expect(reply).toContain(`${total}`);
    expect(reply).toContain(`${COMPACT_RECENT + 2}`);
  });

  it("blocks when an agent is running", async () => {
    const { i, editReply } = makeInteraction("ch-compact-busy");
    const session = getOrCreateSession("ch-compact-busy");
    session.runningAgent = {
      kind: "feature",
      state: "running",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    session.messages = Array.from({ length: COMPACT_RECENT + 1 }, (_, j) => ({
      role: "user" as const,
      content: `msg ${j}`,
    }));
    await compact.execute(i);
    expect((editReply.mock.calls as unknown as any[])[0]?.[0] as string).toContain("⏳");
    // Messages must NOT have been mutated
    expect(session.messages).toHaveLength(COMPACT_RECENT + 1);
  });

  it("first result message is a compacted summary", async () => {
    const { i } = makeInteraction("ch-compact-shape");
    const session = getOrCreateSession("ch-compact-shape");
    session.messages = Array.from({ length: COMPACT_RECENT + 4 }, (_, j) => ({
      role: "user" as const,
      content: `question ${j}`,
    }));
    await compact.execute(i);
    const first = session.messages[0];
    expect(first?.role).toBe("user");
    expect((first?.content as string).startsWith("[Earlier conversation — summarised:]")).toBe(
      true,
    );
  });
});
