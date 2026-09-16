import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetAllSessionsForTesting,
  attachActiveFeature,
  extractLatestTodoList,
  getOrCreateSession,
  recordTurn,
} from "../services/sessions";
import type { ActiveFeature } from "../types";

function feature(): ActiveFeature {
  return {
    branch: "onyx/x-1",
    prNumber: 1,
    title: "feat: x",
    paths: new Set<string>(),
    turns: [],
    createdAt: 0,
  };
}

beforeEach(() => {
  _resetAllSessionsForTesting();
});

describe("extractLatestTodoList()", () => {
  it("returns null when no feature is attached", () => {
    const s = getOrCreateSession("c", 1);
    expect(extractLatestTodoList(s)).toBeNull();
  });

  it("returns null when no TodoWrite turn exists", () => {
    const s = getOrCreateSession("c", 1);
    attachActiveFeature(s, feature());
    recordTurn(s, {
      kind: "create",
      paths: ["a.ts"],
      prompt: "hi",
      summary: null,
      timestamp: 1,
    });
    expect(extractLatestTodoList(s)).toBeNull();
  });

  it("returns the most recent TodoWrite snapshot", () => {
    const s = getOrCreateSession("c", 1);
    attachActiveFeature(s, feature());
    recordTurn(s, {
      kind: "tool",
      paths: [],
      prompt: `TodoWrite:${JSON.stringify([{ content: "old", status: "completed" }])}`,
      summary: null,
      timestamp: 1,
    });
    recordTurn(s, {
      kind: "tool",
      paths: [],
      prompt: `TodoWrite:${JSON.stringify([
        { content: "first", status: "in_progress" },
        { content: "second", status: "pending" },
      ])}`,
      summary: null,
      timestamp: 2,
    });
    const out = extractLatestTodoList(s);
    expect(out).toEqual([
      { content: "first", status: "in_progress" },
      { content: "second", status: "pending" },
    ]);
  });

  it("returns null on a malformed TodoWrite payload", () => {
    const s = getOrCreateSession("c", 1);
    attachActiveFeature(s, feature());
    recordTurn(s, {
      kind: "tool",
      paths: [],
      prompt: "TodoWrite:{not json",
      summary: null,
      timestamp: 1,
    });
    expect(extractLatestTodoList(s)).toBeNull();
  });
});
