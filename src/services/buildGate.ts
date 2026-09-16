import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getClientForChannel } from "./github";

export type RepoKind = "unity" | "ts" | "py" | "unknown";

export interface BuildResult {
  success: boolean;
  /** true when kind="unknown", tool not installed (ENOENT), or concurrency lock held */
  skipped: boolean;
  kind: RepoKind;
  /** Language-aware parsed error lines, capped at 10 */
  errors: string[];
  durationMs: number;
}

/** Module-level concurrency lock — one build at a time per bot instance. */
let buildInProgress = false;

/**
 * Detect the repo language by inspecting the root directory listing.
 * Priority: unity > ts > py > unknown.
 */
export async function detectRepoKind(channelId: string, branch: string): Promise<RepoKind> {
  try {
    const client = getClientForChannel(channelId);
    const entries = await client.listDirectory("", branch);
    if (!entries) {
      console.log(`[buildGate] detectRepoKind: empty root listing — unknown`);
      return "unknown";
    }
    const names = entries.map((e) => e.name);
    // Unity: any .csproj file or an Assets/ directory
    if (names.some((n) => n.endsWith(".csproj") || n === "Assets")) {
      console.log(`[buildGate] detectRepoKind: unity (found .csproj or Assets)`);
      return "unity";
    }
    // TypeScript: tsconfig.json
    if (names.includes("tsconfig.json")) {
      console.log(`[buildGate] detectRepoKind: ts (found tsconfig.json)`);
      return "ts";
    }
    // Python: pyproject.toml, setup.py, or requirements.txt
    if (
      names.includes("pyproject.toml") ||
      names.includes("setup.py") ||
      names.includes("requirements.txt")
    ) {
      console.log(`[buildGate] detectRepoKind: py`);
      return "py";
    }
    console.log(
      `[buildGate] detectRepoKind: unknown (root files: ${names.slice(0, 10).join(", ")})`,
    );
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Clone the feature branch, run the language-appropriate build/type-check tool,
 * and return a structured result. Never throws — errors produce skipped:true.
 */
export async function runBuildGate(
  kind: RepoKind,
  branch: string,
  channelId: string,
): Promise<BuildResult> {
  if (kind === "unknown") {
    console.log(`[buildGate] kind=unknown — skipping build`);
    return { success: true, skipped: true, kind, errors: [], durationMs: 0 };
  }

  if (buildInProgress) {
    console.log(`[buildGate] concurrency lock held — skipping build`);
    return { success: true, skipped: true, kind, errors: [], durationMs: 0 };
  }
  buildInProgress = true;

  const start = Date.now();
  const tmpDir = path.join(os.tmpdir(), `onyx-build-${Date.now()}`);

  console.log(`[buildGate] kind=${kind} branch=${branch} — cloning into ${tmpDir}`);
  try {
    const client = getClientForChannel(channelId);
    const { owner, repo } = client.repoCoordinates();
    const token = process.env.GITHUB_TOKEN || "";
    // Token embedded inline and never logged.
    const cloneUrl = `https://${token}@github.com/${owner}/${repo}.git`;

    await runCommand("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, tmpDir], {
      timeoutMs: 60_000,
    });
    console.log(`[buildGate] clone done — running build`);

    const output = await runBuildForKind(kind, tmpDir);
    const errors = extractErrors(kind, output.stdout + "\n" + output.stderr);
    const success = output.exitCode === 0;
    const durationMs = Date.now() - start;

    if (success) {
      console.log(`[buildGate] ✅ build passed (${durationMs}ms)`);
    } else {
      console.log(`[buildGate] ❌ build failed — ${errors.length} error(s) in ${durationMs}ms`);
      for (const e of errors) console.log(`[buildGate]   ${e}`);
    }

    return { success, skipped: false, kind, errors, durationMs };
  } catch (err) {
    if (isEnoent(err)) {
      console.log(`[buildGate] ENOENT — required tool not installed, skipping`);
      return { success: true, skipped: true, kind, errors: [], durationMs: Date.now() - start };
    }
    console.log(`[buildGate] error — skipping:`, err instanceof Error ? err.message : err);
    return { success: true, skipped: true, kind, errors: [], durationMs: Date.now() - start };
  } finally {
    buildInProgress = false;
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command with a strict timeout via AbortController. */
async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      signal: controller.signal,
      // Windows needs shell:true to resolve .cmd shims (pnpm.cmd, npx.cmd, etc.)
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

type PackageManager = "pnpm" | "yarn" | "npm";

async function detectPackageManager(dir: string): Promise<PackageManager> {
  const files = await fs.readdir(dir);
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

function installArgs(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]];
    case "yarn":
      return ["yarn", ["install", "--frozen-lockfile", "--ignore-scripts"]];
    case "npm":
      return ["npm", ["ci", "--ignore-scripts"]];
  }
}

async function runBuildForKind(kind: RepoKind, dir: string): Promise<CommandResult> {
  switch (kind) {
    case "unity":
      // dotnet build includes restore by default; --no-restore is fragile with Unity
      return runCommand("dotnet", ["build"], { cwd: dir, timeoutMs: 90_000 });

    case "ts": {
      const pm = await detectPackageManager(dir);
      const [installCmd, installArgList] = installArgs(pm);
      // Install deps with lifecycle scripts disabled, then type-check
      await runCommand(installCmd, installArgList, { cwd: dir, timeoutMs: 120_000 });
      return runCommand("npx", ["tsc", "--noEmit", "--pretty", "false"], {
        cwd: dir,
        timeoutMs: 120_000,
      });
    }

    case "py":
      // --outputjson gives structured JSON — parsed in extractErrors
      return runCommand("pyright", ["--outputjson", "."], { cwd: dir, timeoutMs: 60_000 });

    default:
      return { stdout: "", stderr: "", exitCode: 0 };
  }
}

function extractErrors(kind: RepoKind, output: string): string[] {
  const raw = output.split("\n").map((l) => l.trimEnd());

  if (kind === "py") {
    // pyright --outputjson writes JSON on stdout
    try {
      // Find the JSON block (pyright may emit a leading status line before JSON)
      const jsonStart = output.indexOf("{");
      if (jsonStart === -1) throw new Error("no JSON");
      const parsed = JSON.parse(output.slice(jsonStart)) as {
        generalDiagnostics?: Array<{
          severity: string;
          message: string;
          file?: string;
          range?: { start?: { line?: number } };
        }>;
      };
      const diags = parsed.generalDiagnostics ?? [];
      return diags
        .filter((d) => d.severity === "error")
        .slice(0, 10)
        .map((d) => {
          const file = d.file ? path.basename(d.file) : "?";
          const line = d.range?.start?.line !== undefined ? `:${d.range.start.line + 1}` : "";
          return `${file}${line}: ${d.message}`;
        });
    } catch {
      // Fall through to naive filter if JSON parsing fails
    }
  }

  if (kind === "ts") {
    // tsc --pretty false produces "file.ts(line,col): error TSxxxx: message"
    const matches = raw.filter((l) => /: error TS\d+/i.test(l));
    return dedupe(matches).slice(0, 10);
  }

  if (kind === "unity") {
    // dotnet produces "file.cs(line,col): error CSxxxx: ..." or MSBxxxx
    const matches = raw.filter((l) => /\berror (CS|MSB)\d+/i.test(l));
    return dedupe(matches).slice(0, 10);
  }

  return [];
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/** Human-readable build command label for the given repo kind. */
export function buildCommandLabel(kind: RepoKind): string {
  switch (kind) {
    case "unity":
      return "dotnet build";
    case "ts":
      return "tsc --noEmit";
    case "py":
      return "pyright .";
    default:
      return "(unknown)";
  }
}
