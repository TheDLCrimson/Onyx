import { describe, expect, it } from "vitest";
import { verifyPlan } from "../services/llm";

const hasOpenRouter = !!process.env.OPENROUTER_API_KEY?.trim();
const describeIfOpenRouter = hasOpenRouter ? describe : describe.skip;

describeIfOpenRouter("verifyPlan — real OpenRouter (light tier)", () => {
  it("returns one of the three valid verdict strings", async () => {
    const result = await verifyPlan({
      planText: "1. Add a new file at src/foo.ts containing `export const FOO = 1;`",
      diffSummary: "[create] src/foo.ts\n- created src/foo.ts with `export const FOO = 1;`",
    });
    expect(["match", "partial", "mismatch"]).toContain(result.verdict);
    expect(typeof result.notes).toBe("string");
  }, 60_000);

  it("flags mismatch when the diff clearly does not match the plan", async () => {
    const result = await verifyPlan({
      planText: "1. Add validation to the email field in src/form.ts",
      diffSummary:
        "[delete] README.md\n- deleted the project README\n\n" +
        "[create] LICENSE.unrelated\n- added an unrelated license file",
    });
    // We don't lock to "mismatch" exactly — light-tier output varies — but
    // it should not return "match" for an obviously unrelated diff.
    expect(result.verdict).not.toBe("match");
  }, 60_000);
});
