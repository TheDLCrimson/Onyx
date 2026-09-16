import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryEntry } from "../services/github";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories are hoisted so variables must be too
// ---------------------------------------------------------------------------

const { mockSpawn, mockListDirectory, mockRepoCoordinates, mockReaddir, mockRm } = vi.hoisted(
  () => ({
    mockSpawn: vi.fn(),
    mockListDirectory: vi.fn<() => Promise<DirectoryEntry[] | null>>(),
    mockRepoCoordinates: vi.fn(() => ({ owner: "test-owner", repo: "test-repo" })),
    mockReaddir: vi.fn<() => Promise<string[]>>(),
    mockRm: vi.fn<() => Promise<void>>(),
  }),
);

vi.mock("../services/github", () => ({
  getClientForChannel: vi.fn(() => ({
    listDirectory: mockListDirectory,
    repoCoordinates: mockRepoCoordinates,
  })),
}));

vi.mock("child_process", () => ({ spawn: mockSpawn }));

vi.mock("fs/promises", () => ({
  readdir: mockReaddir,
  rm: mockRm,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { EventEmitter } from "events";

function makeProcess(stdout: string, stderr: string, exitCode: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // Emit data + close on next tick so the promise has a chance to register listeners.
  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from(stdout));
    proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  });
  return proc;
}

function dir(names: string[]): DirectoryEntry[] {
  return names.map((name) => ({ name, type: "file" as const, path: name }));
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { detectRepoKind, runBuildGate } from "../services/buildGate";

// ---------------------------------------------------------------------------
// detectRepoKind
// ---------------------------------------------------------------------------

describe("detectRepoKind", () => {
  beforeEach(() => {
    mockListDirectory.mockReset();
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
  });

  it("detects .csproj as unity", async () => {
    mockListDirectory.mockResolvedValue(dir(["Game.csproj", "README.md"]));
    expect(await detectRepoKind("ch", "main")).toBe("unity");
  });

  it("detects Assets/ entry as unity", async () => {
    mockListDirectory.mockResolvedValue(dir(["Assets", "Packages", "ProjectSettings"]));
    expect(await detectRepoKind("ch", "main")).toBe("unity");
  });

  it("detects tsconfig.json as ts", async () => {
    mockListDirectory.mockResolvedValue(dir(["package.json", "tsconfig.json", "src"]));
    expect(await detectRepoKind("ch", "main")).toBe("ts");
  });

  it("detects pyproject.toml as py", async () => {
    mockListDirectory.mockResolvedValue(dir(["pyproject.toml", "src"]));
    expect(await detectRepoKind("ch", "main")).toBe("py");
  });

  it("detects requirements.txt as py", async () => {
    mockListDirectory.mockResolvedValue(dir(["requirements.txt", "main.py"]));
    expect(await detectRepoKind("ch", "main")).toBe("py");
  });

  it("returns unknown when no known config files present", async () => {
    mockListDirectory.mockResolvedValue(dir(["README.md", "Makefile"]));
    expect(await detectRepoKind("ch", "main")).toBe("unknown");
  });

  it("returns unknown when listing returns null", async () => {
    mockListDirectory.mockResolvedValue(null);
    expect(await detectRepoKind("ch", "main")).toBe("unknown");
  });

  it("unity takes priority over ts when both signals present", async () => {
    mockListDirectory.mockResolvedValue(dir(["Game.csproj", "tsconfig.json"]));
    expect(await detectRepoKind("ch", "main")).toBe("unity");
  });
});

// ---------------------------------------------------------------------------
// runBuildGate
// ---------------------------------------------------------------------------

describe("runBuildGate", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(["package-lock.json"]);
    // Default: git clone succeeds
    mockSpawn.mockReturnValue(makeProcess("", "", 0));
    // Reset module-level concurrency lock between tests by resetting mocks
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips immediately for kind=unknown", async () => {
    const result = await runBuildGate("unknown", "branch", "ch");
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips and returns success on ENOENT (tool not installed)", async () => {
    // git clone succeeds, dotnet ENOENT
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeProcess("", "", 0); // git clone
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() =>
        proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );
      return proc;
    });

    const result = await runBuildGate("unity", "feat", "ch");
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(true);
  });

  it("returns success: true when build exits 0 (unity)", async () => {
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess("Build succeeded.", "", 0)); // dotnet build

    const result = await runBuildGate("unity", "feat", "ch");
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.kind).toBe("unity");
  });

  it("returns success: false with extracted errors when build exits 1 (unity)", async () => {
    const dotnetOutput =
      "error CS1234: Type 'Foo' not found\n" +
      "error CS5678: Missing semicolon\n" +
      "Build FAILED.";
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess(dotnetOutput, "", 1)); // dotnet build

    const result = await runBuildGate("unity", "feat", "ch");
    expect(result.success).toBe(false);
    expect(result.errors).toContain("error CS1234: Type 'Foo' not found");
    expect(result.errors).toContain("error CS5678: Missing semicolon");
    expect(result.errors).not.toContain("Build FAILED.");
  });

  it("extracts tsc errors matching /: error TSd+/ (ts)", async () => {
    const tscOutput =
      "src/index.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n" +
      "src/util.ts(3,1): error TS2304: Cannot find name 'foo'.\n" +
      "Found 2 errors.";
    // ts: git clone, npm ci, tsc --noEmit
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess("", "", 0)) // npm ci
      .mockReturnValueOnce(makeProcess(tscOutput, "", 1)); // tsc

    const result = await runBuildGate("ts", "feat", "ch");
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("TS2345"))).toBe(true);
    expect(result.errors.some((e) => e.includes("TS2304"))).toBe(true);
    expect(result.errors).not.toContain("Found 2 errors.");
  });

  it("caps extracted errors at 10 lines", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `error CS${i}: msg ${i}`).join("\n");
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess(lines, "", 1)); // dotnet build

    const result = await runBuildGate("unity", "feat", "ch");
    expect(result.errors.length).toBeLessThanOrEqual(10);
  });

  it("parses pyright --outputjson output (py)", async () => {
    const pyrightJson = JSON.stringify({
      generalDiagnostics: [
        {
          severity: "error",
          message: "Type mismatch",
          file: "/tmp/repo/main.py",
          range: { start: { line: 4 } },
        },
        {
          severity: "warning",
          message: "Unused import",
          file: "/tmp/repo/main.py",
          range: { start: { line: 1 } },
        },
        {
          severity: "error",
          message: "Cannot access member",
          file: "/tmp/repo/util.py",
          range: { start: { line: 12 } },
        },
      ],
    });
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess(pyrightJson, "", 1)); // pyright

    const result = await runBuildGate("py", "feat", "ch");
    expect(result.success).toBe(false);
    // Only error-severity diagnostics included (not warnings)
    expect(result.errors.some((e) => e.includes("Type mismatch"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Cannot access member"))).toBe(true);
    expect(result.errors).not.toContain(expect.stringContaining("Unused import"));
  });

  it("falls back to empty errors on malformed pyright JSON", async () => {
    mockSpawn
      .mockReturnValueOnce(makeProcess("", "", 0)) // git clone
      .mockReturnValueOnce(makeProcess("not-json-output", "", 1)); // pyright

    const result = await runBuildGate("py", "feat", "ch");
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(0); // no parseable errors
  });

  it("uses npm ci when package-lock.json is present", async () => {
    mockReaddir.mockResolvedValue(["package-lock.json"]);
    const spawnCalls: string[] = [];
    mockSpawn.mockImplementation((cmd: string) => {
      spawnCalls.push(cmd);
      return makeProcess("", "", 0);
    });

    await runBuildGate("ts", "feat", "ch");
    expect(spawnCalls).toContain("npm");
  });

  it("uses pnpm install when pnpm-lock.yaml is present", async () => {
    mockReaddir.mockResolvedValue(["pnpm-lock.yaml"]);
    const spawnCalls: string[] = [];
    mockSpawn.mockImplementation((cmd: string) => {
      spawnCalls.push(cmd);
      return makeProcess("", "", 0);
    });

    await runBuildGate("ts", "feat", "ch");
    expect(spawnCalls).toContain("pnpm");
  });
});
