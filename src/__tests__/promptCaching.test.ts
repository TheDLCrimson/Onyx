import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import {
  extractSystemBase,
  hashString,
  runAgent,
  shouldDebugCache,
  shouldDebugTools,
} from "../services/agent";
import { extractCachedTokens, extractCacheWriteTokens } from "../services/llm";
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

function textCompletion(text: string, usage?: Record<string, unknown>): ChatCompletion {
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
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  } as unknown as ChatCompletion;
}

const echoTool: Tool = {
  name: "Echo",
  description: "echo back",
  parameters: { type: "object", properties: {} },
  isReadOnly: true,
  isDestructive: false,
  execute: vi.fn().mockResolvedValue("tool-result"),
};

describe("extractSystemBase", () => {
  it("returns string content directly", () => {
    expect(extractSystemBase({ role: "system", content: "hello" })).toBe("hello");
  });

  it("returns first text block from a content array (resume form)", () => {
    expect(
      extractSystemBase({
        role: "system",
        content: [
          {
            type: "text",
            text: "stable prefix",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cache_control: { type: "ephemeral" },
          } as any,
          { type: "text", text: "dynamic suffix" },
        ],
      }),
    ).toBe("stable prefix");
  });

  it("returns empty string for an array whose blocks aren't text", () => {
    expect(
      extractSystemBase({
        role: "system",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: [{ type: "image_url", image_url: { url: "x" } } as any],
      }),
    ).toBe("");
  });

  it("returns empty string when message is missing or not a system role", () => {
    expect(extractSystemBase(undefined)).toBe("");
    expect(extractSystemBase({ role: "user", content: "user msg" })).toBe("");
  });
});

describe("hashString", () => {
  it("is deterministic for identical input", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
  });

  it("differs for differing input", () => {
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });

  it("handles empty string", () => {
    expect(hashString("")).toBe(0x811c9dc5 >>> 0);
  });
});

describe("shouldDebugCache", () => {
  const orig = process.env.DEBUG;
  afterEach(() => {
    if (orig === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = orig;
  });

  it("returns false when DEBUG unset", () => {
    delete process.env.DEBUG;
    expect(shouldDebugCache()).toBe(false);
  });

  it("returns true for DEBUG=cache", () => {
    process.env.DEBUG = "cache";
    expect(shouldDebugCache()).toBe(true);
  });

  it("returns true for DEBUG=*", () => {
    process.env.DEBUG = "*";
    expect(shouldDebugCache()).toBe(true);
  });

  it("returns true when 'cache' is one of several DEBUG namespaces", () => {
    process.env.DEBUG = "session,cache,other";
    expect(shouldDebugCache()).toBe(true);
  });

  it("returns false for an unrelated DEBUG value", () => {
    process.env.DEBUG = "session";
    expect(shouldDebugCache()).toBe(false);
  });
});

describe("extractCachedTokens / extractCacheWriteTokens (defensive lookup)", () => {
  it("reads cached_tokens from prompt_tokens_details", () => {
    const u = { prompt_tokens_details: { cached_tokens: 42 } };
    expect(extractCachedTokens(u)).toBe(42);
  });

  it("falls back to Anthropic-native cache_read_input_tokens", () => {
    expect(extractCachedTokens({ cache_read_input_tokens: 17 })).toBe(17);
  });

  it("falls back to top-level cached_tokens", () => {
    expect(extractCachedTokens({ cached_tokens: 9 })).toBe(9);
  });

  it("returns undefined when no recognised field is present", () => {
    expect(extractCachedTokens({ prompt_tokens: 100 })).toBeUndefined();
    expect(extractCachedTokens(null)).toBeUndefined();
    expect(extractCachedTokens(undefined)).toBeUndefined();
  });

  it("reads cache_creation_tokens from prompt_tokens_details", () => {
    expect(extractCacheWriteTokens({ prompt_tokens_details: { cache_creation_tokens: 123 } })).toBe(
      123,
    );
  });

  it("falls back to Anthropic-native cache_creation_input_tokens", () => {
    expect(extractCacheWriteTokens({ cache_creation_input_tokens: 7 })).toBe(7);
  });

  it("ignores non-numeric / non-finite candidates", () => {
    expect(extractCachedTokens({ cached_tokens: "42" })).toBeUndefined();
    expect(extractCachedTokens({ cached_tokens: NaN })).toBeUndefined();
  });
});

describe("messages[0] cache_control shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rewrites the system message into a 2-block content array with cache_control on the static prefix", async () => {
    const mock = vi.mocked(chatCompletion);
    mock.mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "STABLE SYSTEM PROMPT",
      user: "go",
      tools: [echoTool],
      ctx: PR_CTX,
      budget: { reads: 5, writes: 2, tokens: 1000 },
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const sentMessages = mock.mock.calls[0][0].messages;
    const sysMsg = sentMessages[0];
    expect(sysMsg.role).toBe("system");
    expect(Array.isArray(sysMsg.content)).toBe(true);

    const blocks = sysMsg.content as unknown as Array<Record<string, unknown>>;
    // First block: static prefix, carries cache_control.
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("STABLE SYSTEM PROMPT");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    // Second block: dynamic budget suffix, NO cache_control.
    expect(blocks[1].type).toBe("text");
    expect(typeof blocks[1].text).toBe("string");
    expect((blocks[1].text as string).startsWith("\n\nRemaining budget:")).toBe(true);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("omits the budget suffix block when running without a budget (legacy mode)", async () => {
    const mock = vi.mocked(chatCompletion);
    mock.mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "STABLE SYSTEM PROMPT",
      user: "go",
      tools: [echoTool],
      ctx: PR_CTX,
      maxIterations: 1,
    });

    const sysMsg = vi.mocked(chatCompletion).mock.calls[0][0].messages[0];
    const blocks = sysMsg.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("STABLE SYSTEM PROMPT");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves cache_control across multiple iterations of the same run", async () => {
    const mock = vi.mocked(chatCompletion);
    // Iter 1: returns a tool call. Iter 2: returns text (loop ends).
    mock.mockResolvedValueOnce({
      ...textCompletion(""),
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          logprobs: null,
          message: {
            role: "assistant",
            content: "",
            refusal: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "Echo", arguments: "{}" },
              },
            ],
          },
        },
      ],
    } as unknown as ChatCompletion);
    mock.mockResolvedValueOnce(textCompletion("done"));

    await runAgent({
      system: "STABLE",
      user: "go",
      tools: [echoTool],
      ctx: PR_CTX,
      budget: { reads: 5, writes: 2, tokens: 1000 },
    });

    expect(mock).toHaveBeenCalledTimes(2);
    for (const call of mock.mock.calls) {
      const blocks = call[0].messages[0].content as unknown as Array<Record<string, unknown>>;
      expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
      expect(blocks[0].text).toBe("STABLE");
    }
  });
});

describe("shouldDebugTools()", () => {
  const original = process.env.DEBUG;
  afterEach(() => {
    if (original === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = original;
  });

  it("is on for DEBUG=tools and DEBUG=*", () => {
    process.env.DEBUG = "tools";
    expect(shouldDebugTools()).toBe(true);
    process.env.DEBUG = "*";
    expect(shouldDebugTools()).toBe(true);
    process.env.DEBUG = "cache,tools";
    expect(shouldDebugTools()).toBe(true);
  });

  it("is off otherwise", () => {
    delete process.env.DEBUG;
    expect(shouldDebugTools()).toBe(false);
    process.env.DEBUG = "cache";
    expect(shouldDebugTools()).toBe(false);
  });
});
