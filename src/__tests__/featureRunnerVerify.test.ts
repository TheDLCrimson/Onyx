import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveFeature, Turn } from "../types";
import type { SendableChannels } from "discord.js";
import type { TodoItem } from "../services/sessions";
import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";

vi.mock("../services/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm")>();
  return {
    ...actual,
    verifyPlan: vi.fn(async () => ({ verdict: "match", notes: "ok" })),
  };
});

const mockClient = {
  getPullRequestBody: vi.fn(async () => "## Summary\n- existing"),
  updatePullRequest: vi.fn(async () => undefined),
};

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => mockClient),
}));

import {
  getLatestTodoListSince,
  postClarificationPause,
  runVerification,
  hasInformativeDiffSummary,
} from "../runtime/featureRunner";
import { verifyPlan } from "../services/llm";

function makeTurn(overrides: Partial<Turn>): Turn {
  return {
    kind: "create",
    paths: ["src/foo.ts"],
    prompt: "create foo",
    summary: "- created foo",
    timestamp: 1000,
    ...overrides,
  };
}

function makeActive(turns: Turn[]): ActiveFeature {
  return {
    branch: "onyx/feat-1",
    prNumber: 99,
    title: "test feature",
    paths: new Set(turns.flatMap((t) => t.paths)),
    turns,
    createdAt: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runVerification", () => {
  it("calls verifyPlan with plan + diff summary, then updates the PR body", async () => {
    const active = makeActive([
      makeTurn({ kind: "create", paths: ["a.ts"], summary: "- new file a" }),
      makeTurn({ kind: "edit", paths: ["b.ts"], summary: "- tweaked b" }),
    ]);
    await runVerification({ planText: "PLAN-TEXT", active, prNumber: 99, channelId: "ch-1" });
    expect(verifyPlan).toHaveBeenCalledOnce();
    const arg = vi.mocked(verifyPlan).mock.calls[0][0];
    expect(arg.planText).toBe("PLAN-TEXT");
    expect(arg.diffSummary).toContain("[create] a.ts");
    expect(arg.diffSummary).toContain("[edit] b.ts");
    expect(mockClient.getPullRequestBody).toHaveBeenCalledWith(99);
    expect(mockClient.updatePullRequest).toHaveBeenCalledOnce();
    const [, newBody] = mockClient.updatePullRequest.mock.calls[0] as unknown as [number, string];
    expect(newBody).toContain("## Verification");
    expect(newBody).toContain("✅ Match");
    expect(newBody).toContain("## Summary"); // existing content preserved
  });

  it("skips verification when there are no write turns at all", async () => {
    const active = makeActive([
      makeTurn({ kind: "tool" as Turn["kind"], paths: [], summary: null }),
    ]);
    await runVerification({ planText: "PLAN", active, prNumber: 99, channelId: "ch-1" });
    expect(verifyPlan).not.toHaveBeenCalled();
    expect(mockClient.updatePullRequest).not.toHaveBeenCalled();
  });

  it("includes write turns regardless of their timestamp (full PR diff)", async () => {
    const active = makeActive([
      makeTurn({ kind: "create", paths: ["old.ts"], timestamp: 1, summary: "- old file" }),
      makeTurn({ kind: "edit", paths: ["new.ts"], timestamp: 9999, summary: "- new edit" }),
    ]);
    await runVerification({ planText: "PLAN", active, prNumber: 99, channelId: "ch-1" });
    const arg = vi.mocked(verifyPlan).mock.calls[0][0];
    expect(arg.diffSummary).toContain("[create] old.ts");
    expect(arg.diffSummary).toContain("[edit] new.ts");
  });

  it("swallows verifier errors without throwing", async () => {
    vi.mocked(verifyPlan).mockRejectedValueOnce(new Error("boom"));
    const active = makeActive([makeTurn({})]);
    await expect(
      runVerification({ planText: "PLAN", active, prNumber: 99, channelId: "ch-1" }),
    ).resolves.toBeUndefined();
    expect(mockClient.updatePullRequest).not.toHaveBeenCalled();
  });

  it("swallows PR-update errors without throwing", async () => {
    mockClient.updatePullRequest.mockRejectedValueOnce(new Error("api 500"));
    const active = makeActive([makeTurn({})]);
    await expect(
      runVerification({ planText: "PLAN", active, prNumber: 99, channelId: "ch-1" }),
    ).resolves.toBeUndefined();
  });

  it("includes only write turns (create/edit/delete) in diffSummary", async () => {
    const active = makeActive([
      makeTurn({ kind: "create", paths: ["a.ts"], summary: "- a" }),
      makeTurn({
        kind: "tool" as Turn["kind"],
        paths: [],
        summary: null,
        prompt: "TodoWrite:[]",
      }),
      makeTurn({ kind: "delete", paths: ["c.ts"], summary: "- removed c" }),
    ]);
    await runVerification({ planText: "PLAN", active, prNumber: 99, channelId: "ch-1" });
    const arg = vi.mocked(verifyPlan).mock.calls[0][0];
    expect(arg.diffSummary).toContain("[create] a.ts");
    expect(arg.diffSummary).toContain("[delete] c.ts");
    expect(arg.diffSummary).not.toContain("TodoWrite");
  });
});

describe("getLatestTodoListSince", () => {
  function makeTodoTurn(items: TodoItem[], ts: number): Turn {
    return makeTurn({
      kind: "tool" as Turn["kind"],
      paths: [],
      summary: null,
      prompt: `TodoWrite:${JSON.stringify(items)}`,
      timestamp: ts,
    });
  }

  it("returns null when no TodoWrite turns exist after sinceMs", () => {
    const turns: Turn[] = [makeTodoTurn([{ content: "step", status: "completed" }], 100)];
    expect(getLatestTodoListSince(turns, 200)).toBeNull();
  });

  it("returns the latest snapshot after sinceMs", () => {
    const turns: Turn[] = [
      makeTodoTurn([{ content: "old", status: "pending" }], 100),
      makeTodoTurn([{ content: "new", status: "completed" }], 300),
    ];
    const result = getLatestTodoListSince(turns, 200);
    expect(result).toEqual([{ content: "new", status: "completed" }]);
  });

  it("returns null when turns array is empty", () => {
    expect(getLatestTodoListSince([], 0)).toBeNull();
  });

  it("returns snapshot when sinceMs is 0 (include all turns)", () => {
    const turns: Turn[] = [makeTodoTurn([{ content: "a", status: "in_progress" }], 50)];
    expect(getLatestTodoListSince(turns, 0)).toEqual([{ content: "a", status: "in_progress" }]);
  });
});

describe("postClarificationPause", () => {
  beforeEach(() => {
    _resetAllSessionsForTesting();
  });

  it("sends model text first, then a reply-hint message with Cancel button", async () => {
    const send = vi.fn(async () => ({}));
    const channel = { send } as unknown as SendableChannels;
    const session = getOrCreateSession("ch-clar", 1);

    await postClarificationPause(
      { channel, session, scopeId: "scope-x", initiatorId: "user-1" },
      "Which approach do you prefer?",
    );

    // At least 2 sends: model text + footer/button message.
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First send is the model text (plain string via sendLong).
    const firstArg = (send.mock.calls[0] as unknown as [string])[0];
    expect(typeof firstArg).toBe("string");
    expect(firstArg).toContain("Which approach do you prefer?");
    // Last send is the footer with the Cancel button.
    const lastArg = (
      send.mock.calls.at(-1) as unknown as [{ content: string; components: unknown[] }]
    )[0];
    expect(typeof lastArg).toBe("object");
    expect(lastArg.content).toContain("Reply in this channel");
    expect(lastArg.components).toHaveLength(1);
  });

  it("chunks long clarification text, all text chunks before the button message", async () => {
    const send = vi.fn(async () => ({}));
    const channel = { send } as unknown as SendableChannels;
    const session = getOrCreateSession("ch-clar-long", 1);
    // 1950 chars → 2 text chunks from sendLong, then 1 button message = 3 sends total.
    const longText = "Q".repeat(1950);

    await postClarificationPause(
      { channel, session, scopeId: "scope-y", initiatorId: "user-1" },
      longText,
    );

    // 3 sends: chunk1, "↪️ " + chunk2, then footer+button.
    expect(send.mock.calls.length).toBe(3);
    // All text sends are plain strings.
    expect(typeof (send.mock.calls[0] as unknown as [unknown])[0]).toBe("string");
    // Second text chunk carries the continuation prefix.
    expect((send.mock.calls[1] as unknown as [string])[0]).toContain("↪️");
    // Final send is the footer/button object.
    const lastArg = (
      send.mock.calls.at(-1) as unknown as [{ content: string; components: unknown[] }]
    )[0];
    expect(typeof lastArg).toBe("object");
    expect(lastArg.components).toHaveLength(1);
    expect(lastArg.content).toContain("Reply in this channel");
  });
});

describe("hasInformativeDiffSummary()", () => {
  it("rejects a summary made only of placeholders", () => {
    expect(
      hasInformativeDiffSummary(
        "[edit] src/a.ts\n(no summary)\n\n[create] src/b.ts\n(summary unavailable)",
      ),
    ).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(hasInformativeDiffSummary("")).toBe(false);
    expect(hasInformativeDiffSummary("   \n  ")).toBe(false);
  });

  it("accepts a summary with real content", () => {
    expect(hasInformativeDiffSummary("[edit] src/a.ts\n- Added a /ready route")).toBe(true);
  });

  it("accepts a mix where at least one turn was summarised", () => {
    expect(
      hasInformativeDiffSummary("[edit] src/a.ts\n(no summary)\n\n[edit] src/b.ts\n- Real change"),
    ).toBe(true);
  });
});
