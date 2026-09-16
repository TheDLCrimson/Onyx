import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";

// Hoist mock fn references so the vi.mock factory can close over them.
const { mockWriteFileSync, mockReadFileSync, mockExistsSync, mockRenameSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockWriteFileSync: vi.fn(),
    mockReadFileSync: vi.fn(() => "{}"),
    mockExistsSync: vi.fn(() => false),
    mockRenameSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

// Prevent actual disk I/O.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const mocks = {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    mkdirSync: mockMkdirSync,
  };
  return {
    ...actual,
    ...mocks,
    default: mocks, // CJS default-export compatibility for `import fs from "fs"`
  };
});

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return { ...actual, chatCompletion: vi.fn() };
});

import { chatCompletion } from "../services/llm";
import { runAgent } from "../services/agent";
import type { Tool, ToolContext } from "../services/tools";
import {
  _resetAllSessionsForTesting,
  flushSessionsToDisk,
  getChannelsNeedingRestore,
  getOrCreateSession,
  loadPersistedSessions,
  resumeWindowMs,
  setRunningAgent,
} from "../services/sessions";
import type { RunningAgent } from "../types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeAgent(overrides: Partial<RunningAgent> = {}): RunningAgent {
  return {
    kind: "feature",
    state: "awaiting-button",
    cursor: 0,
    initiatorId: "user-1",
    startedAt: Date.now(),
    ...overrides,
  };
}

/** Capture the JSON string written to the .tmp file by saveSessions(). */
function captureLastWrite(): string {
  const calls = mockWriteFileSync.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("No writeFileSync call found");
  return last[1] as string;
}

function textOnlyCompletion(text: string): ChatCompletion {
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

function toolCallCompletion(name: string): ChatCompletion {
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
          content: "",
          refusal: null,
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name, arguments: "{}" },
            },
          ],
        },
      },
    ],
  } as unknown as ChatCompletion;
}

function noopTool(name: string): Tool {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    isDestructive: false,
    execute: vi.fn().mockResolvedValue("ok"),
  };
}

const PR_CTX: ToolContext = { mode: "pr" };

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

beforeEach(() => {
  _resetAllSessionsForTesting();
  mockWriteFileSync.mockClear();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue("{}");
});

afterEach(() => {
  delete process.env.ONYX_RESUME_WINDOW_MINUTES;
});

// --------------------------------------------------------------------------
// resumeWindowMs()
// --------------------------------------------------------------------------

describe("resumeWindowMs()", () => {
  it("defaults to 60 minutes", () => {
    expect(resumeWindowMs()).toBe(60 * MINUTE);
  });

  it("honors ONYX_RESUME_WINDOW_MINUTES override", () => {
    process.env.ONYX_RESUME_WINDOW_MINUTES = "30";
    expect(resumeWindowMs()).toBe(30 * MINUTE);
  });

  it("falls back to default on garbage value", () => {
    process.env.ONYX_RESUME_WINDOW_MINUTES = "not-a-number";
    expect(resumeWindowMs()).toBe(60 * MINUTE);
  });

  it("falls back to default on zero", () => {
    process.env.ONYX_RESUME_WINDOW_MINUTES = "0";
    expect(resumeWindowMs()).toBe(60 * MINUTE);
  });
});

// --------------------------------------------------------------------------
// flushSessionsToDisk() — serialisation of runningAgent + messages
// --------------------------------------------------------------------------

describe("flushSessionsToDisk() — serialisation", () => {
  it("includes runningAgent in persisted JSON when set", () => {
    const session = getOrCreateSession("ch-1");
    setRunningAgent(session, makeAgent({ planText: "step 1\nstep 2" }), "pr");

    mockWriteFileSync.mockClear();
    flushSessionsToDisk();
    const json = JSON.parse(captureLastWrite());
    expect(json["ch-1"].runningAgent).toMatchObject({
      kind: "feature",
      state: "awaiting-button",
      planText: "step 1\nstep 2",
    });
  });

  it("includes messages in persisted JSON when present", () => {
    const session = getOrCreateSession("ch-1");
    session.messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    setRunningAgent(session, makeAgent(), "pr");

    mockWriteFileSync.mockClear();
    flushSessionsToDisk();
    const json = JSON.parse(captureLastWrite());
    expect(json["ch-1"].messages).toHaveLength(2);
    expect(json["ch-1"].messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("omits messages key when session has no messages", () => {
    const session = getOrCreateSession("ch-2");
    setRunningAgent(session, makeAgent(), "pr");

    mockWriteFileSync.mockClear();
    flushSessionsToDisk();
    const json = JSON.parse(captureLastWrite());
    expect(json["ch-2"].messages).toBeUndefined();
  });

  it("omits runningAgent key when null", () => {
    getOrCreateSession("ch-3");
    mockWriteFileSync.mockClear();
    flushSessionsToDisk();
    const json = JSON.parse(captureLastWrite());
    expect(json["ch-3"].runningAgent).toBeUndefined();
  });

  it("uses tmpfile+rename atomic pattern", () => {
    getOrCreateSession("ch-1");
    mockWriteFileSync.mockClear();
    mockRenameSync.mockClear();
    flushSessionsToDisk();
    const writeCalls = mockWriteFileSync.mock.calls;
    const renameCalls = mockRenameSync.mock.calls;
    // Write goes to a .tmp path
    const tmpPath = writeCalls[writeCalls.length - 1]?.[0] as string;
    expect(tmpPath).toMatch(/\.tmp$/);
    // Then renames from .tmp to canonical path
    const [fromPath, toPath] = renameCalls[renameCalls.length - 1] ?? [];
    expect(fromPath).toMatch(/\.tmp$/);
    expect(toPath as string).toMatch(/sessions\.json$/);
  });
});

// --------------------------------------------------------------------------
// loadPersistedSessions() — restoration
// --------------------------------------------------------------------------

describe("loadPersistedSessions() — restoration", () => {
  function setupLoad(json: object): void {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(json));
  }

  it("restores runningAgent and messages when within resume window", () => {
    const now = Date.now();
    const agent = makeAgent({ startedAt: now - 5 * MINUTE });
    setupLoad({
      "ch-1": {
        channelId: "ch-1",
        mode: "pr",
        lastUsedAt: now,
        lastTurnAt: now,
        active: null,
        runningAgent: agent,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    loadPersistedSessions();
    const session = getOrCreateSession("ch-1");
    expect(session.runningAgent).not.toBeNull();
    expect(session.runningAgent?.kind).toBe("feature");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("drops runningAgent and messages when outside resume window", () => {
    const now = Date.now();
    const agent = makeAgent({ startedAt: now - 2 * HOUR }); // 2h ago, default window 1h
    setupLoad({
      "ch-1": {
        channelId: "ch-1",
        mode: "pr",
        lastUsedAt: now,
        lastTurnAt: now,
        active: null,
        runningAgent: agent,
        messages: [{ role: "user", content: "lost" }],
      },
    });

    loadPersistedSessions();
    const session = getOrCreateSession("ch-1");
    expect(session.runningAgent).toBeNull();
    expect(session.messages).toHaveLength(0);
  });

  it("restores when startedAt is exactly at the window boundary", () => {
    process.env.ONYX_RESUME_WINDOW_MINUTES = "60";
    const now = Date.now();
    // Pin the clock: loadPersistedSessions reads Date.now() itself, and a
    // single elapsed millisecond would push the agent outside the window.
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const agent = makeAgent({ startedAt: now - 60 * MINUTE });
      setupLoad({
        "ch-1": {
          channelId: "ch-1",
          mode: "pr",
          lastUsedAt: now,
          lastTurnAt: now,
          active: null,
          runningAgent: agent,
          messages: [],
        },
      });

      loadPersistedSessions();
      const session = getOrCreateSession("ch-1");
      expect(session.runningAgent).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("honours custom ONYX_RESUME_WINDOW_MINUTES when dropping expired agents", () => {
    process.env.ONYX_RESUME_WINDOW_MINUTES = "10"; // 10-minute window
    const now = Date.now();
    const agent = makeAgent({ startedAt: now - 20 * MINUTE }); // 20 min ago → expired
    setupLoad({
      "ch-1": {
        channelId: "ch-1",
        mode: "pr",
        lastUsedAt: now,
        lastTurnAt: now,
        active: null,
        runningAgent: agent,
        messages: [{ role: "user", content: "lost" }],
      },
    });

    loadPersistedSessions();
    const session = getOrCreateSession("ch-1");
    expect(session.runningAgent).toBeNull();
    expect(session.messages).toHaveLength(0);
  });

  it("is backwards-compatible with v1 schema (no runningAgent or messages fields)", () => {
    const now = Date.now();
    setupLoad({
      "ch-old": {
        channelId: "ch-old",
        mode: "pr",
        lastUsedAt: now,
        lastTurnAt: now,
        active: null,
        // no runningAgent, no messages (v1 schema)
      },
    });

    expect(() => loadPersistedSessions()).not.toThrow();
    const session = getOrCreateSession("ch-old");
    expect(session.runningAgent).toBeNull();
    expect(session.messages).toHaveLength(0);
  });

  it("does not restore messages when runningAgent is absent", () => {
    const now = Date.now();
    setupLoad({
      "ch-1": {
        channelId: "ch-1",
        mode: "pr",
        lastUsedAt: now,
        lastTurnAt: now,
        active: null,
        // messages present but no runningAgent — messages should not be loaded
        messages: [{ role: "user", content: "orphan" }],
      },
    });

    loadPersistedSessions();
    const session = getOrCreateSession("ch-1");
    expect(session.messages).toHaveLength(0);
  });

  it("loads cleanly when the file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadPersistedSessions()).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// getChannelsNeedingRestore()
// --------------------------------------------------------------------------

describe("getChannelsNeedingRestore()", () => {
  it("returns empty array when no sessions have a runningAgent", () => {
    getOrCreateSession("ch-1");
    getOrCreateSession("ch-2");
    expect(getChannelsNeedingRestore()).toEqual([]);
  });

  it("returns only channelIds with a non-null runningAgent", () => {
    const s1 = getOrCreateSession("ch-1");
    getOrCreateSession("ch-2");
    setRunningAgent(s1, makeAgent(), "pr");

    const ids = getChannelsNeedingRestore();
    expect(ids).toContain("ch-1");
    expect(ids).not.toContain("ch-2");
  });

  it("reflects cleared agents", () => {
    const s1 = getOrCreateSession("ch-1");
    setRunningAgent(s1, makeAgent(), "pr");
    expect(getChannelsNeedingRestore()).toContain("ch-1");

    s1.runningAgent = null;
    expect(getChannelsNeedingRestore()).not.toContain("ch-1");
  });
});

// --------------------------------------------------------------------------
// onIteration callback in the agent loop
// --------------------------------------------------------------------------

describe("runAgent() — onIteration callback", () => {
  it("is called once per iteration that has tool calls", async () => {
    const tool = noopTool("DoStuff");
    const onIteration = vi.fn();

    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("DoStuff"))
      .mockResolvedValueOnce(toolCallCompletion("DoStuff"))
      .mockResolvedValueOnce(textOnlyCompletion("done"));

    await runAgent({
      system: "system",
      user: "go",
      tools: [tool],
      ctx: PR_CTX,
      onIteration,
    });

    // Two tool-call iterations → callback fires twice (not on the final text-only pass)
    expect(onIteration).toHaveBeenCalledTimes(2);
  });

  it("receives the full accumulated messages array each time", async () => {
    const tool = noopTool("Ping");
    const captured: number[] = [];

    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Ping"))
      .mockResolvedValueOnce(textOnlyCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PR_CTX,
      onIteration: (msgs) => captured.push(msgs.length),
    });

    // After iteration 1: system + user + assistant(tool_call) + tool_result = 4
    expect(captured[0]).toBe(4);
  });

  it("is not called when agent completes without any tool calls", async () => {
    const onIteration = vi.fn();
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnlyCompletion("answer"));

    await runAgent({
      system: "sys",
      user: "question",
      tools: [],
      ctx: PR_CTX,
      onIteration,
    });

    expect(onIteration).not.toHaveBeenCalled();
  });

  it("is not called when undefined (no crash)", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnlyCompletion("ok"));
    await expect(
      runAgent({ system: "s", user: "u", tools: [], ctx: PR_CTX }),
    ).resolves.not.toThrow();
  });
});
