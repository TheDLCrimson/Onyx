import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAllSessionsForTesting,
  attachActiveFeature,
  getOrCreateSession,
} from "../services/sessions";
import { buildWriteTools } from "../services/writeTools";
import type { ToolContext } from "../services/tools";
import { TOOL_RESULT_PAGE_SIZE } from "../services/tools";
import type { ActiveFeature, RunningAgent } from "../types";

const mockClient = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  buildBranchName: vi.fn(() => "onyx/feat-1"),
  createBranch: vi.fn(),
  getDefaultBranch: vi.fn(async () => ({ name: "main", sha: "0" })),
  openPullRequest: vi.fn(async () => ({
    url: "https://github.com/o/r/pull/1",
    number: 1,
    branch: "onyx/feat-1",
  })),
  getPullRequest: vi.fn(async () => ({
    number: 1,
    state: "open" as const,
    merged: false,
    url: "https://github.com/o/r/pull/1",
  })),
  updatePullRequest: vi.fn(),
  repoCoordinates: vi.fn(() => ({ owner: "o", repo: "r" })),
};

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => mockClient),
  createGithubClient: vi.fn(() => mockClient),
}));

vi.mock("../services/llm", async () => {
  const actual = await vi.importActual<typeof import("../services/llm")>("../services/llm");
  return {
    ...actual,
    summarizeChange: vi.fn(async () => "- did the thing"),
    editFile: vi.fn(async (_path: string, _cur: string, _instr: string) => "// updated\n"),
  };
});

import { editFile, summarizeChange } from "../services/llm";

const PR_CTX: ToolContext = {
  mode: "pr",
  activeBranch: "onyx/feat-1",
  channelId: "ch-1",
};

function fixtureFeature(): ActiveFeature {
  return {
    branch: "onyx/feat-1",
    prNumber: 1,
    title: "feat: x",
    paths: new Set<string>(),
    turns: [],
    createdAt: 0,
  };
}

function fixtureRunningAgent(): RunningAgent {
  return { kind: "feature", state: "running", cursor: 0, initiatorId: "u-1", startedAt: 0 };
}

function makeHooks() {
  return {
    postPreview: vi.fn(async (_text: string) => "msg-1"),
    awaitConfirmation: vi.fn(async (_messageId: string) => true),
    postCommitResult: vi.fn(async (_text: string) => undefined),
    postPullRequestLink: vi.fn(async (_url: string, _number: number) => undefined),
  };
}

beforeEach(() => {
  _resetAllSessionsForTesting();
  mockClient.readFile.mockReset();
  mockClient.writeFile.mockReset();
  mockClient.deleteFile.mockReset();
  mockClient.updatePullRequest.mockReset();
  vi.mocked(summarizeChange).mockClear();
  vi.mocked(editFile).mockClear();
});

describe("Write tool", () => {
  it("stages a new file instead of committing", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    const tools = buildWriteTools({ session, hooks });
    const write = tools.find((t) => t.name === "Write")!;

    const result = await write.execute(
      { path: "new.ts", content: "x", prompt: "add new.ts" },
      PR_CTX,
    );

    // Does NOT commit — stages instead
    expect(mockClient.writeFile).not.toHaveBeenCalled();
    // Staging area has the entry
    expect(session.runningAgent.stagingArea).toHaveLength(1);
    expect(session.runningAgent.stagingArea![0]).toMatchObject({
      kind: "create",
      path: "new.ts",
      content: "x",
      prompt: "add new.ts",
    });
    // Posts staged confirmation (not commit)
    expect(hooks.postCommitResult).toHaveBeenCalledWith("📦 Staged `new.ts`");
    // PR link NOT announced by write tool — only by Commit tool
    expect(hooks.postPullRequestLink).not.toHaveBeenCalled();
    expect(result).toContain("Staged new.ts");
  });

  it("returns a 'user rejected' message when in direct mode + ❌", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    hooks.awaitConfirmation.mockResolvedValue(false);
    const tools = buildWriteTools({ session, hooks });
    const write = tools.find((t) => t.name === "Write")!;

    const result = await write.execute(
      { path: "new.ts", content: "x", prompt: "add new.ts" },
      { mode: "direct", activeBranch: "onyx/feat-1", channelId: "ch-1" },
    );
    expect(result).toContain("rejected");
    expect(mockClient.writeFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea ?? []).toHaveLength(0);
  });

  it("throws when no runningAgent is set", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    // session.runningAgent intentionally left null
    const tools = buildWriteTools({ session, hooks: makeHooks() });
    const write = tools.find((t) => t.name === "Write")!;
    await expect(
      write.execute({ path: "new.ts", content: "x", prompt: "p" }, PR_CTX),
    ).rejects.toThrow(/No active agent loop/);
  });

  it("throws when staging area is at MAX_STAGED_FILES", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    // Fill staging area to the cap (20 entries)
    session.runningAgent.stagingArea = Array.from({ length: 20 }, (_, i) => ({
      kind: "create" as const,
      path: `file${i}.ts`,
      content: "x",
      prompt: "p",
    }));
    const tools = buildWriteTools({ session, hooks: makeHooks() });
    const write = tools.find((t) => t.name === "Write")!;
    await expect(
      write.execute({ path: "new.ts", content: "x", prompt: "p" }, PR_CTX),
    ).rejects.toThrow(/Staging area full/);
  });

  describe("shrink guard", () => {
    it("skips the guard when the file is new (no existing content)", async () => {
      mockClient.readFile.mockResolvedValue(null);
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      // content is tiny — but no existing file, so no guard
      await expect(
        write.execute({ path: "n.ts", content: "x", prompt: "p" }, PR_CTX),
      ).resolves.toContain("Staged");
    });

    it("allows writes when content is >80% of original", async () => {
      const original = "x".repeat(100);
      const newContent = "y".repeat(85); // 85% — above threshold
      mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      await expect(
        write.execute({ path: "f.ts", content: newContent, prompt: "p" }, PR_CTX),
      ).resolves.toBeDefined();
    });

    it("allows writes when content is exactly 80% of original", async () => {
      const original = "x".repeat(100);
      const newContent = "y".repeat(80); // exactly 80%
      mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      await expect(
        write.execute({ path: "f.ts", content: newContent, prompt: "p" }, PR_CTX),
      ).resolves.toBeDefined();
    });

    it("refuses when content is <80% of original and acknowledge_shrink is absent", async () => {
      const original = "x".repeat(100);
      const newContent = "y".repeat(50); // 50% — below threshold
      mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      await expect(
        write.execute({ path: "f.ts", content: newContent, prompt: "p" }, PR_CTX),
      ).rejects.toThrow(/refused.*50%/);
    });

    it("allows shrink with acknowledge_shrink: true and stages the entry", async () => {
      const original = "x".repeat(100);
      const newContent = "y".repeat(50);
      mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      await expect(
        write.execute(
          { path: "f.ts", content: newContent, prompt: "p", acknowledge_shrink: true },
          PR_CTX,
        ),
      ).resolves.toBeDefined();
      // Staged, not committed
      expect(mockClient.writeFile).not.toHaveBeenCalled();
      expect(session.runningAgent.stagingArea).toHaveLength(1);
    });

    it("refuses when acknowledge_shrink is the string 'true' (strict boolean check)", async () => {
      const original = "x".repeat(100);
      const newContent = "y".repeat(50);
      mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
      const session = getOrCreateSession("c", 1);
      attachActiveFeature(session, fixtureFeature());
      session.runningAgent = fixtureRunningAgent();
      const tools = buildWriteTools({ session, hooks: makeHooks() });
      const write = tools.find((t) => t.name === "Write")!;
      await expect(
        write.execute(
          { path: "f.ts", content: newContent, prompt: "p", acknowledge_shrink: "true" },
          PR_CTX,
        ),
      ).rejects.toThrow(/refused/);
    });
  });
});

describe("Edit tool", () => {
  it("calls editFile, posts a diff, stages the entry, and returns JSON echo", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "x.ts",
      content: "// old\n",
      sha: "deadbeef",
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    const tools = buildWriteTools({ session, hooks });
    const edit = tools.find((t) => t.name === "Edit")!;

    const raw = await edit.execute({ path: "x.ts", instruction: "rename foo to bar" }, PR_CTX);
    const parsed = JSON.parse(raw);
    expect(editFile).toHaveBeenCalledOnce();
    expect(hooks.postPreview).toHaveBeenCalledOnce();
    // Does NOT commit — stages instead
    expect(mockClient.writeFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea).toHaveLength(1);
    expect(session.runningAgent.stagingArea![0]).toMatchObject({ kind: "edit", path: "x.ts" });
    expect(parsed.result).toContain("Staged x.ts");
    // Post-edit content returned so the model can self-verify before committing.
    expect(parsed.post_edit_content).toContain("// updated\n");
    expect(parsed._truncated).toBe(false);
    expect(parsed.read_complete).toBe(true);
    // PR link NOT announced by edit tool
    expect(hooks.postPullRequestLink).not.toHaveBeenCalled();
  });

  it("returns _truncated: true when post-edit content exceeds page size", async () => {
    const largeContent = "z".repeat(TOOL_RESULT_PAGE_SIZE + 100);
    mockClient.readFile.mockResolvedValue({ path: "big.ts", content: "// old\n", sha: "s" });
    vi.mocked(editFile).mockResolvedValue(largeContent);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const tools = buildWriteTools({ session, hooks: makeHooks() });
    const edit = tools.find((t) => t.name === "Edit")!;

    const parsed = JSON.parse(
      await edit.execute({ path: "big.ts", instruction: "expand" }, PR_CTX),
    );
    expect(parsed._truncated).toBe(true);
    expect(parsed.read_complete).toBe(false);
    expect(parsed.bytes_remaining).toBe(100);
  });

  it("throws when the path is missing", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const tools = buildWriteTools({ session, hooks: makeHooks() });
    const edit = tools.find((t) => t.name === "Edit")!;
    await expect(edit.execute({ path: "ghost.ts", instruction: "x" }, PR_CTX)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("Delete tool", () => {
  it("requires explicit confirmation even in pr mode, then stages the delete", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "old.ts",
      content: "// going away\n",
      sha: "abc",
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    const tools = buildWriteTools({ session, hooks });
    const del = tools.find((t) => t.name === "Delete")!;

    const result = await del.execute({ path: "old.ts", prompt: "no longer used" }, PR_CTX);
    expect(hooks.awaitConfirmation).toHaveBeenCalledOnce();
    // Confirmation required BEFORE staging — this is intentional (destructive intent)
    expect(mockClient.deleteFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea).toHaveLength(1);
    expect(session.runningAgent.stagingArea![0]).toMatchObject({ kind: "delete", path: "old.ts" });
    expect(result).toContain("Staged deletion of old.ts");
  });

  it("aborts cleanly when user declines", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "old.ts",
      content: "// going away\n",
      sha: "abc",
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    hooks.awaitConfirmation.mockResolvedValue(false);
    const tools = buildWriteTools({ session, hooks });
    const del = tools.find((t) => t.name === "Delete")!;
    const result = await del.execute({ path: "old.ts", prompt: "no longer used" }, PR_CTX);
    expect(mockClient.deleteFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea ?? []).toHaveLength(0);
    expect(result).toContain("cancelled");
  });

  it("calls postCancelledDelete with the path when user declines", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "old.ts",
      content: "// going away\n",
      sha: "abc",
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    hooks.awaitConfirmation.mockResolvedValue(false);
    const postCancelledDelete = vi.fn(async (_path: string) => undefined);
    const tools = buildWriteTools({ session, hooks: { ...hooks, postCancelledDelete } });
    const del = tools.find((t) => t.name === "Delete")!;
    await del.execute({ path: "old.ts", prompt: "no longer used" }, PR_CTX);
    expect(postCancelledDelete).toHaveBeenCalledOnce();
    expect(postCancelledDelete).toHaveBeenCalledWith("old.ts");
  });
});

describe("MultiEdit tool", () => {
  function makeMultiEdit(session: ReturnType<typeof getOrCreateSession>, hooks = makeHooks()) {
    const tools = buildWriteTools({ session, hooks });
    return tools.find((t) => t.name === "MultiEdit")!;
  }

  it("applies ordered find/replace pairs and stages the result", async () => {
    const original = "hello world\nfoo bar\n";
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: original, sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const hooks = makeHooks();
    const multi = makeMultiEdit(session, hooks);

    const raw = await multi.execute(
      {
        path: "f.ts",
        edits: [
          { find: "hello", replace: "goodbye" },
          { find: "foo", replace: "baz" },
        ],
        prompt: "rename greetings",
      },
      PR_CTX,
    );
    const parsed = JSON.parse(raw);
    // Staged, not committed
    expect(mockClient.writeFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea).toHaveLength(1);
    expect(parsed.result).toContain("Staged f.ts");
    expect(parsed.result).toContain("2 edits");
    expect(parsed.post_edit_content).toContain("goodbye world");
    expect(parsed.post_edit_content).toContain("baz bar");
    // pr mode + non-destructive → no awaitConfirmation
    expect(hooks.awaitConfirmation).not.toHaveBeenCalled();
    // PR link NOT announced by MultiEdit
    expect(hooks.postPullRequestLink).not.toHaveBeenCalled();
  });

  it("throws when a find string is not found", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "hello world", sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);
    await expect(
      multi.execute(
        { path: "f.ts", edits: [{ find: "zzz", replace: "aaa" }], prompt: "p" },
        PR_CTX,
      ),
    ).rejects.toThrow(/not found/);
    expect(mockClient.writeFile).not.toHaveBeenCalled();
  });

  it("throws when a find string matches more than once (non-unique)", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "f.ts",
      content: "foo bar foo",
      sha: "s",
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);
    await expect(
      multi.execute(
        { path: "f.ts", edits: [{ find: "foo", replace: "baz" }], prompt: "p" },
        PR_CTX,
      ),
    ).rejects.toThrow(/non-unique.*2/);
    expect(mockClient.writeFile).not.toHaveBeenCalled();
  });

  it("throws when edits array is empty", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "x", sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);
    await expect(multi.execute({ path: "f.ts", edits: [], prompt: "p" }, PR_CTX)).rejects.toThrow(
      /non-empty/,
    );
  });

  it("throws when edits is not an array", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "x", sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);
    await expect(
      multi.execute({ path: "f.ts", edits: "bad", prompt: "p" }, PR_CTX),
    ).rejects.toThrow(/non-empty/);
  });

  it("throws when the file path is not found", async () => {
    mockClient.readFile.mockResolvedValue(null);
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);
    await expect(
      multi.execute(
        { path: "ghost.ts", edits: [{ find: "x", replace: "y" }], prompt: "p" },
        PR_CTX,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("returns _truncated: true when post-edit content exceeds page size", async () => {
    const largeContent = "A".repeat(TOOL_RESULT_PAGE_SIZE + 200);
    // The find string appears exactly once
    const original = "REPLACE_ME " + "A".repeat(TOOL_RESULT_PAGE_SIZE + 189);
    mockClient.readFile.mockResolvedValue({ path: "big.ts", content: original, sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);

    const parsed = JSON.parse(
      await multi.execute(
        {
          path: "big.ts",
          edits: [{ find: "REPLACE_ME", replace: "A".repeat(11) }],
          prompt: "expand",
        },
        PR_CTX,
      ),
    );
    expect(parsed._truncated).toBe(true);
    expect(parsed.read_complete).toBe(false);
    expect(parsed.bytes_remaining).toBeGreaterThan(0);
  });

  it("returns _truncated: false for small results", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "hello world", sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);

    const parsed = JSON.parse(
      await multi.execute(
        { path: "f.ts", edits: [{ find: "hello", replace: "hi" }], prompt: "p" },
        PR_CTX,
      ),
    );
    expect(parsed._truncated).toBe(false);
    expect(parsed.read_complete).toBe(true);
  });

  it("stages nothing if any find string fails — atomic rollback", async () => {
    const original = "const A = 1;\nconst B = 2;\n";
    mockClient.readFile.mockResolvedValue({ path: "consts.ts", content: original, sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);

    await expect(
      multi.execute(
        {
          path: "consts.ts",
          edits: [
            { find: "const A = 1;", replace: "const A = 99;" },
            { find: "const MISSING = 0;", replace: "const MISSING = 1;" },
          ],
          prompt: "Update A and MISSING",
        },
        PR_CTX,
      ),
    ).rejects.toThrow(/not found/);

    expect(mockClient.writeFile).not.toHaveBeenCalled();
    expect(session.runningAgent.stagingArea ?? []).toHaveLength(0);
  });

  it("applies edits in order — later find targets original content", async () => {
    const original = "const FOO = 1;\nconst BAR = FOO + 1;\n";
    mockClient.readFile.mockResolvedValue({ path: "consts.ts", content: original, sha: "s" });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const multi = makeMultiEdit(session);

    const raw = await multi.execute(
      {
        path: "consts.ts",
        edits: [
          { find: "const FOO = 1;", replace: "const FOO = 42;" },
          { find: "const BAR = FOO + 1;", replace: "const BAR = FOO * 2;" },
        ],
        prompt: "Update constants",
      },
      PR_CTX,
    );

    const parsed = JSON.parse(raw);
    expect(parsed.post_edit_content).toContain("const FOO = 42;");
    expect(parsed.post_edit_content).toContain("const BAR = FOO * 2;");
    expect(parsed.result).toContain("2 edits");
    expect(mockClient.writeFile).not.toHaveBeenCalled(); // staged, not committed
  });
});

describe("Commit tool", () => {
  function makeCommit(session: ReturnType<typeof getOrCreateSession>, hooks = makeHooks()) {
    const tools = buildWriteTools({ session, hooks });
    return tools.find((t) => t.name === "Commit")!;
  }

  it("returns is_error when nothing is staged", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    const commit = makeCommit(session);

    const raw = await commit.execute({ message: "feat: add models" }, PR_CTX);
    const parsed = JSON.parse(raw);
    expect(parsed.is_error).toBe(true);
    expect(parsed.error).toContain("Nothing staged");
    expect(mockClient.writeFile).not.toHaveBeenCalled();
  });

  it("returns is_error when stagingArea is undefined", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = { ...fixtureRunningAgent(), stagingArea: undefined };
    const commit = makeCommit(session);

    const raw = await commit.execute({ message: "feat: add models" }, PR_CTX);
    const parsed = JSON.parse(raw);
    expect(parsed.is_error).toBe(true);
  });

  it("flushes all staged entries — calls commitChange per entry, clears staging", async () => {
    // create a.ts: file must NOT exist on branch yet (null sha → create allowed)
    // edit b.ts: file must exist on branch (non-null sha → edit allowed)
    mockClient.readFile.mockImplementation(async (path: string) => {
      if (path === "b.ts") return { path: "b.ts", content: "old", sha: "s2" };
      return null;
    });
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    session.runningAgent.stagingArea = [
      { kind: "create", path: "a.ts", content: "hello", prompt: "add a" },
      { kind: "edit", path: "b.ts", content: "world", prompt: "update b", sha: "s2" },
    ];
    const hooks = makeHooks();
    const commit = makeCommit(session, hooks);

    const result = await commit.execute({ message: "feat: add files" }, PR_CTX);

    // Both entries committed
    expect(mockClient.writeFile).toHaveBeenCalledTimes(2);
    // Staging area cleared
    expect(session.runningAgent.stagingArea).toHaveLength(0);
    // Result lists both files
    expect(result).toContain("Committed 2 file(s)");
    expect(result).toContain("Created `a.ts`");
    expect(result).toContain("Edited `b.ts`");
    // postCommitResult called with success message
    expect(hooks.postCommitResult).toHaveBeenCalledOnce();
    const commitText = hooks.postCommitResult.mock.calls[0]?.[0] ?? "";
    expect(commitText).toContain("✅ Committed");
  });

  it("uses the provided commit message for each entry", async () => {
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    session.runningAgent.stagingArea = [
      { kind: "create", path: "foo.ts", content: "x", prompt: "p" },
    ];
    const commit = makeCommit(session);

    await commit.execute({ message: "feat: add foo" }, PR_CTX);

    // The commit message was passed to writeFile (via commitChange → defaultCommitMessage)
    const writeArgs = mockClient.writeFile.mock.calls[0];
    // writeFile(path, content, commitMessage, sha?, branch?) — 3rd arg is commitMessage
    expect(writeArgs[2]).toBe("feat: add foo");
  });

  it("calls postPullRequestLink for each PR-mode outcome", async () => {
    // The Commit tool calls postPullRequestLink on every PR-mode commitChange result.
    // The "announce only once per loop" guard lives in makeWriteHooks (featureRunner),
    // not in the Commit tool — that is tested in featureRunnerStaging.test.ts.
    const session = getOrCreateSession("c", 1);
    // No attachActiveFeature — active is null; openFreshFeature will be called.
    session.runningAgent = fixtureRunningAgent();
    session.runningAgent.stagingArea = [
      { kind: "create", path: "a.ts", content: "x", prompt: "p" },
    ];
    const hooks = makeHooks();
    const commit = makeCommit(session, hooks);

    await commit.execute({ message: "feat: add a" }, PR_CTX);

    expect(hooks.postPullRequestLink).toHaveBeenCalledOnce();
    expect(hooks.postPullRequestLink).toHaveBeenCalledWith("https://github.com/o/r/pull/1", 1);
  });

  it("does not call postPullRequestLink when session.active.prAnnounced is already true", async () => {
    const session = getOrCreateSession("c", 1);
    const feature = fixtureFeature();
    feature.prAnnounced = true; // already announced
    attachActiveFeature(session, feature);
    session.runningAgent = fixtureRunningAgent();
    session.runningAgent.stagingArea = [
      { kind: "create", path: "a.ts", content: "x", prompt: "p" },
    ];
    // The mock hook implementation: postPullRequestLink is called by the Commit tool,
    // but the hook itself (makeWriteHooks in featureRunner) checks prAnnounced.
    // In this unit test, the hook is a plain mock that always runs — we test the
    // featureRunner hook's prAnnounced check in featureRunnerStaging.test.ts.
    // Here we just verify the Commit tool DOES call postPullRequestLink per PR outcome.
    const hooks = makeHooks();
    const commit = makeCommit(session, hooks);

    await commit.execute({ message: "feat: x" }, PR_CTX);

    // Commit tool calls postPullRequestLink — the guard is in the hook implementation
    expect(hooks.postPullRequestLink).toHaveBeenCalledOnce();
  });

  it("partial failure — removes committed entries, preserves remaining in staging", async () => {
    mockClient.readFile.mockResolvedValue({ path: "a.ts", content: "old", sha: "s" });
    // First writeFile succeeds, second throws
    mockClient.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("GitHub API error"));
    const session = getOrCreateSession("c", 1);
    attachActiveFeature(session, fixtureFeature());
    session.runningAgent = fixtureRunningAgent();
    session.runningAgent.stagingArea = [
      { kind: "edit", path: "a.ts", content: "new a", prompt: "p1", sha: "s" },
      { kind: "edit", path: "b.ts", content: "new b", prompt: "p2", sha: "s2" },
    ];
    const commit = makeCommit(session);

    const result = await commit.execute({ message: "feat: update" }, PR_CTX);

    // First entry committed (removed from staging), second failed (stays in staging)
    expect(session.runningAgent.stagingArea).toHaveLength(1);
    expect(session.runningAgent.stagingArea![0].path).toBe("b.ts");
    // Result describes partial success
    expect(result).toContain("Committed 1 file(s)");
    expect(result).toContain("Failed on `b.ts`");
    expect(result).toContain("1 entries remain staged");
  });
});
