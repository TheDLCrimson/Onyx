import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import type { SendableChannels } from "discord.js";
import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return { ...actual, chatCompletion: vi.fn() };
});

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => ({
    readFile: vi.fn(),
    listDir: vi.fn(),
    searchCode: vi.fn(),
  })),
}));

import { chatCompletion } from "../services/llm";
import { resumeAsk, postAskIterationCapPause, ASK_SYSTEM_PROMPT } from "../runtime/askRunner";

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

function makeChannel() {
  return {
    id: "ch1",
    send: vi.fn().mockResolvedValue({ id: "msg1" }),
  } as unknown as SendableChannels;
}

function textOnly(text: string): ChatCompletion {
  return {
    id: "1",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: text, refusal: null },
      },
    ],
  } as unknown as ChatCompletion;
}

function callTool(name: string): ChatCompletion {
  return {
    id: "1",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }],
        },
      },
    ],
  } as unknown as ChatCompletion;
}

beforeEach(() => {
  vi.mocked(chatCompletion).mockReset();
  _resetAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// resumeAsk — button-cancel
// ---------------------------------------------------------------------------

describe("resumeAsk — button-cancel", () => {
  it("clears runningAgent and sends cancel message", async () => {
    const session = getOrCreateSession("ch1");
    session.runningAgent = {
      kind: "ask",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    const channel = makeChannel();
    await resumeAsk({ session, channel, scopeId: "s1" }, { kind: "button-cancel" });

    expect(session.runningAgent).toBeNull();
    expect(vi.mocked(channel.send)).toHaveBeenCalledOnce();
    const msg = vi.mocked(channel.send).mock.calls[0][0] as string;
    expect(msg).toContain("❌");
  });

  it("no-ops if runningAgent is not kind=ask", async () => {
    const session = getOrCreateSession("ch1");
    session.runningAgent = {
      kind: "feature",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    const channel = makeChannel();
    await resumeAsk({ session, channel, scopeId: "s1" }, { kind: "button-cancel" });

    // Should not have cleared or sent — it's not an ask agent
    expect(session.runningAgent).not.toBeNull();
    expect(vi.mocked(channel.send)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resumeAsk — button-continue
// ---------------------------------------------------------------------------

describe("resumeAsk — button-continue", () => {
  it("resumes and clears agent on clean completion", async () => {
    const session = getOrCreateSession("ch1");
    session.messages = [{ role: "user", content: "what is x?" }];
    session.runningAgent = {
      kind: "ask",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("x is 42"));
    const channel = makeChannel();

    await resumeAsk({ session, channel, scopeId: "s1" }, { kind: "button-continue" });

    expect(session.runningAgent).toBeNull();
    expect(vi.mocked(channel.send)).toHaveBeenCalledOnce();
    const msg = vi.mocked(channel.send).mock.calls[0][0] as string;
    expect(msg).toContain("x is 42");
  });

  it("re-offers buttons if cap fires again on resume", async () => {
    const session = getOrCreateSession("ch1");
    session.messages = [{ role: "user", content: "complex question" }];
    session.runningAgent = {
      kind: "ask",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    // Tool call every iteration → truncated at maxIterations=1
    vi.mocked(chatCompletion).mockResolvedValue(callTool("List"));

    await resumeAsk(
      { session, channel: makeChannel(), scopeId: "s1" },
      { kind: "button-continue" },
    );

    // runningAgent should still be set (still paused)
    expect(session.runningAgent).not.toBeNull();
    expect(session.runningAgent?.kind).toBe("ask");
  });

  it("sends the system prompt as the first message in the resumed call", async () => {
    const session = getOrCreateSession("ch1");
    session.messages = [{ role: "user", content: "hi" }];
    session.runningAgent = {
      kind: "ask",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("done"));
    const channel = makeChannel();

    await resumeAsk({ session, channel, scopeId: "s1" }, { kind: "button-continue" });

    const call = vi.mocked(chatCompletion).mock.calls[0][0];
    // System message is now a structured content array with cache_control on the
    // static prefix (PR α — prompt caching). The text payload still matches.
    expect(call.messages[0].role).toBe("system");
    const blocks = call.messages[0].content as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toMatchObject({
      type: "text",
      text: ASK_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    });
  });
});

// ---------------------------------------------------------------------------
// postAskIterationCapPause
// ---------------------------------------------------------------------------

describe("postAskIterationCapPause", () => {
  it("sends model text then the cap message with two buttons", async () => {
    const channel = makeChannel();
    await postAskIterationCapPause(channel, "scope1", "partial answer");

    expect(vi.mocked(channel.send)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(channel.send).mock.calls[0][0] as string;
    expect(first).toBe("partial answer");
    const second = vi.mocked(channel.send).mock.calls[1][0] as {
      content: string;
      components: unknown[];
    };
    expect(second.content).toContain("Tool-call limit reached");
    expect(second.components).toHaveLength(1); // one ActionRow
  });

  it("skips model text send when modelText is empty", async () => {
    const channel = makeChannel();
    await postAskIterationCapPause(channel, "scope1", "");

    expect(vi.mocked(channel.send)).toHaveBeenCalledOnce();
    const msg = vi.mocked(channel.send).mock.calls[0][0] as { content: string };
    expect(msg.content).toContain("Tool-call limit reached");
  });

  it("embeds continue and cancel customIds in the buttons", async () => {
    const channel = makeChannel();
    await postAskIterationCapPause(channel, "myscope", "");

    const row = (
      vi.mocked(channel.send).mock.calls[0][0] as unknown as {
        components: { components: { data: { custom_id: string } }[] }[];
      }
    ).components[0];
    const ids = row.components.map((b: { data: { custom_id: string } }) => b.data.custom_id);
    expect(ids).toContain("feature:continue:myscope");
    expect(ids).toContain("feature:cancel:myscope");
  });
});
