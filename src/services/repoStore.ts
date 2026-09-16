import fs from "fs";
import { DATA_DIR, dataFile } from "../utils/dataDir";
import path from "path";

/** Repo coordinates bound to a Discord channel via `/repo set`. */
export interface RepoBinding {
  owner: string;
  repo: string;
}

const BINDINGS_FILE = dataFile("channel-repos.json");

const bindings = new Map<string, RepoBinding>();

/**
 * Return the repo binding for a channel. Falls back to `GITHUB_OWNER` /
 * `GITHUB_REPO` env defaults when no explicit binding has been set.
 */
export function getRepoBinding(channelId: string): RepoBinding {
  return (
    bindings.get(channelId) ?? {
      owner: (process.env.GITHUB_OWNER || "").trim(),
      repo: (process.env.GITHUB_REPO || "").trim(),
    }
  );
}

/** Bind a channel to a specific repo and persist to disk. */
export function setRepoBinding(channelId: string, binding: RepoBinding): void {
  bindings.set(channelId, binding);
  saveBindings();
}

/** Return true when this channel has an explicit binding (not just env defaults). */
export function hasExplicitBinding(channelId: string): boolean {
  return bindings.has(channelId);
}

/** Remove an explicit binding, reverting to env defaults. */
export function removeRepoBinding(channelId: string): void {
  bindings.delete(channelId);
  saveBindings();
}

/** Load bindings from `data/channel-repos.json` on startup. */
export function loadBindings(): void {
  try {
    if (!fs.existsSync(BINDINGS_FILE)) return;
    const raw = fs.readFileSync(BINDINGS_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, RepoBinding>;
    for (const [channelId, binding] of Object.entries(data)) {
      bindings.set(channelId, binding);
    }
  } catch {
    console.warn("[repoStore] Failed to load bindings, starting fresh.");
  }
}

function saveBindings(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data: Record<string, RepoBinding> = {};
    for (const [channelId, binding] of bindings) {
      data[channelId] = binding;
    }
    const tmp = `${BINDINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, BINDINGS_FILE);
  } catch (err) {
    console.error("[repoStore] Failed to save bindings:", err);
  }
}

/** Test-only: wipe all in-memory bindings without touching disk. */
export function _resetBindingsForTesting(): void {
  bindings.clear();
}
