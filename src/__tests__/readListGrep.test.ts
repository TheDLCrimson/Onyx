import { beforeEach, describe, expect, it, vi } from "vitest";
import { grepTool, isSearchUnavailable, listTool, readTool } from "../services/readTools";
import type { ToolContext } from "../services/tools";
import { TOOL_RESULT_PAGE_SIZE } from "../services/tools";

const mockClient = {
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  searchCode: vi.fn(),
};

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => mockClient),
}));

const PR_CTX: ToolContext = { mode: "pr", channelId: "ch-1" };
const BRANCH_CTX: ToolContext = {
  mode: "pr",
  activeBranch: "onyx/feat-1",
  channelId: "ch-1",
};

beforeEach(() => {
  mockClient.readFile.mockReset();
  mockClient.listDirectory.mockReset();
  mockClient.searchCode.mockReset();
});

describe("readTool", () => {
  it("returns JSON with content for a small file", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "a.ts",
      content: "// hi\n",
      sha: "deadbeef",
    });
    const raw = await readTool.execute({ path: "a.ts" }, PR_CTX);
    const out = JSON.parse(raw);
    expect(out.content).toBe("// hi\n");
    expect(out._truncated).toBe(false);
    expect(out.read_complete).toBe(true);
    expect(out.bytes_remaining).toBe(0);
    expect(mockClient.readFile).toHaveBeenCalledWith("a.ts", undefined);
  });

  it("threads activeBranch into readFile", async () => {
    mockClient.readFile.mockResolvedValue({ path: "a.ts", content: "x", sha: "s" });
    await readTool.execute({ path: "a.ts" }, BRANCH_CTX);
    expect(mockClient.readFile).toHaveBeenCalledWith("a.ts", "onyx/feat-1");
  });

  it("throws when the file is missing", async () => {
    mockClient.readFile.mockResolvedValue(null);
    await expect(readTool.execute({ path: "x" }, PR_CTX)).rejects.toThrow(/not found/);
  });

  it("throws when path is missing or wrong type", async () => {
    await expect(readTool.execute({}, PR_CTX)).rejects.toThrow(/path.*string/);
  });

  it("populates total_lines correctly for a multi-line file", async () => {
    mockClient.readFile.mockResolvedValue({
      path: "a.ts",
      content: "a\nb\nc\n",
      sha: "s",
    });
    const out = JSON.parse(await readTool.execute({ path: "a.ts" }, PR_CTX));
    expect(out.total_lines).toBe(4); // "a\nb\nc\n".split("\n") has 4 parts
  });

  it("returns offset=0 and next_offset=content.length for a small file", async () => {
    const content = "hello world";
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content, sha: "s" });
    const out = JSON.parse(await readTool.execute({ path: "f.ts" }, PR_CTX));
    expect(out.offset).toBe(0);
    expect(out.next_offset).toBe(content.length);
  });

  it("is not truncated when file is exactly TOOL_RESULT_PAGE_SIZE chars", async () => {
    const content = "x".repeat(TOOL_RESULT_PAGE_SIZE);
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content, sha: "s" });
    const out = JSON.parse(await readTool.execute({ path: "f.ts" }, PR_CTX));
    expect(out._truncated).toBe(false);
    expect(out.read_complete).toBe(true);
    expect(out.bytes_remaining).toBe(0);
    expect(out.content.length).toBe(TOOL_RESULT_PAGE_SIZE);
  });

  it("truncates when file exceeds TOOL_RESULT_PAGE_SIZE chars", async () => {
    const content = "y".repeat(TOOL_RESULT_PAGE_SIZE + 500);
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content, sha: "s" });
    const out = JSON.parse(await readTool.execute({ path: "f.ts" }, PR_CTX));
    expect(out._truncated).toBe(true);
    expect(out.read_complete).toBe(false);
    expect(out.bytes_remaining).toBe(500);
    expect(out.content.length).toBe(TOOL_RESULT_PAGE_SIZE);
    expect(out.next_offset).toBe(TOOL_RESULT_PAGE_SIZE);
  });

  it("second Read with next_offset returns the remainder", async () => {
    const first = "A".repeat(TOOL_RESULT_PAGE_SIZE);
    const second = "B".repeat(300);
    const content = first + second;
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content, sha: "s" });

    const page1 = JSON.parse(await readTool.execute({ path: "f.ts" }, PR_CTX));
    expect(page1._truncated).toBe(true);

    const page2 = JSON.parse(
      await readTool.execute({ path: "f.ts", offset: page1.next_offset }, PR_CTX),
    );
    expect(page2.content).toBe(second);
    expect(page2._truncated).toBe(false);
    expect(page2.read_complete).toBe(true);
    expect(page2.bytes_remaining).toBe(0);
  });

  it("offset beyond file end returns empty content and read_complete: true", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "short", sha: "s" });
    const out = JSON.parse(await readTool.execute({ path: "f.ts", offset: 9999 }, PR_CTX));
    expect(out.content).toBe("");
    expect(out._truncated).toBe(false);
    expect(out.read_complete).toBe(true);
    expect(out.bytes_remaining).toBe(0);
  });

  it("missing offset defaults to 0", async () => {
    mockClient.readFile.mockResolvedValue({ path: "f.ts", content: "abc", sha: "s" });
    const out = JSON.parse(await readTool.execute({ path: "f.ts" }, PR_CTX));
    expect(out.offset).toBe(0);
  });
});

describe("listTool", () => {
  it("returns one path<TAB>type line per entry", async () => {
    mockClient.listDirectory.mockResolvedValue([
      { name: "a.ts", path: "src/a.ts", type: "file" },
      { name: "util", path: "src/util", type: "dir" },
    ]);
    const out = await listTool.execute({ path: "src" }, PR_CTX);
    expect(out).toBe("src/a.ts\tfile\nsrc/util\tdir");
  });

  it("renders empty directories explicitly", async () => {
    mockClient.listDirectory.mockResolvedValue([]);
    const out = await listTool.execute({ path: "empty" }, PR_CTX);
    expect(out).toBe("(empty directory)");
  });

  it("throws on missing directory", async () => {
    mockClient.listDirectory.mockResolvedValue(null);
    await expect(listTool.execute({ path: "nope" }, PR_CTX)).rejects.toThrow(/not found/);
  });

  it("threads activeBranch into listDirectory", async () => {
    mockClient.listDirectory.mockResolvedValue([]);
    await listTool.execute({ path: "src" }, BRANCH_CTX);
    expect(mockClient.listDirectory).toHaveBeenCalledWith("src", "onyx/feat-1");
  });
});

describe("grepTool", () => {
  it("returns one path<TAB>url line per match", async () => {
    mockClient.searchCode.mockResolvedValue([
      { path: "src/a.ts", url: "https://github.com/o/r/blob/main/src/a.ts" },
      { path: "src/b.ts", url: "https://github.com/o/r/blob/main/src/b.ts" },
    ]);
    const out = await grepTool.execute({ query: "useState" }, PR_CTX);
    expect(out).toContain("src/a.ts\thttps://github.com/o/r/blob/main/src/a.ts");
    expect(out).toContain("src/b.ts\thttps://github.com/o/r/blob/main/src/b.ts");
  });

  it("renders no-match runs explicitly", async () => {
    mockClient.searchCode.mockResolvedValue([]);
    const out = await grepTool.execute({ query: "zzz" }, PR_CTX);
    expect(out).toContain("(no matches)");
  });

  it("clamps limit to [1, 50]", async () => {
    mockClient.searchCode.mockResolvedValue([]);
    await grepTool.execute({ query: "x", limit: 999 }, PR_CTX);
    expect(mockClient.searchCode).toHaveBeenCalledWith("x", 50);
    await grepTool.execute({ query: "x", limit: 0 }, PR_CTX);
    expect(mockClient.searchCode).toHaveBeenLastCalledWith("x", 1);
  });

  it("defaults limit to 20", async () => {
    mockClient.searchCode.mockResolvedValue([]);
    await grepTool.execute({ query: "x" }, PR_CTX);
    expect(mockClient.searchCode).toHaveBeenCalledWith("x", 20);
  });
});

describe("Grep — search unavailable vs no matches", () => {
  it("treats a 403 as 'search refused', not as missing code", async () => {
    mockClient.searchCode.mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 403 }),
    );
    await expect(grepTool.execute({ query: "uptime" }, PR_CTX)).rejects.toThrow(/rate limit/i);
    await expect(grepTool.execute({ query: "uptime" }, PR_CTX)).rejects.toThrow(
      /says nothing about whether the code exists/i,
    );
  });

  it("rethrows unrelated errors untouched", async () => {
    mockClient.searchCode.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await expect(grepTool.execute({ query: "uptime" }, PR_CTX)).rejects.toThrow("boom");
  });

  it("warns that an empty result is not proof of absence", async () => {
    mockClient.searchCode.mockResolvedValue([]);
    const out = await grepTool.execute({ query: "uptime" }, PR_CTX);
    expect(out).toContain("(no matches)");
    expect(out).toContain("lags recent pushes");
    expect(out).toContain("Confirm with List or Read");
  });
});

describe("isSearchUnavailable()", () => {
  it("is true for the rate-limit statuses only", () => {
    expect(isSearchUnavailable({ status: 403 })).toBe(true);
    expect(isSearchUnavailable({ status: 429 })).toBe(true);
    expect(isSearchUnavailable({ status: 404 })).toBe(false);
    expect(isSearchUnavailable(new Error("plain"))).toBe(false);
    expect(isSearchUnavailable(null)).toBe(false);
  });
});
