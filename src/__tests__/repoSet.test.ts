import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const { mockSetRepoBinding, mockGetRepoBinding, mockHasExplicitBinding } = vi.hoisted(() => ({
  mockSetRepoBinding: vi.fn(),
  mockGetRepoBinding: vi.fn(() => ({ owner: "acme", repo: "myapp" })),
  mockHasExplicitBinding: vi.fn(() => false),
}));

const { mockGetDefaultBranch, mockCheckBotIsCollaborator, mockAcceptRepoInvitations } = vi.hoisted(
  () => ({
    mockGetDefaultBranch: vi.fn(async () => ({ name: "main", sha: "abc" })),
    mockCheckBotIsCollaborator: vi.fn(async () => true),
    mockAcceptRepoInvitations: vi.fn(async () => {}),
  }),
);

vi.mock("../services/github", () => ({
  acceptRepoInvitations: mockAcceptRepoInvitations,
  describeBotAccount: vi.fn(async () => "`onyx-bot`"),
  createGithubClient: vi.fn(() => ({
    getDefaultBranch: mockGetDefaultBranch,
    checkBotIsCollaborator: mockCheckBotIsCollaborator,
  })),
}));

vi.mock("../services/repoStore", () => ({
  setRepoBinding: mockSetRepoBinding,
  getRepoBinding: mockGetRepoBinding,
  hasExplicitBinding: mockHasExplicitBinding,
  removeRepoBinding: vi.fn(),
}));

// Prevent disk I/O.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import repo from "../commands/repo";

function makeSetInteraction(owner = "acme", repoName = "myapp") {
  const editReply = vi.fn(async () => undefined) as Mock<() => Promise<undefined>>;
  const deferReply = vi.fn(async () => undefined) as Mock<() => Promise<undefined>>;
  return {
    options: {
      getSubcommand: () => "set",
      getString: (name: string, _req: boolean) => (name === "owner" ? owner : repoName),
    },
    channelId: "ch-test",
    deferReply,
    editReply,
    channel: undefined,
  } as unknown as Parameters<typeof repo.execute>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDefaultBranch.mockResolvedValue({ name: "main", sha: "abc" });
  mockCheckBotIsCollaborator.mockResolvedValue(true);
});

describe("/repo set validation", () => {
  it("binds the repo and replies with success when both checks pass", async () => {
    const i = makeSetInteraction();
    await repo.execute(i);
    expect(mockSetRepoBinding).toHaveBeenCalledWith("ch-test", { owner: "acme", repo: "myapp" });
    const msg = (i.editReply as Mock).mock.calls[0]![0] as string;
    expect(msg).toContain("✅");
    expect(msg).toContain("acme/myapp");
  });

  it("rejects and shows access error when getDefaultBranch throws", async () => {
    mockGetDefaultBranch.mockRejectedValue({ status: 404 });
    const i = makeSetInteraction();
    await repo.execute(i);
    expect(mockSetRepoBinding).not.toHaveBeenCalled();
    const msg = (i.editReply as Mock).mock.calls[0]![0] as string;
    expect(msg).toContain("❌");
    expect(msg).toContain("settings/access");
  });

  it("rejects with write-access message when repo is readable but bot lacks write permission", async () => {
    mockCheckBotIsCollaborator.mockResolvedValue(false);
    const i = makeSetInteraction();
    await repo.execute(i);
    expect(mockSetRepoBinding).not.toHaveBeenCalled();
    const msg = (i.editReply as Mock).mock.calls[0]![0] as string;
    expect(msg).toContain("write access");
    expect(msg).toContain("settings/access");
  });

  it("allows bind when checkBotIsCollaborator returns true (e.g. username unset = optimistic)", async () => {
    mockCheckBotIsCollaborator.mockResolvedValue(true);
    const i = makeSetInteraction();
    await repo.execute(i);
    expect(mockSetRepoBinding).toHaveBeenCalledOnce();
    const msg = (i.editReply as Mock).mock.calls[0]![0] as string;
    expect(msg).toContain("✅");
  });
});
