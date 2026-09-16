import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetAllSessionsForTesting,
  attachActiveFeature,
  contextWindowMs,
  dropSession,
  endActiveFeature,
  formatHistory,
  getOrCreateSession,
  getRecentTurns,
  MAX_TURNS,
  recordTurn,
  sessionTimeoutMs,
  summarizeRecentProgress,
} from "../services/sessions";
import type { ActiveFeature, Turn } from "../types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeFeature(overrides: Partial<ActiveFeature> = {}): ActiveFeature {
  return {
    branch: "onyx/create-x-1",
    prNumber: 7,
    title: "create: x.ts",
    paths: new Set<string>(),
    turns: [],
    createdAt: 1_000,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    kind: "create",
    paths: ["x.ts"],
    prompt: "make x",
    summary: null,
    timestamp: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  _resetAllSessionsForTesting();
});

afterEach(() => {
  delete process.env.ONYX_SESSION_TIMEOUT_DAYS;
  delete process.env.ONYX_CONTEXT_WINDOW_MINUTES;
});

describe("sessionTimeoutMs() / contextWindowMs()", () => {
  it("defaults to 7 days and 60 minutes", () => {
    expect(sessionTimeoutMs()).toBe(7 * DAY);
    expect(contextWindowMs()).toBe(60 * 60_000);
  });

  it("honors env-var overrides", () => {
    process.env.ONYX_SESSION_TIMEOUT_DAYS = "2";
    process.env.ONYX_CONTEXT_WINDOW_MINUTES = "15";
    expect(sessionTimeoutMs()).toBe(2 * DAY);
    expect(contextWindowMs()).toBe(15 * 60_000);
  });

  it("falls back to defaults on garbage env values", () => {
    process.env.ONYX_SESSION_TIMEOUT_DAYS = "not-a-number";
    process.env.ONYX_CONTEXT_WINDOW_MINUTES = "0";
    expect(sessionTimeoutMs()).toBe(7 * DAY);
    expect(contextWindowMs()).toBe(60 * 60_000);
  });
});

describe("getOrCreateSession()", () => {
  it("returns the same instance for the same channelId", () => {
    const a = getOrCreateSession("chan-1", 1_000);
    const b = getOrCreateSession("chan-1", 2_000);
    expect(b).toBe(a);
    expect(b.lastUsedAt).toBe(2_000);
  });

  it("isolates sessions across channels", () => {
    const a = getOrCreateSession("chan-1", 1_000);
    const b = getOrCreateSession("chan-2", 1_000);
    expect(a).not.toBe(b);
    expect(a.channelId).toBe("chan-1");
    expect(b.channelId).toBe("chan-2");
  });

  it("evicts sessions whose lastUsedAt is older than the active-feature lifetime", () => {
    const original = getOrCreateSession("chan-1", 0);
    original.active = makeFeature();
    const fresh = getOrCreateSession("chan-1", 8 * DAY);
    expect(fresh).not.toBe(original);
    expect(fresh.active).toBeNull();
  });

  it("does not evict when lastUsedAt is within the lifetime", () => {
    const original = getOrCreateSession("chan-1", 0);
    const same = getOrCreateSession("chan-1", 6 * DAY);
    expect(same).toBe(original);
  });

  it("seeds new sessions with mode='pr' and no active feature", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    expect(s.mode).toBe("pr");
    expect(s.active).toBeNull();
    expect(s.lastUsedAt).toBe(1_000);
    expect(s.lastTurnAt).toBe(1_000);
  });
});

describe("attachActiveFeature() / endActiveFeature()", () => {
  it("attaches a feature and updates lastUsedAt", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    const f = makeFeature({ createdAt: 5_000 });
    attachActiveFeature(s, f);
    expect(s.active).toBe(f);
    expect(s.lastUsedAt).toBe(5_000);
  });

  it("endActiveFeature clears active without touching session presence", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    endActiveFeature(s);
    expect(s.active).toBeNull();
    expect(getOrCreateSession("chan-1", 1_000)).toBe(s);
  });
});

describe("recordTurn()", () => {
  it("appends to active.turns and updates lastTurnAt + lastUsedAt", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    recordTurn(s, makeTurn({ timestamp: 4_000 }));
    expect(s.active!.turns).toHaveLength(1);
    expect(s.lastTurnAt).toBe(4_000);
    expect(s.lastUsedAt).toBe(4_000);
  });

  it("threads paths into active.paths set", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    recordTurn(s, makeTurn({ paths: ["a.ts"] }));
    recordTurn(s, makeTurn({ paths: ["b.ts", "a.ts"] }));
    expect([...s.active!.paths].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("caps active.turns at MAX_TURNS (FIFO)", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    for (let n = 0; n < MAX_TURNS + 5; n++) {
      recordTurn(s, makeTurn({ prompt: `t${n}`, timestamp: 1_000 + n }));
    }
    expect(s.active!.turns).toHaveLength(MAX_TURNS);
    expect(s.active!.turns[0].prompt).toBe("t5");
    expect(s.active!.turns[MAX_TURNS - 1].prompt).toBe(`t${MAX_TURNS + 4}`);
  });

  it("still updates lastTurnAt when no feature is attached (e.g. solo /ask)", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    recordTurn(s, makeTurn({ kind: "ask", timestamp: 9_000 }));
    expect(s.active).toBeNull();
    expect(s.lastTurnAt).toBe(9_000);
    expect(s.lastUsedAt).toBe(9_000);
  });
});

describe("getRecentTurns()", () => {
  it("filters to turns within the 1h rolling window", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    const now = 100 * HOUR;
    recordTurn(s, makeTurn({ prompt: "stale", timestamp: now - 2 * HOUR }));
    recordTurn(s, makeTurn({ prompt: "edge", timestamp: now - HOUR + 1 }));
    recordTurn(s, makeTurn({ prompt: "fresh", timestamp: now - 5 * 60_000 }));
    const recent = getRecentTurns(s, now);
    expect(recent.map((t) => t.prompt)).toEqual(["edge", "fresh"]);
  });

  it("returns [] when no feature is attached", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    expect(getRecentTurns(s, 1_000)).toEqual([]);
  });
});

describe("formatHistory()", () => {
  it("returns '' for an empty turn list", () => {
    expect(formatHistory([])).toBe("");
  });

  it("renders one labeled bullet per turn", () => {
    const out = formatHistory([
      makeTurn({ kind: "create", paths: ["a.ts"], prompt: "new file" }),
      makeTurn({ kind: "ask", paths: ["a.ts"], prompt: "what does it do?" }),
    ]);
    expect(out).toContain("[create] a.ts: new file");
    expect(out).toContain("[ask] a.ts: what does it do?");
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("summarizeRecentProgress()", () => {
  it("returns an empty summary when no feature is attached", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    const out = summarizeRecentProgress(s, 0);
    expect(out.created).toEqual([]);
    expect(out.edited).toEqual([]);
    expect(out.deleted).toEqual([]);
    expect(out.todos).toBeNull();
  });

  it("buckets create / edit / delete turns since `sinceMs`", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    // Stale turns — before sinceMs — should be ignored.
    recordTurn(s, makeTurn({ kind: "create", paths: ["old.ts"], timestamp: 500 }));
    // Fresh turns — counted.
    recordTurn(s, makeTurn({ kind: "create", paths: ["a.ts"], timestamp: 2_000 }));
    recordTurn(s, makeTurn({ kind: "create", paths: ["b.ts"], timestamp: 3_000 }));
    recordTurn(s, makeTurn({ kind: "edit", paths: ["b.ts"], timestamp: 4_000 }));
    recordTurn(s, makeTurn({ kind: "delete", paths: ["old2.ts"], timestamp: 5_000 }));
    const out = summarizeRecentProgress(s, 1_000);
    expect(out.created).toEqual(["a.ts", "b.ts"]);
    expect(out.edited).toEqual(["b.ts"]);
    expect(out.deleted).toEqual(["old2.ts"]);
  });

  it("surfaces the latest TodoWrite snapshot when available", () => {
    const s = getOrCreateSession("chan-1", 1_000);
    attachActiveFeature(s, makeFeature());
    recordTurn(
      s,
      makeTurn({
        kind: "tool",
        paths: [],
        prompt: `TodoWrite: ${JSON.stringify([
          { content: "step 1", status: "completed" },
          { content: "step 2", status: "pending" },
        ])}`,
        timestamp: 2_000,
      }),
    );
    const out = summarizeRecentProgress(s, 0);
    expect(out.todos).toHaveLength(2);
    expect(out.todos?.[1].status).toBe("pending");
  });
});

describe("dropSession()", () => {
  it("returns true when a session existed, false otherwise", () => {
    getOrCreateSession("chan-1", 1_000);
    expect(dropSession("chan-1")).toBe(true);
    expect(dropSession("chan-1")).toBe(false);
  });

  it("the next getOrCreate after a drop is a fresh session", () => {
    const a = getOrCreateSession("chan-1", 1_000);
    a.active = makeFeature();
    dropSession("chan-1");
    const b = getOrCreateSession("chan-1", 2_000);
    expect(b).not.toBe(a);
    expect(b.active).toBeNull();
  });
});
