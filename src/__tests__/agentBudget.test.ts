import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import { runAgent, DEFAULT_BUDGET, BUILD_FIX_BUDGET } from "../services/agent";
import type { AgentBudget } from "../types";
import type { Tool, ToolContext } from "../services/tools";

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    chatCompletion: vi.fn(),
  };
});

import { chatCompletion } from "../services/llm";

const PR_CTX: ToolContext = { mode: "pr", channelId: "ch1" };

/** Build a completion that calls a tool (with optional token usage). */
function toolCallCompletion(
  name: string,
  args: Record<string, unknown> = {},
  usage?: { promptTokens: number; completionTokens: number },
): ChatCompletion {
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
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        }
      : undefined,
  } as unknown as ChatCompletion;
}

/** Build a text-only completion. */
function textCompletion(
  text: string,
  usage?: { promptTokens: number; completionTokens: number },
): ChatCompletion {
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
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        }
      : undefined,
  } as unknown as ChatCompletion;
}

function readTool(name = "Read"): Tool {
  return {
    name,
    description: "read-only tool",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    isDestructive: false,
    execute: vi.fn().mockResolvedValue("read-result"),
  };
}

function writeTool(name = "Write"): Tool {
  return {
    name,
    description: "write tool",
    parameters: { type: "object", properties: {} },
    isReadOnly: false,
    isDestructive: false,
    execute: vi.fn().mockResolvedValue("write-result"),
  };
}

function checkpointTool(): Tool {
  return {
    name: "RequestCheckpoint",
    description: "checkpoint",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    isDestructive: false,
    execute: vi.fn().mockResolvedValue("Checkpoint armed."),
  };
}

beforeEach(() => {
  vi.mocked(chatCompletion).mockReset();
});

describe("budget-mode: per-tool decrement", () => {
  it("decrements reads on a read-tool call", async () => {
    const captured: AgentBudget[] = [];
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Read"))
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 5, writes: 10, tokens: 100_000 },
      onIteration: (_, b) => {
        if (b) captured.push({ ...b });
      },
    });

    expect(captured[0]?.reads).toBe(4); // 5 - 1
    expect(captured[0]?.writes).toBe(10); // unchanged
  });

  it("decrements writes on a write-tool call", async () => {
    const captured: AgentBudget[] = [];
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Write"))
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [writeTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 5, tokens: 100_000 },
      onIteration: (_, b) => {
        if (b) captured.push({ ...b });
      },
    });

    expect(captured[0]?.writes).toBe(4); // 5 - 1
    expect(captured[0]?.reads).toBe(10); // unchanged
  });

  it("decrements tokens from completion.usage", async () => {
    const captured: AgentBudget[] = [];
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(
        toolCallCompletion("Read", {}, { promptTokens: 300, completionTokens: 100 }),
      )
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 10, tokens: 1_000 },
      onIteration: (_, b) => {
        if (b) captured.push({ ...b });
      },
    });

    // 1_000 - 400 (prompt 300 + completion 100)
    expect(captured[0]?.tokens).toBe(600);
  });

  it("multiple tool calls in one iteration each decrement independently", async () => {
    const captured: AgentBudget[] = [];
    const multi: ChatCompletion = {
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
              { id: "c1", type: "function", function: { name: "Read", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "Write", arguments: "{}" } },
            ],
          },
        },
      ],
    } as unknown as ChatCompletion;

    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(multi)
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool(), writeTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 10, tokens: 100_000 },
      onIteration: (_, b) => {
        if (b) captured.push({ ...b });
      },
    });

    expect(captured[0]?.reads).toBe(9); // 10 - 1 read
    expect(captured[0]?.writes).toBe(9); // 10 - 1 write
  });
});

describe("budget-mode: axis exhaustion", () => {
  it("truncates when read axis hits 0", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Read"))
      .mockResolvedValueOnce(toolCallCompletion("Read"));
    // second iteration: read goes to 0 → expect truncation (no third call needed)

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 1, writes: 99, tokens: 999_999 },
    });

    expect(result).toMatchObject({ paused: false, truncated: true });
  });

  it("truncates when write axis hits 0", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Write"))
      .mockResolvedValueOnce(toolCallCompletion("Write"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [writeTool()],
      ctx: PR_CTX,
      budget: { reads: 99, writes: 1, tokens: 999_999 },
    });

    expect(result).toMatchObject({ paused: false, truncated: true });
  });

  it("truncates when token axis hits 0", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(
        toolCallCompletion("Read", {}, { promptTokens: 500, completionTokens: 600 }),
      )
      .mockResolvedValueOnce(textCompletion("done"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 99, writes: 99, tokens: 1_000 },
    });

    // tokens: 1_000 - 1_100 = -100 → exhausted → truncated
    expect(result).toMatchObject({ paused: false, truncated: true });
  });

  it("truncated text contains 'Budget exhausted'", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Read"))
      .mockResolvedValueOnce(toolCallCompletion("Read"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 1, writes: 99, tokens: 999_999 },
    });

    expect(result.text).toMatch(/Budget exhausted/i);
  });
});

describe("RequestCheckpoint — exempt from budget decrement", () => {
  it("does not decrement reads or writes when RequestCheckpoint is called", async () => {
    const captured: AgentBudget[] = [];
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("RequestCheckpoint"))
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [checkpointTool()],
      ctx: PR_CTX,
      budget: { reads: 5, writes: 5, tokens: 100_000 },
      onIteration: (_, b) => {
        if (b) captured.push({ ...b });
      },
    });

    expect(captured[0]?.reads).toBe(5); // unchanged
    expect(captured[0]?.writes).toBe(5); // unchanged
  });

  it("loop continues when RequestCheckpoint is called before any axis hits 0", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("RequestCheckpoint"))
      .mockResolvedValueOnce(textCompletion("all done"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [checkpointTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 10, tokens: 100_000 },
    });

    expect(result).toMatchObject({ paused: false, truncated: false, text: "all done" });
  });
});

describe("RequestCheckpoint — wrap-up reserve activation", () => {
  it("grants reserve and continues when checkpoint armed and axis hits 0 in same iteration", async () => {
    // reads=1, write budget fine. First iteration: RequestCheckpoint + Read (reads → 0).
    // Checkpoint is armed → reserve granted (reads becomes 5+0=5, writes+2=...).
    // Second iteration: text-only → done.
    const multi: ChatCompletion = {
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
                id: "c1",
                type: "function",
                function: { name: "RequestCheckpoint", arguments: "{}" },
              },
              { id: "c2", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
          },
        },
      ],
    } as unknown as ChatCompletion;

    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(multi)
      .mockResolvedValueOnce(textCompletion("wrap-up done"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool(), checkpointTool()],
      ctx: PR_CTX,
      budget: { reads: 1, writes: 99, tokens: 999_999 },
    });

    // Reserve activated → loop continued → clean completion
    expect(result).toMatchObject({ paused: false, truncated: false, text: "wrap-up done" });
  });

  it("truncates on second exhaustion after reserve is used", async () => {
    // First iteration: checkpoint + read (reads 1→0, checkpoint armed → reserve: reads 0+5=5)
    // Second iteration: 6 reads (burn through 5 reserve → reads ≤ 0 → truncate, no more checkpoint)
    const firstIter: ChatCompletion = {
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
                id: "c1",
                type: "function",
                function: { name: "RequestCheckpoint", arguments: "{}" },
              },
              { id: "c2", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
          },
        },
      ],
    } as unknown as ChatCompletion;

    // Build a second iteration that calls Read 6 times (>5 reserve reads)
    const sixReads: ChatCompletion = {
      id: "2",
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
            tool_calls: Array.from({ length: 6 }, (_, i) => ({
              id: `c${i}`,
              type: "function",
              function: { name: "Read", arguments: "{}" },
            })),
          },
        },
      ],
    } as unknown as ChatCompletion;

    vi.mocked(chatCompletion).mockResolvedValueOnce(firstIter).mockResolvedValueOnce(sixReads);

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool(), checkpointTool()],
      ctx: PR_CTX,
      budget: { reads: 1, writes: 99, tokens: 999_999 },
    });

    expect(result).toMatchObject({ paused: false, truncated: true });
  });

  it("calling RequestCheckpoint again after reserve used does NOT re-arm", async () => {
    // Iteration 1: checkpoint + read (armed, reads 1→0, reserve granted → reads=5)
    // Iteration 2: checkpoint again + 6 reads (reads 5→-1, but checkpoint is "used" → no re-arm → truncate)
    const firstIter: ChatCompletion = {
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
                id: "c1",
                type: "function",
                function: { name: "RequestCheckpoint", arguments: "{}" },
              },
              { id: "c2", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
          },
        },
      ],
    } as unknown as ChatCompletion;

    const secondIter: ChatCompletion = {
      id: "2",
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
                id: "d1",
                type: "function",
                function: { name: "RequestCheckpoint", arguments: "{}" },
              },
              ...Array.from({ length: 6 }, (_, i) => ({
                id: `d${i + 2}`,
                type: "function" as const,
                function: { name: "Read", arguments: "{}" },
              })),
            ],
          },
        },
      ],
    } as unknown as ChatCompletion;

    vi.mocked(chatCompletion).mockResolvedValueOnce(firstIter).mockResolvedValueOnce(secondIter);

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool(), checkpointTool()],
      ctx: PR_CTX,
      budget: { reads: 1, writes: 99, tokens: 999_999 },
    });

    // Second checkpoint call must NOT re-arm; truncates on exhaustion
    expect(result).toMatchObject({ paused: false, truncated: true });
  });
});

describe("onIteration callback", () => {
  it("receives remaining budget as second argument", async () => {
    const captured: Array<AgentBudget | undefined> = [];
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Read"))
      .mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 10, tokens: 100_000 },
      onIteration: (_, b) => captured.push(b ? { ...b } : undefined),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ reads: 9 }); // decremented
  });
});

describe("backward compatibility — no budget provided", () => {
  it("falls back to maxIterations-based truncation when no budget given", async () => {
    // Always return a tool call so the loop never exits naturally.
    vi.mocked(chatCompletion).mockResolvedValue(toolCallCompletion("Read"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      maxIterations: 2,
      // no budget
    });

    expect(result).toMatchObject({ paused: false, truncated: true });
    expect(result.text).toMatch(/Tool-call limit/i);
  });
});

describe("edge cases", () => {
  it("does not crash when completion.usage is missing/undefined", async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallCompletion("Read")) // no usage field
      .mockResolvedValueOnce(textCompletion("done"));

    const result = await runAgent({
      system: "sys",
      user: "go",
      tools: [readTool()],
      ctx: PR_CTX,
      budget: { reads: 10, writes: 10, tokens: 1_000 },
    });

    // tokens unchanged (no usage) → loop completes normally
    expect(result).toMatchObject({ paused: false, truncated: false });
  });

  it("exported DEFAULT_BUDGET has the expected shape", () => {
    expect(DEFAULT_BUDGET).toEqual({ reads: 50, writes: 20, tokens: 200_000 });
  });

  it("exported BUILD_FIX_BUDGET has the expected shape", () => {
    expect(BUILD_FIX_BUDGET).toEqual({ reads: 10, writes: 5, tokens: 30_000 });
  });
});
