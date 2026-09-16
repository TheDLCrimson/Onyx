import { afterAll, describe, expect, it } from "vitest";
import { commitChange } from "../services/commitFlow";
import { closePullRequest, deleteBranch } from "../services/github";
import { _resetAllSessionsForTesting, getOrCreateSession } from "../services/sessions";

const hasSandbox =
  !!process.env.GITHUB_TEST_OWNER?.trim() &&
  !!process.env.GITHUB_TEST_REPO?.trim() &&
  !!process.env.GITHUB_TOKEN?.trim() &&
  !!process.env.OPENROUTER_API_KEY?.trim();

const describeIfSandbox = hasSandbox ? describe : describe.skip;

describeIfSandbox("channel-scoped sessions — two commits batch into one PR", () => {
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

  it("attaches a follow-up commit to the same branch + PR", async () => {
    _resetAllSessionsForTesting();
    const session = getOrCreateSession(`onyx-it-${Date.now()}`);

    const stamp = Date.now();
    const pathA = `onyx-e2e-session/${stamp}-a.txt`;
    const pathB = `onyx-e2e-session/${stamp}-b.txt`;

    const first = await commitChange(
      {
        kind: "create",
        path: pathA,
        content: "alpha\n",
        prompt: "first file",
      },
      session,
    );
    if (first.mode !== "pr") throw new Error("expected PR mode");
    cleanup.branches.push(first.pr.branch);
    cleanup.prs.push(first.pr.number);

    expect(first.attached).toBe(false);
    expect(session.active?.branch).toBe(first.pr.branch);
    expect(session.active?.prNumber).toBe(first.pr.number);

    const second = await commitChange(
      {
        kind: "create",
        path: pathB,
        content: "beta\n",
        prompt: "second file",
      },
      session,
    );
    if (second.mode !== "pr") throw new Error("expected PR mode");

    expect(second.attached).toBe(true);
    expect(second.pr.number).toBe(first.pr.number);
    expect(second.pr.branch).toBe(first.pr.branch);
  });
});
