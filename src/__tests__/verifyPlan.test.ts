import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseVerifyResponse,
  truncateForVerifier,
  VERIFY_DIFF_MAX_CHARS,
  verifyPlan,
} from "../services/llm";

const FALLBACK = { verdict: "partial", notes: "(verification unavailable)" };

describe("truncateForVerifier", () => {
  it("returns input unchanged when below the cap", () => {
    expect(truncateForVerifier("short")).toBe("short");
  });

  it("clips to the cap and appends a truncated marker", () => {
    const huge = "x".repeat(VERIFY_DIFF_MAX_CHARS + 500);
    const out = truncateForVerifier(huge);
    expect(out.length).toBeLessThanOrEqual(VERIFY_DIFF_MAX_CHARS);
    expect(out.endsWith("(truncated)")).toBe(true);
  });

  it("respects a custom cap", () => {
    const out = truncateForVerifier("hello world".repeat(10), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain("(truncated)");
  });
});

describe("parseVerifyResponse", () => {
  it("parses a clean JSON match verdict", () => {
    const r = parseVerifyResponse('{"verdict":"match","notes":"ok"}');
    expect(r).toEqual({ verdict: "match", notes: "ok" });
  });

  it("strips fences before parsing", () => {
    const r = parseVerifyResponse('```json\n{"verdict":"partial","notes":"some"}\n```');
    expect(r.verdict).toBe("partial");
  });

  it("falls back on malformed JSON", () => {
    expect(parseVerifyResponse("not json")).toEqual(FALLBACK);
  });

  it("falls back on unknown verdict value", () => {
    expect(parseVerifyResponse('{"verdict":"weird","notes":"x"}')).toEqual(FALLBACK);
  });

  it("falls back on missing notes", () => {
    expect(parseVerifyResponse('{"verdict":"match"}')).toEqual(FALLBACK);
  });

  it("falls back when not an object", () => {
    expect(parseVerifyResponse("[]")).toEqual(FALLBACK);
    expect(parseVerifyResponse("null")).toEqual(FALLBACK);
  });
});

describe("verifyPlan", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("includes plan + diff in the prompt and parses the JSON reply", async () => {
    const seenMessages: { role: string; content: string }[] = [];
    vi.doMock("openai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("openai")>();
      class FakeOpenAI {
        chat = {
          completions: {
            create: async (params: { messages: { role: string; content: string }[] }) => {
              for (const m of params.messages) seenMessages.push(m);
              return {
                choices: [
                  {
                    message: {
                      content: '{"verdict":"match","notes":"all good"}',
                    },
                  },
                ],
              };
            },
          },
        };
      }
      return { ...actual, default: FakeOpenAI };
    });
    const { verifyPlan: vp } = await import("../services/llm");
    const out = await vp({
      planText: "PLAN-XYZ",
      diffSummary: "DIFF-XYZ",
    });
    expect(out).toEqual({ verdict: "match", notes: "all good" });
    const userMsg = seenMessages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("PLAN-XYZ");
    expect(userMsg.content).toContain("DIFF-XYZ");
    expect(userMsg.content).toContain("strict JSON");
  });

  it("falls back to partial on malformed JSON", async () => {
    vi.doMock("openai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("openai")>();
      class FakeOpenAI {
        chat = {
          completions: {
            create: async () => ({
              choices: [{ message: { content: "not-json" } }],
            }),
          },
        };
      }
      return { ...actual, default: FakeOpenAI };
    });
    const { verifyPlan: vp } = await import("../services/llm");
    const out = await vp({ planText: "p", diffSummary: "d" });
    expect(out).toEqual(FALLBACK);
  });

  it("falls back to partial on network error", async () => {
    vi.doMock("openai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("openai")>();
      class FakeOpenAI {
        chat = {
          completions: {
            create: async () => {
              throw new Error("boom");
            },
          },
        };
      }
      return { ...actual, default: FakeOpenAI };
    });
    const { verifyPlan: vp } = await import("../services/llm");
    const out = await vp({ planText: "p", diffSummary: "d" });
    expect(out).toEqual(FALLBACK);
  });

  it("uses the real verifyPlan export under stubbed env (smoke test)", () => {
    // Confirms the symbol is exported for integration callers.
    expect(typeof verifyPlan).toBe("function");
  });
});
