import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveFeature } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDetectRepoKind = vi.fn(async () => "unity" as import("../services/buildGate").RepoKind);
const mockRunBuildGate = vi.fn(async () => ({
  success: true,
  skipped: false,
  kind: "unity" as import("../services/buildGate").RepoKind,
  errors: [] as string[],
  durationMs: 100,
}));

vi.mock("../services/buildGate", () => ({
  detectRepoKind: () => mockDetectRepoKind(),
  runBuildGate: () => mockRunBuildGate(),
  buildCommandLabel: (k: string) => `${k}-build-cmd`,
}));

vi.mock("../services/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm")>();
  return {
    ...actual,
    verifyPlan: vi.fn(async () => ({ verdict: "match", notes: "ok" })),
  };
});

const mockGetPullRequestBody = vi.fn(async () => "## Summary\n- existing");
const mockUpdatePullRequest = vi.fn(async (_prNumber: number, _body: string) => undefined);

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => ({
    getPullRequestBody: mockGetPullRequestBody,
    updatePullRequest: mockUpdatePullRequest,
    listDirectory: vi.fn(async () => []),
    repoCoordinates: vi.fn(() => ({ owner: "o", repo: "r" })),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { runBuildStep } from "../runtime/featureRunner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActive(overrides: Partial<ActiveFeature> = {}): ActiveFeature {
  return {
    branch: "onyx/feat-1",
    prNumber: 42,
    title: "test feature",
    paths: new Set<string>(),
    turns: [],
    createdAt: 0,
    ...overrides,
  };
}

function makeArgs(active: ActiveFeature | null = makeActive()) {
  const channelMessages: string[] = [];
  const channelComponents: unknown[] = [];
  const channel = {
    send: vi.fn(async (msg: unknown) => {
      if (typeof msg === "string") channelMessages.push(msg);
      else if (typeof msg === "object" && msg !== null && "content" in msg) {
        channelMessages.push((msg as { content: string }).content);
        if ("components" in msg) channelComponents.push(msg);
      }
      return { id: "msg-1" };
    }),
    id: "ch-1",
  };
  const session = {
    channelId: "ch-1",
    active,
    mode: "pr" as const,
    runningAgent: null,
    lastUsedAt: 0,
    lastTurnAt: 0,
    messages: [],
  };
  return {
    session,
    channel,
    scopeId: "scope-1",
    initiatorId: "user-1",
    channelMessages,
    channelComponents,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPullRequestBody.mockResolvedValue("## Summary\n- existing");
  mockUpdatePullRequest.mockResolvedValue(undefined);
  mockDetectRepoKind.mockResolvedValue("unity");
  mockRunBuildGate.mockResolvedValue({
    success: true,
    skipped: false,
    kind: "unity",
    errors: [],
    durationMs: 100,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runBuildStep
// ---------------------------------------------------------------------------

describe("runBuildStep", () => {
  it("returns 'skipped' when active is null", async () => {
    const { session, channel, scopeId, initiatorId } = makeArgs(null);
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("skipped");
    expect(result.kind).toBeNull();
    expect(mockRunBuildGate).not.toHaveBeenCalled();
  });

  it("returns 'skipped' when active has no prNumber", async () => {
    const { session, channel, scopeId, initiatorId } = makeArgs(makeActive({ prNumber: null }));
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("skipped");
    expect(mockRunBuildGate).not.toHaveBeenCalled();
  });

  it("returns 'passed' on build success — no Discord message, PR body unchanged", async () => {
    mockRunBuildGate.mockResolvedValue({
      success: true,
      skipped: false,
      kind: "unity",
      errors: [],
      durationMs: 50,
    });
    const { session, channel, scopeId, initiatorId, channelMessages } = makeArgs();
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("passed");
    expect(result.kind).toBe("unity");
    expect(channelMessages).toHaveLength(0);
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
  });

  it("returns 'skipped' for unknown kind — appends skipped note to PR body, no Discord message", async () => {
    mockDetectRepoKind.mockResolvedValue("unknown");
    mockRunBuildGate.mockResolvedValue({
      success: true,
      skipped: true,
      kind: "unknown",
      errors: [],
      durationMs: 0,
    });
    const { session, channel, scopeId, initiatorId, channelMessages } = makeArgs();
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("skipped");
    expect(result.kind).toBe("unknown");
    expect(channelMessages).toHaveLength(0); // no Discord message for unknown
    expect(mockUpdatePullRequest).toHaveBeenCalledOnce();
    const [, body] = mockUpdatePullRequest.mock.calls[0] as [number, string];
    expect(body).toContain("_Build verification skipped");
  });

  it("returns 'skipped' when runBuildGate returns skipped:true (non-unknown, e.g. concurrency lock)", async () => {
    mockDetectRepoKind.mockResolvedValue("ts");
    mockRunBuildGate.mockResolvedValue({
      success: true,
      skipped: true,
      kind: "ts",
      errors: [],
      durationMs: 0,
    });
    const { session, channel, scopeId, initiatorId } = makeArgs();
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("skipped");
    expect(mockUpdatePullRequest).not.toHaveBeenCalled(); // no PR note for non-unknown skips
  });

  it("returns 'failed' on build failure — updates PR body with ## Build Errors and posts auto-fix button", async () => {
    mockRunBuildGate.mockResolvedValue({
      success: false,
      skipped: false,
      kind: "unity",
      errors: ["error CS1234: bad thing"],
      durationMs: 500,
    });
    const { session, channel, scopeId, initiatorId, channelMessages, channelComponents } =
      makeArgs();
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("failed");
    expect(result.kind).toBe("unity");
    // PR body updated with Build Errors section
    expect(mockUpdatePullRequest).toHaveBeenCalledOnce();
    const [, body] = mockUpdatePullRequest.mock.calls[0] as [number, string];
    expect(body).toContain("## Build Errors");
    expect(body).toContain("error CS1234: bad thing");
    // Discord message posted with auto-fix button
    expect(channelMessages.length).toBeGreaterThan(0);
    expect(channelMessages[0]).toContain("Build failed");
    expect(channelComponents.length).toBeGreaterThan(0);
  });

  it("swallows exceptions and returns 'skipped' so PR is not blocked", async () => {
    mockRunBuildGate.mockRejectedValue(new Error("unexpected crash"));
    const { session, channel, scopeId, initiatorId } = makeArgs();
    const result = await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(result.outcome).toBe("skipped");
    expect(result.kind).toBeNull();
    expect(mockUpdatePullRequest).not.toHaveBeenCalled();
  });

  it("does not post a Discord message when build is skipped (tool not installed)", async () => {
    mockDetectRepoKind.mockResolvedValue("ts");
    mockRunBuildGate.mockResolvedValue({
      success: true,
      skipped: true,
      kind: "ts",
      errors: [],
      durationMs: 0,
    });
    const { session, channel, scopeId, initiatorId, channelMessages } = makeArgs();
    await runBuildStep({ session, channel: channel as never, scopeId, initiatorId });
    expect(channelMessages).toHaveLength(0);
  });
});
