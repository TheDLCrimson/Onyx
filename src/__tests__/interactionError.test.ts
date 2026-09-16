import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: a command failure used to be reported by replyError, which could
 * itself throw (Discord error 40060, "Interaction has already been
 * acknowledged"). That rejection was unhandled and killed the bot process.
 */

// Prevent disk I/O from repoStore / sessions module initialisation.
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

import { noteStaleInteraction, replyError } from "../events/interactionCreate";

type FakeInteraction = Parameters<typeof replyError>[0];

function makeInteraction(over: Record<string, unknown> = {}) {
  return {
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    ...over,
  } as unknown as FakeInteraction & {
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replyError", () => {
  it("replies ephemerally when the interaction is untouched", async () => {
    const i = makeInteraction();
    await replyError(i, new Error("boom"));
    expect(i.reply).toHaveBeenCalledOnce();
    expect((i.reply.mock.calls[0][0] as { content: string }).content).toContain("boom");
    expect(i.followUp).not.toHaveBeenCalled();
  });

  it("edits the reply when the interaction was already deferred", async () => {
    const i = makeInteraction({ deferred: true });
    await replyError(i, new Error("boom"));
    expect(i.editReply).toHaveBeenCalledOnce();
    expect(i.reply).not.toHaveBeenCalled();
  });

  it("falls back to followUp when Discord says it is already acknowledged", async () => {
    const i = makeInteraction({
      reply: vi.fn(async () => {
        throw new Error("Interaction has already been acknowledged.");
      }),
    });
    await expect(replyError(i, new Error("boom"))).resolves.toBeUndefined();
    expect(i.followUp).toHaveBeenCalledOnce();
  });

  it("never throws, even when every delivery path fails", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("discord is down");
    };
    const i = makeInteraction({
      reply: vi.fn(fail),
      editReply: vi.fn(fail),
      followUp: vi.fn(fail),
    });
    await expect(replyError(i, new Error("boom"))).resolves.toBeUndefined();
  });

  it("logs the original failure so the cause is not lost", async () => {
    const i = makeInteraction();
    await replyError(i, new Error("the real cause"));
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .map(String)
      .join(" ");
    expect(logged).toContain("the real cause");
  });
});

describe("replyError — last-resort channel fallback", () => {
  it("posts in the channel when the interaction itself is unusable", async () => {
    const send = vi.fn(async (_content: unknown) => undefined);
    const i = makeInteraction({
      reply: vi.fn(async () => {
        throw new Error("Interaction has already been acknowledged.");
      }),
      followUp: vi.fn(async () => {
        throw new Error("The reply to this interaction has not been sent or deferred.");
      }),
      channel: { isSendable: () => true, send },
    });
    await expect(replyError(i, new Error("boom"))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0][0])).toContain("boom");
  });

  it("stays quiet when the channel cannot be written to", async () => {
    const i = makeInteraction({
      reply: vi.fn(async () => {
        throw new Error("nope");
      }),
      followUp: vi.fn(async () => {
        throw new Error("nope");
      }),
      channel: { isSendable: () => false, send: vi.fn() },
    });
    await expect(replyError(i, new Error("boom"))).resolves.toBeUndefined();
  });

  it("does not post in the channel when the follow-up succeeded", async () => {
    const send = vi.fn(async () => undefined);
    const i = makeInteraction({
      reply: vi.fn(async () => {
        throw new Error("already acknowledged");
      }),
      channel: { isSendable: () => true, send },
    });
    await replyError(i, new Error("boom"));
    expect(i.followUp).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("noteStaleInteraction", () => {
  function staleCommand(over: Record<string, unknown> = {}) {
    return {
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName: "feature",
      createdTimestamp: Date.now() - 9000,
      ...over,
    } as unknown as Parameters<typeof noteStaleInteraction>[0];
  }

  it("explains the lag in the channel instead of failing silently", async () => {
    const send = vi.fn(async (_content: unknown) => undefined);
    const i = staleCommand({ channel: { isSendable: () => true, send } });
    await noteStaleInteraction(i, 9000);
    expect(send).toHaveBeenCalledOnce();
    const msg = String(send.mock.calls[0][0]);
    expect(msg).toContain("/feature");
    expect(msg).toContain("too late");
    expect(msg).toContain("try again");
  });

  it("logs the measured age so the operator can see the lag", async () => {
    const i = staleCommand({ channel: { isSendable: () => false, send: vi.fn() } });
    await noteStaleInteraction(i, 4321);
    const logged = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .map(String)
      .join(" ");
    expect(logged).toContain("4321ms");
  });

  it("never throws when the channel rejects the notice", async () => {
    const i = staleCommand({
      channel: {
        isSendable: () => true,
        send: vi.fn(async () => {
          throw new Error("no perms");
        }),
      },
    });
    await expect(noteStaleInteraction(i, 5000)).resolves.toBeUndefined();
  });
});
