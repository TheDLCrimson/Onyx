import { describe, expect, it } from "vitest";
import { runAgent } from "../services/agent";
import { READ_TOOLS } from "../services/readTools";

const hasSandbox =
  !!process.env.GITHUB_TEST_OWNER?.trim() &&
  !!process.env.GITHUB_TEST_REPO?.trim() &&
  !!process.env.GITHUB_TOKEN?.trim() &&
  !!process.env.OPENROUTER_API_KEY?.trim();

const describeIfSandbox = hasSandbox ? describe : describe.skip;

describeIfSandbox("runAgent + READ_TOOLS — real /ask against the sandbox repo", () => {
  it("uses List/Read to answer a question that requires repo exploration", async () => {
    const out = await runAgent({
      system:
        "You are a programming buddy with read-only repo tools (Read, " +
        "List, Grep). Use them to answer the user's question. Be concise.",
      user: "What files exist at the repo root? Reply with a short list.",
      tools: READ_TOOLS,
      ctx: { mode: "pr" },
      maxIterations: 4,
    });
    expect(out.text.length).toBeGreaterThan(0);
    // The model should have used at least one tool call to answer this.
    expect(out.iterations).toBeGreaterThan(1);
  });
});
