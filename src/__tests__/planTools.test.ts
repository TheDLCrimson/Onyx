import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlanTools } from "../services/planTools";
import {
  _resetAllSessionsForTesting,
  attachActiveFeature,
  extractLatestTodoList,
  getOrCreateSession,
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

describe("TodoWrite tool", () => {
  it("renders the snapshot via hooks and stashes it on the active feature", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, feature());
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg-1"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const todoWrite = tools.find((t) => t.name === "TodoWrite")!;

    const result = await todoWrite.execute(
      {
        items: [
          { content: "do x", status: "pending" },
          { content: "do y", status: "in_progress" },
        ],
      },
      { mode: "plan" },
    );

    expect(hooks.renderTodoList).toHaveBeenCalledOnce();
    expect(result).toContain("Todo list updated");
    expect(extractLatestTodoList(session)).toEqual([
      { content: "do x", status: "pending" },
      { content: "do y", status: "in_progress" },
    ]);
  });

  it("rejects malformed items", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, feature());
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg-1"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const todoWrite = tools.find((t) => t.name === "TodoWrite")!;

    await expect(
      todoWrite.execute(
        {
          items: [{ content: "no-status" }] as unknown as Record<string, unknown>[],
        },
        { mode: "plan" },
      ),
    ).rejects.toThrow(/status/);
  });
});

describe("RequestCheckpoint tool", () => {
  it("is present in the tool registry", () => {
    const session = getOrCreateSession("c", 1);
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const tool = tools.find((t) => t.name === "RequestCheckpoint");
    expect(tool).toBeDefined();
  });

  it("is marked isReadOnly and not isDestructive", () => {
    const session = getOrCreateSession("c", 1);
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const tool = tools.find((t) => t.name === "RequestCheckpoint")!;
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isDestructive).toBe(false);
    expect(tool.pauseAfter).toBeFalsy();
  });

  it("returns the armed confirmation message when executed", async () => {
    const session = getOrCreateSession("c", 1);
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const tool = tools.find((t) => t.name === "RequestCheckpoint")!;

    const result = await tool.execute({}, { mode: "pr" });
    expect(result).toContain("Checkpoint armed");
  });

  it("calling it twice returns the same message (tool is idempotent)", async () => {
    const session = getOrCreateSession("c", 1);
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "msg"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const tool = tools.find((t) => t.name === "RequestCheckpoint")!;

    const r1 = await tool.execute({}, { mode: "pr" });
    const r2 = await tool.execute({}, { mode: "pr" });
    expect(r1).toBe(r2);
  });
});

describe("ExitPlanMode tool", () => {
  it("posts the plan via hooks and returns the plan_text as result", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, feature());
    const hooks = {
      renderTodoList: vi.fn(async () => undefined),
      postPlanForApproval: vi.fn(async () => "plan-msg"),
    };
    const tools = buildPlanTools({ session, hooks, scopeId: "s1" });
    const exitPlan = tools.find((t) => t.name === "ExitPlanMode")!;
    expect(exitPlan.pauseAfter).toBe(true);

    const result = await exitPlan.execute({ plan_text: "1. step\n2. step" }, { mode: "plan" });

    expect(hooks.postPlanForApproval).toHaveBeenCalledWith("1. step\n2. step", "s1");
    expect(result).toBe("1. step\n2. step");
  });
});
