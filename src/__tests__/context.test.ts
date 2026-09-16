import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
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
import { COMPACT_RECENT } from "../utils/compact";
import context from "../commands/context";

function makeInteraction(channelId: string) {
  const editReply = vi.fn(async () => ({}));
  const deferReply = vi.fn(async () => ({}));
  return {
    i: { channelId, deferReply, editReply } as unknown as ChatInputCommandInteraction,
    editReply,
  };
}

function getEmbedField(editReply: ReturnType<typeof vi.fn>, name: string): string | undefined {
  const arg = editReply.mock.calls[0]![0] as {
    embeds: { data: { fields?: { name: string; value: string }[] } }[];
  };
  return arg.embeds[0]?.data.fields?.find((f) => f.name === name)?.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
});

describe("/context command — reply shape", () => {
  it("calls deferReply and editReply exactly once", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-1");
    await context.execute(i);
    expect(i.deferReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledOnce();
  });

  it("reply is ephemeral (deferReply called with flags: MessageFlags.Ephemeral)", async () => {
    const { i } = makeInteraction("ch-ctx-ephem");
    await context.execute(i);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it("reply contains an embed with title '📊 Session Context'", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-title");
    await context.execute(i);
    const arg = (editReply.mock.calls as unknown as any[])[0]?.[0] as {
      embeds: { data: { title?: string } }[];
    };
    expect(arg.embeds[0]?.data.title).toBe("📊 Session Context");
  });

  it("embed has all five expected field names", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-fields");
    await context.execute(i);
    const arg = (editReply.mock.calls as unknown as any[])[0]?.[0] as {
      embeds: { data: { fields?: { name: string }[] } }[];
    };
    const names = arg.embeds[0]?.data.fields?.map((f) => f.name) ?? [];
    expect(names).toContain("💬 Messages");
    expect(names).toContain("🪙 Est. Tokens");
    expect(names).toContain("🔑 Mode");
    expect(names).toContain("🤖 Agent");
    expect(names).toContain("✨ Active Feature");
  });
});

describe("/context command — messages field", () => {
  it("shows 'Empty' when session has no messages", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-empty");
    await context.execute(i);
    const val = getEmbedField(editReply, "💬 Messages");
    expect(val).toContain("Empty");
  });

  it("shows all-preserved message when count is at threshold", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-full");
    const session = getOrCreateSession("ch-ctx-full");
    session.messages = Array.from({ length: COMPACT_RECENT }, (_, j) => ({
      role: "user" as const,
      content: `msg ${j}`,
    }));
    await context.execute(i);
    const val = getEmbedField(editReply, "💬 Messages");
    expect(val).toContain("preserved in full");
  });

  it("prompts /compact when above threshold and not yet compacted", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-over");
    const session = getOrCreateSession("ch-ctx-over");
    session.messages = Array.from({ length: COMPACT_RECENT + 5 }, (_, j) => ({
      role: "user" as const,
      content: `msg ${j}`,
    }));
    await context.execute(i);
    const val = getEmbedField(editReply, "💬 Messages");
    expect(val).toContain("/compact");
  });

  it("shows compacted summary hint when first message is a summary", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-compacted");
    const session = getOrCreateSession("ch-ctx-compacted");
    session.messages = [
      { role: "user", content: "[Earlier conversation — summarised:]\n• User: earlier stuff" },
      { role: "assistant", content: "Understood." },
      ...Array.from({ length: COMPACT_RECENT }, (_, j) => ({
        role: "user" as const,
        content: `recent ${j}`,
      })),
    ];
    await context.execute(i);
    const val = getEmbedField(editReply, "💬 Messages");
    expect(val).toContain("compacted summary");
  });
});

describe("/context command — agent field", () => {
  it("shows 'idle' when no running agent", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-idle");
    await context.execute(i);
    const val = getEmbedField(editReply, "🤖 Agent");
    expect(val).toContain("idle");
  });

  it("shows agent kind and state when running", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-agent");
    const session = getOrCreateSession("ch-ctx-agent");
    session.runningAgent = {
      kind: "feature",
      state: "awaiting-button",
      cursor: 3,
      initiatorId: "u1",
      startedAt: Date.now() - 5000,
    };
    await context.execute(i);
    const val = getEmbedField(editReply, "🤖 Agent");
    expect(val).toContain("feature");
    expect(val).toContain("awaiting-button");
    expect(val).toContain("cursor @ msg 3");
  });
});

describe("/context command — mode field", () => {
  it("shows pr mode by default", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-mode-pr");
    await context.execute(i);
    const val = getEmbedField(editReply, "🔑 Mode");
    expect(val).toContain("pr");
  });

  it("shows plan mode when session is in plan mode", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-mode-plan");
    const session = getOrCreateSession("ch-ctx-mode-plan");
    session.mode = "plan";
    await context.execute(i);
    const val = getEmbedField(editReply, "🔑 Mode");
    expect(val).toContain("plan");
  });
});

describe("/context command — active feature field", () => {
  it("shows 'None' when no active feature", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-nofeat");
    await context.execute(i);
    const val = getEmbedField(editReply, "✨ Active Feature");
    expect(val).toContain("None");
  });

  it("shows feature title and PR number when active", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-feat");
    const session = getOrCreateSession("ch-ctx-feat");
    session.active = {
      branch: "onyx/dark-mode",
      prNumber: 42,
      title: "Add dark mode",
      paths: new Set(["src/theme.ts"]),
      turns: [],
      createdAt: Date.now(),
    };
    await context.execute(i);
    const val = getEmbedField(editReply, "✨ Active Feature");
    expect(val).toContain("Add dark mode");
    expect(val).toContain("PR #42");
    expect(val).toContain("onyx/dark-mode");
    expect(val).toContain("1 file");
  });
});

describe("/context command — token estimate", () => {
  it("returns ~0 tokens for empty session", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-tok-0");
    await context.execute(i);
    const val = getEmbedField(editReply, "🪙 Est. Tokens");
    expect(val).toContain("~0");
  });

  it("estimates tokens proportional to content length", async () => {
    const { i, editReply } = makeInteraction("ch-ctx-tok-est");
    const session = getOrCreateSession("ch-ctx-tok-est");
    // 400 chars total → ~100 tokens
    session.messages = [{ role: "user", content: "a".repeat(400) }];
    await context.execute(i);
    const val = getEmbedField(editReply, "🪙 Est. Tokens");
    expect(val).toContain("~100");
  });
});
