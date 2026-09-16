import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetAllSessionsForTesting,
  clearRunningAgent,
  getOrCreateSession,
  isBusy,
  setRunningAgent,
} from "../services/sessions";

beforeEach(() => {
  _resetAllSessionsForTesting();
});

describe("setRunningAgent / clearRunningAgent / isBusy", () => {
  it("isBusy returns false on a fresh session", () => {
    const s = getOrCreateSession("c", 1);
    expect(isBusy(s)).toBe(false);
  });

  it("entering plan mode stashes prePlanMode and flips mode", () => {
    const s = getOrCreateSession("c", 1);
    expect(s.mode).toBe("pr");
    setRunningAgent(
      s,
      {
        kind: "feature",
        state: "awaiting-user-text",
        cursor: 0,
        initiatorId: "user-1",
        startedAt: 1,
      },
      "plan",
    );
    expect(s.mode).toBe("plan");
    expect(s.prePlanMode).toBe("pr");
    expect(isBusy(s)).toBe(true);
  });

  it("clearRunningAgent restores prePlanMode when in plan mode", () => {
    const s = getOrCreateSession("c", 1);
    setRunningAgent(
      s,
      {
        kind: "feature",
        state: "awaiting-button",
        cursor: 0,
        initiatorId: "user-1",
        startedAt: 1,
      },
      "plan",
    );
    clearRunningAgent(s);
    expect(s.runningAgent).toBeNull();
    expect(s.mode).toBe("pr");
    expect(s.prePlanMode).toBeUndefined();
    expect(isBusy(s)).toBe(false);
  });

  it("clearRunningAgent leaves mode alone when not in plan mode", () => {
    const s = getOrCreateSession("c", 1);
    setRunningAgent(
      s,
      {
        kind: "feature",
        state: "awaiting-user-text",
        cursor: 0,
        initiatorId: "user-1",
        startedAt: 1,
      },
      "pr",
    );
    expect(s.mode).toBe("pr");
    clearRunningAgent(s);
    expect(s.mode).toBe("pr");
  });
});
