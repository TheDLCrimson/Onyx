import { afterAll, describe, expect, it } from "vitest";
import { resumeAgent, runAgent } from "../services/agent";
import { closePullRequest, deleteBranch } from "../services/github";
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

describeIfSandbox("/feature flow — real OpenRouter + Octokit (sandbox repo)", () => {
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

  it("plans, pauses on ExitPlanMode, resumes on approval, writes a file", async () => {
    _resetAllSessionsForTesting();
    const session = getOrCreateSession(`onyx-it-${Date.now()}`);
    // Write tools stage into runningAgent.stagingArea (PR J), so the loop needs
    // a running agent exactly like startFeature sets one up.
    setRunningAgent(
      session,
      {
        kind: "feature",
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
      ...buildPlanTools({ session, hooks, scopeId: "test" }),
    ];

    // Step 1: run plan-mode loop until pause.
    session.mode = "plan";
    const stamp = Date.now();
    const planOut = await runAgent({
      system:
        "You are a programming buddy with Read/List/Grep, TodoWrite, " +
        "ExitPlanMode, Write/Edit/Delete tools. The user wants exactly " +
        "what they say. Don't ask clarifying questions for trivial " +
        "tasks. Skip Read/List for very specific paths.",
      user: `Create a single new file at onyx-e2e-feature/${stamp}.txt with the content "hello from feature test\\n". Just write the plan with one TodoWrite + ExitPlanMode. Don't read anything.`,
      tools,
      ctx: { mode: "plan" },
      maxIterations: 5,
    });

    expect(planOut.paused).toBe(true);
    if (!planOut.paused) throw new Error("expected plan-phase pause");

    // Step 2: simulate ✅ Run — flip to pr mode and resume.
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

    // Track resources before assertions so cleanup runs even on fail.
    if (session.active?.branch) cleanup.branches.push(session.active.branch);
    if (session.active?.prNumber) cleanup.prs.push(session.active.prNumber);

    expect(execOut.paused).toBe(false);
    expect(session.active).not.toBeNull();
    expect(session.active?.branch).toBeTruthy();
    expect(session.active?.prNumber).toBeGreaterThan(0);
    // Generous: free OpenRouter models take 5-12 s per call and this is a multi-step run.
  }, 300_000);
});
