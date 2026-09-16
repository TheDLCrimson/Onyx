import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import { runAgent } from "../services/agent";
import type { Tool, ToolContext } from "../services/tools";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    chatCompletion: vi.fn(),
  };
});

import { chatCompletion } from "../services/llm";

const PR_CTX: ToolContext = { mode: "pr" };

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "Echo",
    description: "echo back",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    isDestructive: false,
    execute: vi.fn().mockResolvedValue("tool-result"),
    ...overrides,
  };
}

function textCompletion(text: string): ChatCompletion {
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
        message: {
          role: "assistant",
          content: text,
          refusal: null,
        },
      },
    ],
  } as unknown as ChatCompletion;
}

function toolCallCompletion(name: string, args: Record<string, unknown>): ChatCompletion {
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

describe("runAgent()", () => {
  it("returns the model's text immediately when no tools are called", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(textCompletion("hello world"));
    const out = await runAgent({
      system: "sys",
      user: "hi",
      tools: [],
      ctx: PR_CTX,
    });
    expect(out.paused).toBe(false);
    if (out.paused) throw new Error("expected resolved result");
    expect(out.text).toBe("hello world");
    expect(out.iterations).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it("executes tool calls and feeds results back to the model", async () => {
    const tool = makeTool({
      execute: vi.fn().mockResolvedValue("// the file"),
    });
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Echo", { path: "a.ts" }))
      .mockResolvedValueOnce(textCompletion("Done — it does X."));

    const out = await runAgent({
      system: "sys",
      user: "what does a.ts do?",
      tools: [tool],
      ctx: PR_CTX,
    });

    expect(out.text).toBe("Done — it does X.");
    expect(out.iterations).toBe(2);
    expect(tool.execute).toHaveBeenCalledTimes(1);

    // Second model call should have received the assistant + tool messages.
    const secondCallParams = vi.mocked(chatCompletion).mock.calls[1]?.[0];
    expect(secondCallParams?.messages).toHaveLength(4); // system, user, assistant(tool_calls), tool
    const lastMsg = secondCallParams?.messages?.[3];
    expect(lastMsg?.role).toBe("tool");
  });

  it("fires onToolCall before each tool dispatch", async () => {
    const tool = makeTool();
    const onToolCall = vi.fn();
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Echo", { x: 1 }))
      .mockResolvedValueOnce(textCompletion("ok"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PR_CTX,
      onToolCall,
    });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      name: "Echo",
      args: JSON.stringify({ x: 1 }),
    });
  });

  it("surfaces tool errors to the model rather than throwing", async () => {
    const tool = makeTool({
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    });
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Echo", {}))
      .mockResolvedValueOnce(textCompletion("recovered"));

    const out = await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PR_CTX,
    });

    expect(out.text).toBe("recovered");
    const secondCallParams = vi.mocked(chatCompletion).mock.calls[1]?.[0];
    const toolMsg = secondCallParams?.messages?.[3];
    expect(toolMsg?.role).toBe("tool");
    expect(String(toolMsg?.content)).toContain("is_error: true");
    expect(String(toolMsg?.content)).toContain("boom");
  });

  it("appends a truncation warning when the iteration cap is hit", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(toolCallCompletion("Echo", {}));
    const tool = makeTool();
    const out = await runAgent({
      system: "sys",
      user: "go",
      tools: [tool],
      ctx: PR_CTX,
      maxIterations: 2,
    });
    expect(out.paused).toBe(false);
    if (out.paused) throw new Error("expected resolved result");
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("Tool-call limit (2)");
  });
});

describe("responses with no choices", () => {
  it("reports the provider's error when OpenRouter returns one instead of a completion", async () => {
    vi.mocked(chatCompletion).mockResolvedValue({
      error: { message: "upstream provider is down" },
    } as unknown as ChatCompletion);
    await expect(
      runAgent({
        system: "s",
        user: "u",
        tools: [],
        ctx: { mode: "pr" },
      }),
    ).rejects.toThrow(/upstream provider is down/);
  });

  it("does not crash with a TypeError when `choices` is missing entirely", async () => {
    vi.mocked(chatCompletion).mockResolvedValue({} as unknown as ChatCompletion);
    await expect(
      runAgent({
        system: "s",
        user: "u",
        tools: [],
        ctx: { mode: "pr" },
      }),
    ).rejects.toThrow("OpenRouter returned no choices.");
  });
});
