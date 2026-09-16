import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendableChannels } from "discord.js";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available inside vi.mock factory functions
// ---------------------------------------------------------------------------

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

// Mock commitChange so performAutoFlush doesn't hit GitHub.
const { mockCommitChange } = vi.hoisted(() => ({
  mockCommitChange: vi.fn(),
}));
vi.mock("../services/commitFlow", () => ({
  commitChange: mockCommitChange,
}));

// Build gate — always skip so clean-completion tests don't hang.
vi.mock("../services/buildGate", () => ({
  detectRepoKind: vi.fn(async () => "unknown"),
  runBuildGate: vi.fn(async () => ({
    success: true,
    skipped: true,
    kind: "unknown",
    errors: [],
    durationMs: 0,
  })),
  buildCommandLabel: (k: string) => `${k}-build`,
}));

vi.mock("../services/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm")>();
  return { ...actual, verifyPlan: vi.fn(async () => ({ verdict: "match", notes: "ok" })) };
});

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => ({
    getPullRequestBody: vi.fn(async () => "## Summary\n- existing"),
    updatePullRequest: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
    repoCoordinates: vi.fn(() => ({ owner: "o", repo: "r" })),
  })),
}));

// Prevent disk I/O from sessions.ts.
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetAllSessionsForTesting,
  attachActiveFeature,
  getOrCreateSession,
} from "../services/sessions";
import { resumeFeature, startFeature } from "../runtime/featureRunner";
import type { ActiveFeature, StagingEntry } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel() {
  const send = vi.fn(async () => ({ id: "msg-1" }));
  return { send } as unknown as SendableChannels;
}

function makeActive(overrides: Partial<ActiveFeature> = {}): ActiveFeature {
  return {
    branch: "onyx/feat-1",
    prNumber: 42,
    title: "test feature",
    paths: new Set<string>(),
    turns: [],
    createdAt: 0,
    ...overrides,
  };
}

function makeStagingEntry(path = "a.ts"): StagingEntry {
  return { kind: "create", path, content: "// x", prompt: `add ${path}` };
}

/** commitChange return value that looks like a real PR-mode outcome. */
const PR_OUTCOME = {
  mode: "pr" as const,
  pr: { url: "https://github.com/o/r/pull/42", number: 42, branch: "onyx/feat-1" },
  attached: true,
  summary: null,
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllSessionsForTesting();
  mockCommitChange.mockResolvedValue(PR_OUTCOME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// performAutoFlush — iteration cap (truncated) path
// ---------------------------------------------------------------------------

describe("performAutoFlush — iteration cap pause", () => {
  it("posts a warning and calls commitChange when stagingArea is non-empty", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-cap", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockImplementation(async () => {
      // Simulate the model having staged a file during the run.
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("a.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    expect(mockCommitChange).toHaveBeenCalledOnce();
    expect(mockCommitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "a.ts",
        commitMessage: expect.stringContaining("auto-committed"),
      }),
      session,
    );

    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("⚠️ Auto-committing"))).toBe(true);
    expect(sentTexts.some((t) => t.includes("a.ts"))).toBe(true);
  });

  it("does NOT post a warning when stagingArea is empty at iteration cap", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-cap-empty", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockResolvedValue({
      truncated: true,
      paused: false,
      hadToolError: false,
      text: "cap",
      iterations: 10,
      messages: [],
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    expect(mockCommitChange).not.toHaveBeenCalled();
    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("Auto-committing"))).toBe(false);
  });

  it("drains the staging area — all entries shifted out after successful flush", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-drain", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockImplementation(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("a.ts"), makeStagingEntry("b.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    expect(mockCommitChange).toHaveBeenCalledTimes(2);
    // After flush the staging area is empty.
    expect(session.runningAgent?.stagingArea ?? []).toHaveLength(0);
  });

  it("skips a failing entry and continues (inner error is swallowed)", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-err", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockImplementation(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("fail.ts"), makeStagingEntry("ok.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    // First entry fails; second succeeds.
    mockCommitChange
      .mockRejectedValueOnce(new Error("write access denied"))
      .mockResolvedValueOnce(PR_OUTCOME);

    // Should not throw — errors are swallowed by performAutoFlush.
    await expect(
      startFeature({ session, channel, initiatorId: "u", scopeId: "s", intent: "add feature" }),
    ).resolves.toBeUndefined();

    // Both entries processed (even the failing one is shifted out to avoid infinite loops).
    expect(mockCommitChange).toHaveBeenCalledTimes(2);
    expect(session.runningAgent?.stagingArea ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// performAutoFlush — clean completion path
// ---------------------------------------------------------------------------

describe("performAutoFlush — clean completion path", () => {
  it("calls commitChange when staging has entries at clean completion", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-clean", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockImplementation(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("c.ts")];
      }
      return {
        truncated: false,
        paused: false,
        hadToolError: false,
        text: "done",
        iterations: 3,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    expect(mockCommitChange).toHaveBeenCalledOnce();
    expect(mockCommitChange).toHaveBeenCalledWith(
      expect.objectContaining({ path: "c.ts" }),
      session,
    );
  });

  it("does not call commitChange on clean completion when staging is empty", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-flush-clean-empty", 1);
    attachActiveFeature(session, makeActive());

    mockRunAgent.mockResolvedValue({
      truncated: false,
      paused: false,
      hadToolError: false,
      text: "done",
      iterations: 2,
      messages: [],
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    expect(mockCommitChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// prAnnounced — prevent duplicate PR-link posts
// ---------------------------------------------------------------------------

describe("prAnnounced guard in performAutoFlush", () => {
  it("announces PR link when prAnnounced is false on first flush", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-pr-announce", 1);
    attachActiveFeature(session, makeActive({ prAnnounced: false }));

    mockRunAgent.mockImplementation(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("a.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("📎"))).toBe(true);
    expect(sentTexts.some((t) => t.includes("PR #42"))).toBe(true);
    // Flag is set so the next run won't re-announce.
    expect(session.active?.prAnnounced).toBe(true);
  });

  it("does NOT announce PR link when prAnnounced is already true", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-pr-no-reannounce", 1);
    attachActiveFeature(session, makeActive({ prAnnounced: true }));

    mockRunAgent.mockImplementation(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("b.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    const sentTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(sentTexts.some((t) => t.includes("📎"))).toBe(false);
    expect(sentTexts.some((t) => t.includes("PR #42"))).toBe(false);
  });

  it("prAnnounced survives between startFeature and resumeFeature — closure reset is fixed", async () => {
    const channel = makeChannel();
    const session = getOrCreateSession("ch-pr-survive", 1);
    attachActiveFeature(session, makeActive({ prAnnounced: false }));

    // First run: model stages a file; loop hits the iteration cap.
    mockRunAgent.mockImplementationOnce(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("a.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap",
        iterations: 10,
        messages: [],
      };
    });

    await startFeature({
      session,
      channel,
      initiatorId: "u",
      scopeId: "s",
      intent: "add feature",
    });

    // After the first run the PR link should have been posted and the flag set.
    expect(session.active?.prAnnounced).toBe(true);
    const firstRunTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(firstRunTexts.some((t) => t.includes("📎"))).toBe(true);

    // Clear call history so we can inspect only the second run's messages.
    (channel.send as ReturnType<typeof vi.fn>).mockClear();

    // Second run (resume after cap): model stages another file; cap fires again.
    mockResumeAgent.mockImplementationOnce(async () => {
      if (session.runningAgent) {
        session.runningAgent.stagingArea = [makeStagingEntry("b.ts")];
      }
      return {
        truncated: true,
        paused: false,
        hadToolError: false,
        text: "cap2",
        iterations: 10,
        messages: [],
      };
    });

    await resumeFeature(
      { session, channel, initiatorId: "u", scopeId: "s" },
      { kind: "button-continue" },
    );

    const secondRunTexts = (channel.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    // PR link must NOT be re-announced — prAnnounced=true survived the resume call.
    expect(secondRunTexts.some((t) => t.includes("📎"))).toBe(false);
    expect(secondRunTexts.some((t) => t.includes("PR #42"))).toBe(false);
    // But the auto-commit warning and commit itself did happen.
    expect(mockCommitChange).toHaveBeenCalledTimes(2); // once per run
  });
});
