import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock functions so they can be used inside the vi.mock factory (which is hoisted).
const {
  mockGetCollaboratorPermissionLevel,
  mockCreateRef,
  mockReposGet,
  mockGetBranch,
  mockGetAuthenticated,
} = vi.hoisted(() => ({
  mockGetCollaboratorPermissionLevel: vi.fn(),
  mockCreateRef: vi.fn(),
  mockReposGet: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetAuthenticated: vi.fn(),
}));

// Mock Octokit as a class so `new Octokit(...)` works.
vi.mock("@octokit/rest", () => {
  class MockOctokit {
    repos = {
      get: mockReposGet,
      getBranch: mockGetBranch,
      getCollaboratorPermissionLevel: mockGetCollaboratorPermissionLevel,
    };
    git = {
      createRef: mockCreateRef,
    };
    users = {
      getAuthenticated: mockGetAuthenticated,
    };
  }
  return { Octokit: MockOctokit };
});

// Prevent disk I/O from repoStore module initialization.
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

import {
  _resetBotLoginForTesting,
  createGithubClient,
  describeBotAccount,
  getBotLogin,
  GithubWriteAccessError,
} from "../services/github";

beforeEach(() => {
  vi.clearAllMocks();
  _resetBotLoginForTesting();
  process.env["GITHUB_BOT_USERNAME"] = "onyx-bot";
});

afterEach(() => {
  delete process.env["GITHUB_BOT_USERNAME"];
});

describe("checkBotIsCollaborator", () => {
  const client = () => createGithubClient("acme", "myapp");

  it("returns true when permission is 'write'", async () => {
    mockGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "write" } });
    expect(await client().checkBotIsCollaborator()).toBe(true);
  });

  it("returns true when permission is 'admin'", async () => {
    mockGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "admin" } });
    expect(await client().checkBotIsCollaborator()).toBe(true);
  });

  it("returns false when permission is 'read'", async () => {
    mockGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "read" } });
    expect(await client().checkBotIsCollaborator()).toBe(false);
  });

  it("returns false on 404 (not a collaborator) without throwing", async () => {
    mockGetCollaboratorPermissionLevel.mockRejectedValue({ status: 404 });
    await expect(client().checkBotIsCollaborator()).resolves.toBe(false);
  });

  it("returns false on 403 (forbidden) without throwing", async () => {
    mockGetCollaboratorPermissionLevel.mockRejectedValue({ status: 403 });
    await expect(client().checkBotIsCollaborator()).resolves.toBe(false);
  });

  it("rethrows unexpected errors (e.g. 500)", async () => {
    mockGetCollaboratorPermissionLevel.mockRejectedValue({ status: 500 });
    await expect(client().checkBotIsCollaborator()).rejects.toMatchObject({ status: 500 });
  });

  it("checks the login from GET /user when GITHUB_BOT_USERNAME is not set", async () => {
    delete process.env["GITHUB_BOT_USERNAME"];
    mockGetAuthenticated.mockResolvedValue({ data: { login: "self-hosted-bot" } });
    mockGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "write" } });
    expect(await client().checkBotIsCollaborator()).toBe(true);
    expect(mockGetCollaboratorPermissionLevel).toHaveBeenCalledWith(
      expect.objectContaining({ username: "self-hosted-bot" }),
    );
  });

  it("returns true (optimistic) when the login cannot be determined", async () => {
    delete process.env["GITHUB_BOT_USERNAME"];
    mockGetAuthenticated.mockRejectedValue({ status: 401 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await client().checkBotIsCollaborator()).toBe(true);
    expect(mockGetCollaboratorPermissionLevel).not.toHaveBeenCalled();
  });
});

describe("getBotLogin / describeBotAccount", () => {
  it("prefers the GITHUB_BOT_USERNAME override without calling the API", async () => {
    expect(await getBotLogin()).toBe("onyx-bot");
    expect(mockGetAuthenticated).not.toHaveBeenCalled();
  });

  it("looks the login up once and caches it", async () => {
    delete process.env["GITHUB_BOT_USERNAME"];
    mockGetAuthenticated.mockResolvedValue({ data: { login: "my-bot" } });
    expect(await getBotLogin()).toBe("my-bot");
    expect(await getBotLogin()).toBe("my-bot");
    expect(mockGetAuthenticated).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed lookup instead of caching the failure", async () => {
    delete process.env["GITHUB_BOT_USERNAME"];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetAuthenticated.mockRejectedValueOnce({ status: 500 });
    expect(await getBotLogin()).toBeNull();
    mockGetAuthenticated.mockResolvedValue({ data: { login: "my-bot" } });
    expect(await getBotLogin()).toBe("my-bot");
  });

  it("labels the account by login, or generically when unknown", async () => {
    expect(await describeBotAccount()).toBe("`onyx-bot`");
    delete process.env["GITHUB_BOT_USERNAME"];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetAuthenticated.mockRejectedValue({ status: 401 });
    expect(await describeBotAccount()).toBe("the bot's GitHub account");
  });
});

describe("createBranch error handling", () => {
  const client = () => createGithubClient("acme", "myapp");

  it("throws GithubWriteAccessError when git.createRef returns 404", async () => {
    mockCreateRef.mockRejectedValue({ status: 404 });
    await expect(client().createBranch("onyx/feat-1", "abc123")).rejects.toThrow(
      GithubWriteAccessError,
    );
  });

  it("GithubWriteAccessError message contains the settings URL", async () => {
    mockCreateRef.mockRejectedValue({ status: 404 });
    await expect(client().createBranch("onyx/feat-1", "abc123")).rejects.toThrow("settings/access");
  });

  it("rethrows non-404 errors unchanged", async () => {
    mockCreateRef.mockRejectedValue({ status: 422 });
    await expect(client().createBranch("onyx/feat-1", "abc123")).rejects.toMatchObject({
      status: 422,
    });
  });

  it("resolves without error when createRef succeeds", async () => {
    mockCreateRef.mockResolvedValue({});
    await expect(client().createBranch("onyx/feat-1", "abc123")).resolves.toBeUndefined();
  });
});

describe("GithubWriteAccessError", () => {
  it("has the expected name, message, and is an Error instance", () => {
    const err = new GithubWriteAccessError("owner", "repo");
    expect(err.name).toBe("GithubWriteAccessError");
    expect(err.message).toContain("owner/repo");
    expect(err.message).toContain("settings/access");
    expect(err.message).toContain("/repo set owner:owner repo:repo");
    expect(err).toBeInstanceOf(Error);
  });

  it("names the bot account when its login is known", () => {
    expect(new GithubWriteAccessError("o", "r", "my-bot").message).toMatch(/^`my-bot` does not/);
    expect(new GithubWriteAccessError("o", "r", null).message).toMatch(/^The bot's GitHub account/);
  });
});
