import { describe, expect, it } from "vitest";
import { withHistory } from "../services/llm";

describe("withHistory()", () => {
  it("returns the original user message when history is omitted", () => {
    expect(withHistory("hi")).toBe("hi");
  });

  it("returns the original user message when history is whitespace only", () => {
    expect(withHistory("hi", "   \n  ")).toBe("hi");
  });

  it("prepends a labeled history block when history has content", () => {
    const out = withHistory("Current question", "- [create] a.ts: hello");
    expect(out).toContain("Recent activity in this conversation:");
    expect(out).toContain("- [create] a.ts: hello");
    expect(out).toContain("Current request:\nCurrent question");
    // history block must come before the current-request label.
    expect(out.indexOf("Recent activity")).toBeLessThan(out.indexOf("Current request"));
  });
});
