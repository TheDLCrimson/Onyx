import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendableChannels } from "discord.js";
import { APIError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

/**
 * Regression: a thrown model call (rate limit, invalid model id, provider
 * outage) used to leave `runningAgent.state === "running"` in plan mode, so
 * the channel refused every later command until /reset. Free models hit this
 * constantly.
 */

const { mockRunAgent, mockResumeAgent } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockResumeAgent: vi.fn(),
}));

vi.mock("../services/agent", () => ({
  runAgent: mockRunAgent,
  resumeAgent: mockResumeAgent,
  DEFAULT_MAX_ITERATIONS: 10,
  DEFAULT_BUDGET: { reads: 50, writes: 20, tokens: 200_000 },
  BUILD_FIX_BUDGET: { reads: 10, writes: 5, tokens: 30_000 },
}));

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => ({
    getPullRequestBody: vi.fn(async () => ""),
    updatePullRequest: vi.fn(async () => undefined),
  })),
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

import { _resetAllSessionsForTesting, getOrCreateSession, isBusy } from "../services/sessions";
import { resumeFeature, startFeature } from "../runtime/featureRunner";
import { resumeAsk } from "../runtime/askRunner";

const rateLimited = (): APIError =>
  APIError.generate(
    429,
    { message: "Provider returned error" },
    "Provider returned error",
    new Headers(),
  );

interface SentMessage {
  content: string;
  components?: unknown[];
}

function makeChannel() {
  const sent: SentMessage[] = [];
  const send = vi.fn(async (payload: string | SentMessage) => {
    sent.push(typeof payload === "string" ? { content: payload } : payload);
    return {};
  });
  return {
    channel: { send, sendTyping: vi.fn(async () => undefined) } as unknown as SendableChannels,
    sent,
  };
}

/** Messages as the agent loop would hand to onIteration after one tool round. */
const oneIteration: ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "add a README badge" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "List", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "c1", content: "README.md" },
];

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("featureRunner — model call failures", () => {
  it("clears the run and frees the channel when the first model call fails", async () => {
    mockRunAgent.mockRejectedValue(rateLimited());
    const { channel, sent } = makeChannel();
    const session = getOrCreateSession("ch-fail-1");

    await expect(
      startFeature({
        session,
        channel,
        scopeId: "s",
        initiatorId: "u1",
        intent: "add a README badge",
      }),
    ).resolves.toBeUndefined();

    expect(isBusy(session)).toBe(false);
    expect(session.mode).toBe("pr");
    const last = sent.at(-1)!;
    expect(last.content).toContain("rate-limiting");
    expect(last.content).toContain("No changes were made");
  });

  it("pauses with Continue/Cancel when the run had already made progress", async () => {
    mockRunAgent.mockImplementation(
      async (params: { onIteration?: (m: ChatCompletionMessageParam[]) => void }) => {
        params.onIteration?.(oneIteration);
        throw rateLimited();
      },
    );
    const { channel, sent } = makeChannel();
    const session = getOrCreateSession("ch-fail-2");

    await startFeature({
      session,
      channel,
      scopeId: "s",
      initiatorId: "u1",
      intent: "add a README badge",
    });

    expect(session.runningAgent?.state).toBe("awaiting-button");
    expect(session.messages).toHaveLength(3);
    const last = sent.at(-1)!;
    expect(last.content).toContain("The model call failed");
    expect(last.components).toHaveLength(1);
  });

  it("does not leave a resumed run stuck in 'running' when the model call fails", async () => {
    mockRunAgent.mockImplementation(
      async (params: { onIteration?: (m: ChatCompletionMessageParam[]) => void }) => {
        params.onIteration?.(oneIteration);
        return {
          paused: true,
          reason: "awaiting-user-text",
          messages: oneIteration,
          text: "Which badge?",
          iterations: 1,
        };
      },
    );
    const { channel } = makeChannel();
    const session = getOrCreateSession("ch-fail-3");
    await startFeature({
      session,
      channel,
      scopeId: "s",
      initiatorId: "u1",
      intent: "add a README badge",
    });
    expect(session.runningAgent?.state).toBe("awaiting-user-text");

    mockResumeAgent.mockRejectedValue(rateLimited());
    const second = makeChannel();
    await resumeFeature(
      { session, channel: second.channel, scopeId: "s", initiatorId: "u1" },
      { kind: "user-text", text: "the CI badge" },
    );

    expect(session.runningAgent?.state).toBe("awaiting-button");
    expect(second.sent.at(-1)!.content).toContain("rate-limiting");
    expect(second.sent.at(-1)!.components).toHaveLength(1);
  });
});

describe("askRunner — model call failure on Continue", () => {
  it("drops the paused ask so the channel is not left busy", async () => {
    mockResumeAgent.mockRejectedValue(rateLimited());
    const { channel, sent } = makeChannel();
    const session = getOrCreateSession("ch-ask-fail");
    session.runningAgent = {
      kind: "ask",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "u1",
      startedAt: Date.now(),
    };

    await resumeAsk({ session, channel, scopeId: "s" }, { kind: "button-continue" });

    expect(isBusy(session)).toBe(false);
    expect(sent.at(-1)!.content).toContain("rate-limiting");
  });
});
