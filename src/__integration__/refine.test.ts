import { afterAll, describe, expect, it } from "vitest";
import { resumeAgent, runAgent } from "../services/agent";
import { closePullRequest, deleteBranch, writeFile } from "../services/github";
import { READ_TOOLS } from "../services/readTools";
import { buildPlanTools } from "../services/planTools";
import { buildWriteTools } from "../services/writeTools";
import {
  _resetAllSessionsForTesting,
  getOrCreateSession,
  setRunningAgent,
} from "../services/sessions";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

const hasSandbox =
  !!process.env.GITHUB_TEST_OWNER?.trim() &&
  !!process.env.GITHUB_TEST_REPO?.trim() &&
  !!process.env.GITHUB_TOKEN?.trim() &&
  !!process.env.OPENROUTER_API_KEY?.trim();

const describeIfSandbox = hasSandbox ? describe : describe.skip;

describeIfSandbox("/refine flow — real OpenRouter + Octokit (sandbox repo)", () => {
  const cleanup: { branches: string[]; prs: number[] } = {
    branches: [],
    prs: [],
  };

  afterAll(async () => {
    _resetAllSessionsForTesting();
    for (const num of cleanup.prs) {
      try {
        await closePullRequest(num);
      } catch {
        /* best-effort */
      }
    }
    for (const name of cleanup.branches) {
      try {
        await deleteBranch(name);
      } catch {
        /* best-effort */
      }
    }
  });

  it("reaches plan approval without asking clarifying questions", async () => {
    _resetAllSessionsForTesting();
    const session = getOrCreateSession(`onyx-it-refine-${Date.now()}`);
    // Write tools stage into runningAgent.stagingArea (PR J), so the loop needs
    // a running agent exactly like startRefine sets one up.
    setRunningAgent(
      session,
      {
        kind: "refine",
        state: "running",
        cursor: 0,
        initiatorId: "integration-test",
        startedAt: Date.now(),
      },
      "plan",
    );

    const hooks = {
      postPreview: async () => "preview-msg",
      awaitConfirmation: async () => true,
      postCommitResult: async () => undefined,
      postPullRequestLink: async () => undefined,
      renderTodoList: async () => undefined,
      postPlanForApproval: async () => "plan-msg",
    };

    const tools = [
      ...READ_TOOLS,
      ...buildWriteTools({ session, hooks }),
      ...buildPlanTools({ session, hooks, scopeId: "test-refine" }),
    ];

    // Seed a file on the default branch for the model to refine.
    const stamp = Date.now();
    const filePath = `onyx-e2e-refine/${stamp}.txt`;
    await writeFile(filePath, "line one\n", `seed file for refine test`);
    cleanup.branches.push(""); // placeholder; real branch added after write

    // Run the refine loop in plan mode with the same constraints as
    // REFINE_SYSTEM_PROMPT. The critical assertion: the loop must pause
    // with reason "awaiting-button" (ExitPlanMode called), NOT
    // "awaiting-user-text" (model asked a clarifying question).
    session.mode = "plan";
    const planOut = await runAgent({
      system:
        "You are a programming buddy refining an existing feature. " +
        "IMPORTANT constraints: Do NOT redesign or rewrite the feature. " +
        "Only modify what is necessary. Prefer editing existing files.\n\n" +
        "Workflow:\n" +
        "1. Use Read / List / Grep to understand the specific area to change.\n" +
        "2. Default: go straight to ExitPlanMode without asking questions. " +
        "Only pause to ask if a critical ambiguity would make the plan wrong. " +
        "Never ask for info you can infer from the code or the intent.\n" +
        "3. Call ExitPlanMode with the full plan text.\n" +
        "Be concise. No tables.",
      user:
        `Refinement intent: append "line two" to the file at ${filePath}.\n\n` +
        `Active feature: "seed-file-test"\n` +
        `Files already touched: ${filePath}\n\n` +
        `IMPORTANT: This is a small, focused refinement. Don't ask questions — just plan.`,
      tools,
      ctx: { mode: "plan" },
      maxIterations: 6,
    });

    // Must pause for plan approval (ExitPlanMode), not for clarification.
    expect(planOut.paused).toBe(true);
    if (!planOut.paused) throw new Error("expected plan-phase pause");
    expect(planOut.reason).toBe("awaiting-button");

    // Step 2: simulate ✅ Run — flip to pr mode and execute.
    session.mode = "pr";
    const messages: ChatCompletionMessageParam[] = planOut.messages;
    const execOut = await resumeAgent({
      messages,
      tools,
      ctx: { mode: "pr" },
      next: { kind: "button-approve" },
      maxIterations: 5,
    });

    // Mirror featureRunner's auto-flush: commit anything the model staged but
    // didn't Commit itself before finishing.
    if (session.runningAgent?.stagingArea?.length) {
      const commit = tools.find((t) => t.name === "Commit")!;
      await commit.execute({ message: "test: flush staged changes" }, { mode: "pr" });
    }

    if (session.active?.branch) cleanup.branches[0] = session.active.branch;
    if (session.active?.prNumber) cleanup.prs.push(session.active.prNumber);

    expect(execOut.paused).toBe(false);
    expect(session.active?.branch).toBeTruthy();
    // Generous: free OpenRouter models take 5-12 s per call and this is a multi-step run.
  }, 300_000);
});
