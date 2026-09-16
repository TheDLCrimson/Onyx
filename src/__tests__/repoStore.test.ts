import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBindingsForTesting,
  getRepoBinding,
  hasExplicitBinding,
  removeRepoBinding,
  setRepoBinding,
} from "../services/repoStore";

// Prevent actual disk I/O in unit tests.
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

beforeEach(() => {
  _resetBindingsForTesting();
  // Reset env defaults between tests.
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
});

afterEach(() => {
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
});

describe("getRepoBinding", () => {
  it("returns env defaults when no explicit binding exists", () => {
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "api";
    const binding = getRepoBinding("ch-1");
    expect(binding).toEqual({ owner: "acme", repo: "api" });
  });

  it("returns empty strings when no env vars and no binding", () => {
    const binding = getRepoBinding("ch-1");
    expect(binding).toEqual({ owner: "", repo: "" });
  });

  it("returns the explicit binding over env defaults", () => {
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "api";
    setRepoBinding("ch-1", { owner: "user1", repo: "myapp" });
    const binding = getRepoBinding("ch-1");
    expect(binding).toEqual({ owner: "user1", repo: "myapp" });
  });

  it("different channels are isolated", () => {
    setRepoBinding("ch-1", { owner: "alice", repo: "proj-a" });
    setRepoBinding("ch-2", { owner: "bob", repo: "proj-b" });
    expect(getRepoBinding("ch-1")).toEqual({ owner: "alice", repo: "proj-a" });
    expect(getRepoBinding("ch-2")).toEqual({ owner: "bob", repo: "proj-b" });
  });
});

describe("setRepoBinding", () => {
  it("persists and can be retrieved", () => {
    setRepoBinding("ch-42", { owner: "org", repo: "svc" });
    expect(getRepoBinding("ch-42")).toEqual({ owner: "org", repo: "svc" });
  });
});

describe("removeRepoBinding", () => {
  it("falls back to env defaults after removal", () => {
    process.env.GITHUB_OWNER = "default-owner";
    process.env.GITHUB_REPO = "default-repo";
    setRepoBinding("ch-1", { owner: "custom", repo: "repo" });
    removeRepoBinding("ch-1");
    expect(getRepoBinding("ch-1")).toEqual({
      owner: "default-owner",
      repo: "default-repo",
    });
  });

  it("removing a non-existent binding is a no-op", () => {
    expect(() => removeRepoBinding("ch-999")).not.toThrow();
  });
});

describe("hasExplicitBinding", () => {
  it("returns false when no binding exists (even with env defaults)", () => {
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "api";
    expect(hasExplicitBinding("ch-1")).toBe(false);
  });

  it("returns true once a binding is set", () => {
    setRepoBinding("ch-1", { owner: "user1", repo: "myapp" });
    expect(hasExplicitBinding("ch-1")).toBe(true);
  });

  it("returns false after the binding is removed", () => {
    setRepoBinding("ch-1", { owner: "user1", repo: "myapp" });
    removeRepoBinding("ch-1");
    expect(hasExplicitBinding("ch-1")).toBe(false);
  });

  it("different channels are isolated", () => {
    setRepoBinding("ch-1", { owner: "alice", repo: "proj-a" });
    expect(hasExplicitBinding("ch-1")).toBe(true);
    expect(hasExplicitBinding("ch-2")).toBe(false);
  });
});
