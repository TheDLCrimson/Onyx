import { describe, expect, it, vi } from "vitest";
import { dispatchTool, TOOL_RESULT_MAX_CHARS, toolsForOpenAI } from "../services/tools";
import type { Tool, ToolContext } from "../services/tools";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "Echo",
    description: "echo back the `value` arg",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    isReadOnly: true,
    isDestructive: false,
    execute: vi
      .fn()
      .mockImplementation(async (args: Record<string, unknown>) => String(args.value)),
    ...overrides,
  };
}

const PR_CTX: ToolContext = { mode: "pr" };
const PLAN_CTX: ToolContext = { mode: "plan" };

describe("dispatchTool()", () => {
  it("executes a registered tool and returns ok with result", async () => {
    const tool = makeTool();
    const out = await dispatchTool([tool], "Echo", JSON.stringify({ value: "hi" }), PR_CTX);
    expect(out).toEqual({ ok: true, result: "hi" });
  });

  it("returns is-error for unknown tools", async () => {
    const out = await dispatchTool([], "Nope", "{}", PR_CTX);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Unknown tool/);
  });

  it("returns is-error on JSON-parse failure", async () => {
    const out = await dispatchTool([makeTool()], "Echo", "{not json", PR_CTX);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Invalid JSON/);
  });

  it("returns is-error when the tool throws", async () => {
    const tool = makeTool({
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const out = await dispatchTool([tool], "Echo", "{}", PR_CTX);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("boom");
  });

  it("blocks non-readonly tools in plan mode", async () => {
    const writer = makeTool({
      name: "Write",
      isReadOnly: false,
    });
    const out = await dispatchTool([writer], "Write", JSON.stringify({ value: "x" }), PLAN_CTX);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/blocked in plan mode/);
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("allows readonly tools in plan mode", async () => {
    const tool = makeTool();
    const out = await dispatchTool([tool], "Echo", JSON.stringify({ value: "yes" }), PLAN_CTX);
    expect(out).toEqual({ ok: true, result: "yes" });
  });

  it("truncates oversized tool results", async () => {
    const huge = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
    const tool = makeTool({
      execute: vi.fn().mockResolvedValue(huge),
    });
    const out = await dispatchTool([tool], "Echo", JSON.stringify({ value: "ignored" }), PR_CTX);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.length).toBeLessThan(huge.length);
      expect(out.result).toContain("truncated");
    }
  });

  it("treats empty rawArgs as {}", async () => {
    const tool = makeTool({
      execute: vi.fn().mockResolvedValue("no-args-ok"),
    });
    const out = await dispatchTool([tool], "Echo", "", PR_CTX);
    expect(out).toEqual({ ok: true, result: "no-args-ok" });
  });
});

describe("toolsForOpenAI()", () => {
  it("converts the registry to the OpenAI tools shape", () => {
    const out = toolsForOpenAI([makeTool()]);
    expect(out).toEqual([
      {
        type: "function",
        function: {
          name: "Echo",
          description: "echo back the `value` arg",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    ]);
  });
});
