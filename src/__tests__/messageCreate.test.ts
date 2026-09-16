import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResumeFeature } = vi.hoisted(() => ({
  mockResumeFeature: vi.fn(async () => undefined),
}));

vi.mock("../runtime/featureRunner", () => ({
  resumeFeature: mockResumeFeature,
}));

// Prevent disk I/O.
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
import { register } from "../events/messageCreate";
import type { Client, Events } from "discord.js";

/** Minimal fake Discord client that captures the MessageCreate handler. */
function makeClient() {
  let handler: ((msg: unknown) => void) | undefined;
  const client = {
    on: vi.fn((event: string, fn: (msg: unknown) => void) => {
      if (event === "messageCreate") handler = fn;
    }),
    emit: (msg: unknown) => handler?.(msg),
  } as unknown as Client;
  return { client, emit: (msg: unknown) => handler?.(msg) };
}

function makeRunningAgent(initiatorId: string) {
  return {
    kind: "feature" as const,
    state: "awaiting-user-text" as const,
    cursor: 0,
    initiatorId,
    startedAt: Date.now(),
  };
}

function makeMsg(
  authorId: string,
  content: string,
  {
    bot = false,
    channelId = "ch-1",
    sendable = true,
  }: { bot?: boolean; channelId?: string; sendable?: boolean } = {},
) {
  return {
    author: { id: authorId, bot },
    content,
    channelId,
    channel: {
      isSendable: () => sendable,
    },
    reply: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
});

describe("messageCreate — initiator-only clarification gate", () => {
  it("feeds the message into resumeFeature when author is the initiator", async () => {
    const { client, emit } = makeClient();
    register(client);

    const session = getOrCreateSession("ch-1");
    session.runningAgent = makeRunningAgent("user-A");

    await emit(makeMsg("user-A", "use Postgres please"));
    expect(mockResumeFeature).toHaveBeenCalledOnce();
    expect(mockResumeFeature).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorId: "user-A" }),
      { kind: "user-text", text: "use Postgres please" },
    );
  });

  it("ignores messages from a different user", async () => {
    const { client, emit } = makeClient();
    register(client);

    const session = getOrCreateSession("ch-2");
    session.runningAgent = makeRunningAgent("user-A");

    await emit(makeMsg("user-B", "use Postgres please", { channelId: "ch-2" }));
    expect(mockResumeFeature).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    const { client, emit } = makeClient();
    register(client);

    const session = getOrCreateSession("ch-3");
    session.runningAgent = makeRunningAgent("bot-id");

    await emit(makeMsg("bot-id", "use Postgres please", { bot: true, channelId: "ch-3" }));
    expect(mockResumeFeature).not.toHaveBeenCalled();
  });

  it("ignores messages shorter than the minimum length", async () => {
    const { client, emit } = makeClient();
    register(client);

    const session = getOrCreateSession("ch-4");
    session.runningAgent = makeRunningAgent("user-A");

    await emit(makeMsg("user-A", "ok", { channelId: "ch-4" }));
    expect(mockResumeFeature).not.toHaveBeenCalled();
  });

  it("ignores messages when runningAgent state is not awaiting-user-text", async () => {
    const { client, emit } = makeClient();
    register(client);

    const session = getOrCreateSession("ch-5");
    session.runningAgent = { ...makeRunningAgent("user-A"), state: "awaiting-button" };

    await emit(makeMsg("user-A", "proceed with plan", { channelId: "ch-5" }));
    expect(mockResumeFeature).not.toHaveBeenCalled();
  });

  it("ignores messages when there is no running agent", async () => {
    const { client, emit } = makeClient();
    register(client);

    getOrCreateSession("ch-6"); // no runningAgent

    await emit(makeMsg("user-A", "proceed with plan", { channelId: "ch-6" }));
    expect(mockResumeFeature).not.toHaveBeenCalled();
  });
});
