import { describe, expect, it } from "vitest";
import { summarizeChange } from "../services/llm";

const hasOpenRouter = !!process.env.OPENROUTER_API_KEY?.trim();
const describeIfOpenRouter = hasOpenRouter ? describe : describe.skip;

describeIfOpenRouter("claude service — real OpenRouter", () => {
  it("summarizeChange returns non-empty bullets for a small file", async () => {
    const summary = await summarizeChange(
      "create",
      "hello.ts",
      "say hi to the world",
      'export const greet = (): string => "hello world";\n',
    );
    expect(summary).not.toBeNull();
    expect((summary ?? "").length).toBeGreaterThan(10);
  });
});
