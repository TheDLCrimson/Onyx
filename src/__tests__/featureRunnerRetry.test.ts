import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendableChannels } from "discord.js";

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
    getPullRequestBody: vi.fn(async () => "## Summary\n- existing"),
    updatePullRequest: vi.fn(async () => undefined),
  })),
}));

vi.mock("../services/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm")>();
  return { ...actual, verifyPlan: vi.fn(async () => ({ verdict: "match", notes: "ok" })) };
});

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

import { verifyPlan } from "../services/llm";
import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";
import { postToolErrorPause, resumeFeature, startFeature } from "../runtime/featureRunner";

function makeChannel() {
  const send = vi.fn(async () => ({}));
  return { send } as unknown as SendableChannels;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postToolErrorPause", () => {
  it("sends status+buttons as the last message", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-retry", 1);
    await postToolErrorPause(
      { session, channel, initiatorId: "user-test", scopeId: "scope-1" },
      "model error text",
    );
    // 2 sends: model text first, then status+buttons
    expect((channel.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    const lastArg = (channel.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as unknown as {
      content: string;
      components: unknown[];
    };
    expect(typeof lastArg).toBe("object");
    expect(lastArg.content).toContain("⚠️");
    expect(lastArg.content).toContain("Retry");
    expect(lastArg.components).toHaveLength(1);
  });

  it("sends the model text as the first message before the status", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-retry2", 1);
    await postToolErrorPause(
      { session, channel, initiatorId: "user-test", scopeId: "s" },
      "The write failed because…",
    );
    // First send is the model text (plain string via sendLong).
    const firstArg = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(typeof firstArg).toBe("string");
    expect(firstArg).toContain("The write failed because");
  });

  it("sends only the status when modelText is empty", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-retry3", 1);
    await postToolErrorPause({ session, channel, initiatorId: "user-test", scopeId: "s" }, "");
    expect(channel.send).toHaveBeenCalledOnce();
    const arg = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as unknown as {
      content: string;
    };
    expect(arg.content).toContain("⚠️");
    expect(arg.content).not.toContain("Model said");
  });
});

describe("handleAgentOutput — tool error path", () => {
  it("stashes messages on runningAgent (state: awaiting-button) when hadToolError is true", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-err", 1);
    const messages = [{ role: "user" as const, content: "go" }];
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: true,
      text: "something failed",
      iterations: 2,
      messages,
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-1",
      intent: "add a feature",
    });
    expect(session.runningAgent).not.toBeNull();
    expect(session.runningAgent?.state).toBe("awaiting-button");
    // Messages are synced to session.messages (not runningAgent) after the refactor.
    expect(session.messages).toEqual(messages);
  });

  it("calls channel.send at least twice (banner + error pause) on tool error", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-err2", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: true,
      text: "",
      iterations: 1,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-2",
      intent: "do something",
    });
    expect((channel.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT trigger verification when hadToolError is true", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-no-verify", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: true,
      text: "",
      iterations: 1,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-3",
      intent: "do something",
    });
    expect(verifyPlan).not.toHaveBeenCalled();
  });
});

describe("handleAgentOutput — clean completion path", () => {
  it("clears runningAgent on clean completion", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-ok", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "all done",
      iterations: 3,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-4",
      intent: "build something",
    });
    expect(session.runningAgent).toBeNull();
  });

  it("sends the completion text to the channel", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-ok2", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "all done successfully",
      iterations: 1,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-5",
      intent: "tweak",
    });
    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("all done successfully"))).toBe(true);
  });

  it("does not call verifyPlan when there is no planText on the running agent", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-no-plan", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "done",
      iterations: 1,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-6",
      intent: "tweak",
    });
    expect(verifyPlan).not.toHaveBeenCalled();
  });
});

describe("handleAgentOutput — retry gave-up path", () => {
  it("re-surfaces the Retry button when the model completes cleanly on retry without writing", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-gave-up", 1);

    // First run: tool error stashes the agent in awaiting-button.
    mockRunAgent.mockResolvedValueOnce({
      paused: false,
      truncated: false,
      hadToolError: true,
      text: "branch creation failed — no write access",
      iterations: 1,
      messages: [{ role: "user" as const, content: "go" }],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-gave-up",
      intent: "add a feature",
    });
    expect(session.runningAgent?.state).toBe("awaiting-button");

    // Second run (retry): model gives up without making any write tool calls.
    (channel.send as ReturnType<typeof vi.fn>).mockClear();
    mockResumeAgent.mockResolvedValueOnce({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "I still cannot write to the repo — please grant write access first.",
      iterations: 1,
      messages: [],
    });
    await resumeFeature(
      { session, channel, initiatorId: "user-test", scopeId: "sc-gave-up" },
      { kind: "button-retry" },
    );

    // Session must still be stashed — not cleared.
    expect(session.runningAgent).not.toBeNull();
    expect(session.runningAgent?.state).toBe("awaiting-button");

    // Retry + Cancel buttons must have been re-posted.
    const sentArgs = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      JSON.stringify((call as unknown[])[0]),
    );
    expect(sentArgs.some((s) => s.includes("⚠️"))).toBe(true);
    expect(sentArgs.some((s) => s.includes("retry"))).toBe(true);
  });

  it("does NOT re-surface the Retry button on a normal (non-retry) clean completion", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-not-retry", 1);
    mockRunAgent.mockResolvedValue({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "all good",
      iterations: 1,
      messages: [],
    });
    await startFeature({
      session,
      channel,
      initiatorId: "user-test",
      scopeId: "sc-not-retry",
      intent: "do something",
    });
    // Normal completion clears the agent.
    expect(session.runningAgent).toBeNull();
  });
});

describe("resumeFeature — button-approve plan guard", () => {
  it("sends an error and clears the agent when planText is missing on button-approve", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-no-plan-approve", 1);
    session.runningAgent = {
      kind: "refine",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "user-test",
      startedAt: Date.now(),
    };
    session.mode = "plan";

    await resumeFeature(
      { session, channel, initiatorId: "user-test", scopeId: "sc-guard" },
      { kind: "button-approve" },
    );

    expect(mockResumeAgent).not.toHaveBeenCalled();
    expect(session.runningAgent).toBeNull();
    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("❌"))).toBe(true);
  });

  it("passes planText to resumeAgent when planText is present on button-approve", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-has-plan-approve", 1);
    const plan = "Step 1: write foo.ts\nStep 2: edit bar.ts";
    session.runningAgent = {
      kind: "refine",
      state: "awaiting-button",
      cursor: 0,
      initiatorId: "user-test",
      startedAt: Date.now(),
      planText: plan,
    };
    session.mode = "plan";

    mockResumeAgent.mockResolvedValueOnce({
      paused: false,
      truncated: false,
      hadToolError: false,
      text: "all done",
      iterations: 2,
      messages: [],
    });

    await resumeFeature(
      { session, channel, initiatorId: "user-test", scopeId: "sc-plan" },
      { kind: "button-approve" },
    );

    expect(mockResumeAgent).toHaveBeenCalledOnce();
    const callArgs = mockResumeAgent.mock.calls[0]![0] as {
      next: { kind: string; planText?: string };
    };
    expect(callArgs.next.kind).toBe("button-approve");
    expect(callArgs.next.planText).toBe(plan);
  });
});
