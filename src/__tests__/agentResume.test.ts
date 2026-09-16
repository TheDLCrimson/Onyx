import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import { looksLikePlan, resumeAgent, runAgent, synthUserMessageFor } from "../services/agent";
import type { Tool, ToolContext } from "../services/tools";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    chatCompletion: vi.fn(),
  };
});

import { chatCompletion } from "../services/llm";

const PLAN_CTX: ToolContext = { mode: "plan" };
const PR_CTX: ToolContext = { mode: "pr" };

function pauseTool(): Tool {
  return {
    name: "ExitPlanMode",
    description: "test",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    isDestructive: false,
    pauseAfter: true,
    execute: vi.fn().mockResolvedValue("plan posted"),
  };
}

function textOnly(text: string): ChatCompletion {
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

function callTool(name: string, args: Record<string, unknown>): ChatCompletion {
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
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  } as unknown as ChatCompletion;
}

beforeEach(() => {
  vi.mocked(chatCompletion).mockReset();
});

describe("runAgent — pause behaviour", () => {
  it("pauses on text-only response in plan mode (clarification request)", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("Should I use TypeScript or JavaScript?"),
    );
    const out = await runAgent({
      system: "sys",
      user: "build a feature",
      tools: [],
      ctx: PLAN_CTX,
    });
    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    expect(out.reason).toBe("awaiting-user-text");
    expect(out.text).toContain("Should I use TypeScript");
  });

  it("returns text-only response as final answer in pr mode", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("Done. PR posted."));
    const out = await runAgent({
      system: "sys",
      user: "do it",
      tools: [],
      ctx: PR_CTX,
    });
    expect(out.paused).toBe(false);
    if (out.paused) throw new Error("expected resolved");
    expect(out.text).toBe("Done. PR posted.");
  });

  it("pauses after a pauseAfter tool dispatches successfully", async () => {
    const tool = pauseTool();
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      callTool("ExitPlanMode", { plan_text: "1. step 1\n2. step 2" }),
    );
    const out = await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PLAN_CTX,
    });
    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    expect(out.reason).toBe("awaiting-button");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    // The tool result is the user-facing text used for rendering.
    expect(out.text).toBe("plan posted");
  });
});

describe("resumeAgent()", () => {
  it("appends a synthetic user message and continues the loop to completion", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("All done."));
    const initialMessages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "build a feature" },
      {
        role: "assistant" as const,
        content: "Should I use TypeScript or JavaScript?",
      },
    ];
    const out = await resumeAgent({
      messages: [...initialMessages],
      tools: [],
      ctx: PR_CTX,
      next: { kind: "user-text", text: "TypeScript please." },
    });
    expect(out.paused).toBe(false);
    if (out.paused) throw new Error("expected resolved");
    expect(out.text).toBe("All done.");
    // Verify the synthetic user message was inserted before the new model call.
    const passed = vi.mocked(chatCompletion).mock.calls[0]?.[0];
    const messages = passed?.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toBe("TypeScript please.");
  });

  it("translates button-approve into an 'Approved.' user message", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("Working…"));
    await resumeAgent({
      messages: [{ role: "system", content: "sys" }],
      tools: [],
      ctx: PR_CTX,
      next: { kind: "button-approve" },
    });
    const passed = vi.mocked(chatCompletion).mock.calls[0]?.[0];
    const lastUser = [...(passed?.messages ?? [])].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content)).toMatch(/approved/i);
  });

  it("translates button-revise into a 'Revise the plan: …' user message", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("Revised."));
    await resumeAgent({
      messages: [{ role: "system", content: "sys" }],
      tools: [],
      ctx: PLAN_CTX,
      next: { kind: "button-revise", instructions: "make it smaller" },
    });
    const passed = vi.mocked(chatCompletion).mock.calls[0]?.[0];
    const lastUser = [...(passed?.messages ?? [])].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content)).toContain("make it smaller");
  });

  it("resumes cleanly after an iteration-cap truncation via button-continue", async () => {
    // First run: cap fires at maxIterations=2. The tool is always called
    // without the model ever returning text, so we get a truncated result
    // whose `messages` are the resume point.
    vi.mocked(chatCompletion).mockResolvedValue(callTool("Echo", {}));
    const tool: Tool = {
      name: "Echo",
      description: "test",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      isDestructive: false,
      execute: vi.fn().mockResolvedValue("tick"),
    };
    const first = await runAgent({
      system: "sys",
      user: "do lots of things",
      tools: [tool],
      ctx: PR_CTX,
      maxIterations: 2,
    });
    expect(first.paused).toBe(false);
    if (first.paused) throw new Error("expected truncated result");
    expect(first.truncated).toBe(true);
    if (!first.truncated) throw new Error("expected truncated");
    expect(first.messages.length).toBeGreaterThan(0);

    // Now resume with button-continue — the loop ends cleanly when the model
    // finally returns text.
    vi.mocked(chatCompletion).mockReset();
    vi.mocked(chatCompletion).mockResolvedValueOnce(textOnly("Everything done."));
    const second = await resumeAgent({
      messages: first.messages,
      tools: [tool],
      ctx: PR_CTX,
      next: { kind: "button-continue" },
    });
    expect(second.paused).toBe(false);
    if (second.paused) throw new Error("expected resolved");
    expect(second.truncated).toBe(false);
    if (second.truncated) throw new Error("expected non-truncated");
    expect(second.text).toBe("Everything done.");
    // The synthetic "continue from where you left off" message was appended.
    const passed = vi.mocked(chatCompletion).mock.calls[0]?.[0];
    const lastUser = [...(passed?.messages ?? [])].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content)).toMatch(/continue/i);
  });
});

describe("synthUserMessageFor()", () => {
  it("button-approve with planText embeds the plan and execution instruction", () => {
    const msg = synthUserMessageFor({
      kind: "button-approve",
      planText: "Step 1: do X\nStep 2: do Y",
    });
    expect(msg).toContain("Step 1: do X");
    expect(msg).toContain("Step 2: do Y");
    expect(msg).toMatch(/execute it now/i);
    expect(msg).toMatch(/write \/ edit \/ delete/i);
  });

  it("button-approve without planText falls back to the generic approval message", () => {
    const msg = synthUserMessageFor({ kind: "button-approve" });
    expect(msg).toMatch(/approved/i);
    expect(msg).not.toContain("Step 1");
  });
});

describe("looksLikePlan", () => {
  it("accepts numbered steps", () => {
    expect(looksLikePlan("1. Read the file.\n2. Append the line.\n3. Commit.")).toBe(true);
  });

  it("accepts bulleted steps", () => {
    expect(looksLikePlan("Here is the plan:\n- Add the field\n- Update the caller")).toBe(true);
  });

  it("rejects a one-step reply", () => {
    expect(looksLikePlan("1. Append the line.")).toBe(false);
  });

  it("rejects prose with no steps", () => {
    expect(looksLikePlan("I had a look at the file and it seems fine.")).toBe(false);
  });

  it("rejects a question even when it lists options as steps", () => {
    expect(looksLikePlan("Which should I do?\n1. Append\n2. Prepend\nWhich do you want?")).toBe(
      false,
    );
  });

  it("rejects empty text", () => {
    expect(looksLikePlan("   ")).toBe(false);
  });
});

describe("runAgent — plan written as text instead of an ExitPlanMode call", () => {
  it("dispatches ExitPlanMode and pauses for approval", async () => {
    const tool = pauseTool();
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("1. Read the file.\n2. Append line two.\n3. Commit the change."),
    );

    const out = await runAgent({
      system: "sys",
      user: "append a line",
      tools: [tool],
      ctx: PLAN_CTX,
    });

    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    // The user gets approval buttons, not a clarification prompt.
    expect(out.reason).toBe("awaiting-button");
    // The plan text the model wrote is handed to ExitPlanMode verbatim.
    expect(tool.execute).toHaveBeenCalledWith(
      { plan_text: "1. Read the file.\n2. Append line two.\n3. Commit the change." },
      PLAN_CTX,
    );
    // The plan survives in the conversation for the resume.
    const last = out.messages[out.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("Append line two");
  });

  it("still treats a clarifying question as a clarification", async () => {
    const tool = pauseTool();
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("Which file did you mean, foo.ts or bar.ts?"),
    );

    const out = await runAgent({
      system: "sys",
      user: "append a line",
      tools: [tool],
      ctx: PLAN_CTX,
    });

    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    expect(out.reason).toBe("awaiting-user-text");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("falls back to a clarification pause when ExitPlanMode is not registered", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("1. Read the file.\n2. Append line two."),
    );

    const out = await runAgent({ system: "sys", user: "go", tools: [], ctx: PLAN_CTX });

    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    expect(out.reason).toBe("awaiting-user-text");
  });

  it("falls back to a clarification pause when the dispatch fails", async () => {
    const tool = pauseTool();
    vi.mocked(tool.execute).mockRejectedValueOnce(new Error("no Discord hooks"));
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("1. Read the file.\n2. Append line two."),
    );

    const out = await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PLAN_CTX,
    });

    expect(out.paused).toBe(true);
    if (!out.paused) throw new Error("expected paused");
    expect(out.reason).toBe("awaiting-user-text");
    // The dropped assistant turn must not be left behind in the log.
    expect(out.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("leaves pr mode alone — a plan-shaped reply is a final answer", async () => {
    const tool = pauseTool();
    vi.mocked(chatCompletion).mockResolvedValueOnce(
      textOnly("1. Read the file.\n2. Append line two."),
    );

    const out = await runAgent({ system: "sys", user: "go", tools: [tool], ctx: PR_CTX });

    expect(out.paused).toBe(false);
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
