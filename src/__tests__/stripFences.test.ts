import { describe, expect, it } from "vitest";
import { stripFences } from "../services/llm";

describe("stripFences()", () => {
  it("strips a plain ``` ... ``` block", () => {
    expect(stripFences("```\nhello\n```")).toBe("hello");
  });

  it("strips a fenced block with a language tag", () => {
    expect(stripFences("```typescript\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("strips a fenced block with a hyphenated language tag", () => {
    expect(stripFences("```objective-c\n[obj msg];\n```")).toBe("[obj msg];");
  });

  it("leaves unfenced text alone", () => {
    expect(stripFences("just text")).toBe("just text");
  });

  it("does not strip when the fence is unclosed", () => {
    expect(stripFences("```\nfoo")).toBe("```\nfoo");
  });

  it("preserves multi-line content inside the fence", () => {
    expect(stripFences("```\nline1\nline2\nline3\n```")).toBe("line1\nline2\nline3");
  });
});
