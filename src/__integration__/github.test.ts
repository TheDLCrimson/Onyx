import { afterAll, describe, expect, it } from "vitest";
import {
  buildBranchName,
  closePullRequest,
  createBranch,
  deleteBranch,
  getDefaultBranch,
  openPullRequest,
  readFile,
  writeFile,
} from "../services/github";

const hasSandbox =
  !!process.env.GITHUB_TEST_OWNER?.trim() &&
  !!process.env.GITHUB_TEST_REPO?.trim() &&
  !!process.env.GITHUB_TOKEN?.trim();

const describeIfSandbox = hasSandbox ? describe : describe.skip;

describeIfSandbox("github service — real Octokit (sandbox repo)", () => {
  // Track resources to clean up if a test bails partway.
  const cleanup: { branches: string[]; prs: number[] } = {
    branches: [],
    prs: [],
  };

  afterAll(async () => {
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

  it("creates a branch, writes a file on it, opens a PR, then cleans up", async () => {
    const base = await getDefaultBranch();
    expect(base.name).toBeTruthy();
    expect(base.sha).toMatch(/^[0-9a-f]{40}$/);

    const path = `onyx-e2e/${Date.now()}.txt`;
    const branch = buildBranchName("create", path);
    cleanup.branches.push(branch);

    await createBranch(branch, base.sha);

    await writeFile(
      path,
      "hello from onyx integration test\n",
      "test: create file via integration test",
      undefined,
      branch,
    );

    const onBranch = await readFile(path, branch);
    expect(onBranch?.content).toContain("hello from onyx");

    const onMain = await readFile(path);
    expect(onMain).toBeNull();

    const pr = await openPullRequest(
      `test: ${path}`,
      "Onyx integration test PR — safe to close.",
      branch,
      base.name,
    );
    cleanup.prs.push(pr.number);

    expect(pr.url).toMatch(/^https:\/\/github\.com\//);
    expect(pr.number).toBeGreaterThan(0);
    expect(pr.branch).toBe(branch);
  });
});
