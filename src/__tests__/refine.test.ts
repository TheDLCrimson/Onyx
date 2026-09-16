import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import type { ActiveFeature, SlashCommand } from "../types";
import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";

// Mock featureRunner before importing refine (vitest hoists vi.mock)
vi.mock("../runtime/featureRunner", () => ({
  startRefine: vi.fn(async () => undefined),
}));

// Now import — the mock is in place
import refine from "../commands/refine";
import { startRefine } from "../runtime/featureRunner";

function makeActiveFeature(): ActiveFeature {
  return {
    branch: "onyx/x-1",
    prNumber: 42,
    title: "Add feedback system",
    paths: new Set(["src/feedback.ts"]),
    turns: [],
    createdAt: Date.now(),
  };
}

function makeInteraction(intent: string, channelSendable = true, channelId = "ch-1") {
  const replyMock = vi.fn(async () => undefined);
  return {
    channelId,
    user: { id: "user-test" },
    channel: { isSendable: () => channelSendable },
    reply: replyMock,
    options: {
      getString: vi.fn((name: string) => (name === "intent" ? intent : null)),
    },
  } as unknown as Parameters<SlashCommand["execute"]>[0];
}

beforeEach(() => {
  _resetAllSessionsForTesting();
  vi.clearAllMocks();
});

describe("refine command", () => {
  it("rejects when no active feature exists", async () => {
    const i = makeInteraction("add validation");
    await refine.execute(i);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No active feature"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(startRefine).not.toHaveBeenCalled();
  });

  it("rejects when the session is busy", async () => {
    const session = getOrCreateSession("ch-1");
    session.runningAgent = {
      kind: "feature",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "user-1",
      startedAt: Date.now(),
    };
    session.active = makeActiveFeature();
    const i = makeInteraction("add validation");
    await refine.execute(i);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("in plan mode"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(startRefine).not.toHaveBeenCalled();
  });

  it("rejects when intent is too short", async () => {
    const session = getOrCreateSession("ch-1");
    session.active = makeActiveFeature();
    const i = makeInteraction("x");
    await refine.execute(i);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("more specific"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(startRefine).not.toHaveBeenCalled();
  });

  it("rejects when channel is not sendable", async () => {
    const session = getOrCreateSession("ch-1");
    session.active = makeActiveFeature();
    const i = makeInteraction("add validation", false);
    await refine.execute(i);
    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("sendable text channel"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(startRefine).not.toHaveBeenCalled();
  });

  it("calls startRefine when all checks pass", async () => {
    const session = getOrCreateSession("ch-1");
    session.active = makeActiveFeature();
    const i = makeInteraction("add validation to feedback form");
    await refine.execute(i);
    expect(startRefine).toHaveBeenCalledOnce();
    expect(startRefine).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "add validation to feedback form",
        session,
      }),
    );
  });
});
