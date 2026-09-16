import { Octokit } from "@octokit/rest";
import type { PullRequestResult, RepoFile } from "../types";
import { getRepoBinding } from "./repoStore";

/** One entry returned by `listDirectory` — a file or subdirectory. */
export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** One match returned by `searchCode`. */
export interface CodeSearchMatch {
  path: string;
  /** Web URL on github.com. */
  url: string;
}

/** State of a PR for revalidation purposes. */
export interface PullRequestState {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  url: string;
}

/**
 * Thrown when the bot lacks write permission to perform a GitHub write operation.
 * The message includes an actionable link so the error propagates cleanly to Discord.
 */
export class GithubWriteAccessError extends Error {
  constructor(owner: string, repo: string, botLogin?: string | null) {
    super(
      `${botLabel(botLogin ?? null, "The bot's GitHub account")} does not have write access to \`${owner}/${repo}\`. ` +
        `Invite it as a collaborator at https://github.com/${owner}/${repo}/settings/access ` +
        `then re-run \`/repo set owner:${owner} repo:${repo}\`.`,
    );
    this.name = "GithubWriteAccessError";
  }
}

let botLoginPromise: Promise<string | null> | null = null;

/**
 * GitHub login of the account behind `GITHUB_TOKEN` — the identity Onyx
 * commits and opens PRs as. `GITHUB_BOT_USERNAME` overrides; otherwise the
 * login is looked up once via `GET /user` and cached. Resolves to null when
 * the lookup fails (the next call retries).
 */
export function getBotLogin(): Promise<string | null> {
  const override = (process.env.GITHUB_BOT_USERNAME || "").trim();
  if (override) return Promise.resolve(override);
  if (!botLoginPromise) botLoginPromise = lookupBotLogin();
  return botLoginPromise;
}

async function lookupBotLogin(): Promise<string | null> {
  const token = (process.env.GITHUB_TOKEN || "").trim();
  if (!token) return null;
  try {
    const res = await new Octokit({ auth: token }).users.getAuthenticated();
    return res.data.login;
  } catch (err) {
    console.warn("[github] Could not determine the GitHub login behind GITHUB_TOKEN:", err);
    botLoginPromise = null;
    return null;
  }
}

/** Markdown label for the bot's GitHub account in user-facing messages. */
export async function describeBotAccount(): Promise<string> {
  return botLabel(await getBotLogin(), "the bot's GitHub account");
}

function botLabel(login: string | null, fallback: string): string {
  return login ? `\`${login}\`` : fallback;
}

/** Test-only: forget the cached login so each test starts clean. */
export function _resetBotLoginForTesting(): void {
  botLoginPromise = null;
}

/** All GitHub operations bound to a specific owner/repo pair. */
export interface GithubClient {
  readFile(path: string, branch?: string): Promise<RepoFile | null>;
  writeFile(
    path: string,
    content: string,
    message: string,
    sha?: string,
    branch?: string,
  ): Promise<void>;
  getDefaultBranch(): Promise<{ name: string; sha: string }>;
  createBranch(name: string, fromSha: string): Promise<void>;
  /**
   * Return true when the bot account has write or admin permission on this repo.
   * Returns true (optimistic) when GITHUB_BOT_USERNAME is not set.
   * Never throws on 404/403 — only on unexpected errors.
   */
  checkBotIsCollaborator(): Promise<boolean>;
  openPullRequest(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequestResult>;
  listDirectory(path: string, branch?: string): Promise<DirectoryEntry[] | null>;
  searchCode(query: string, limit?: number): Promise<CodeSearchMatch[]>;
  getPullRequest(number: number): Promise<PullRequestState>;
  getPullRequestBody(number: number): Promise<string>;
  updatePullRequest(number: number, body: string): Promise<void>;
  deleteFile(path: string, message: string, sha: string, branch: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  closePullRequest(number: number): Promise<void>;
  buildBranchName(
    kind: "create" | "edit" | "delete" | "feature" | "refine",
    path: string,
    now?: number,
  ): string;
  repoCoordinates(): { owner: string; repo: string };
  buildBlobUrl(branch: string, path: string): string;
}

/** Create a GitHub client bound to the given owner/repo. */
export function createGithubClient(owner: string, repo: string): GithubClient {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  return {
    async readFile(path, branch) {
      try {
        const res = await octokit.repos.getContent({
          owner,
          repo,
          path,
          ref: branch,
        });
        if (Array.isArray(res.data) || res.data.type !== "file") {
          throw new Error(`\`${path}\` is not a file.`);
        }
        const content = Buffer.from(res.data.content, "base64").toString("utf8");
        return { path, content, sha: res.data.sha };
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async writeFile(path, content, message, sha, branch) {
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        sha,
        branch,
      });
    },

    async getDefaultBranch() {
      const repoInfo = await octokit.repos.get({ owner, repo });
      const name = repoInfo.data.default_branch;
      const branch = await octokit.repos.getBranch({
        owner,
        repo,
        branch: name,
      });
      return { name, sha: branch.data.commit.sha };
    },

    async createBranch(name, fromSha) {
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${name}`,
          sha: fromSha,
        });
      } catch (err: unknown) {
        if (isNotFound(err)) throw new GithubWriteAccessError(owner, repo, await getBotLogin());
        throw err;
      }
    },

    async checkBotIsCollaborator() {
      const username = await getBotLogin();
      if (!username) {
        console.warn(
          "[repo] Could not determine the bot's GitHub login — skipping write-access check.",
        );
        return true;
      }
      try {
        const res = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
        const perm = res.data.permission;
        return perm === "admin" || perm === "write";
      } catch (err: unknown) {
        if (isNotFound(err) || isForbidden(err)) return false;
        throw err;
      }
    },

    async openPullRequest(title, body, head, base) {
      const res = await octokit.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
      });
      return { url: res.data.html_url, number: res.data.number, branch: head };
    },

    async listDirectory(path, branch) {
      const cleaned = path.replace(/^\/+|\/+$/g, "");
      try {
        const res = await octokit.repos.getContent({
          owner,
          repo,
          path: cleaned,
          ref: branch,
        });
        if (!Array.isArray(res.data)) {
          throw new Error(`\`${path}\` is a file, not a directory.`);
        }
        return res.data
          .filter((e) => e.type === "file" || e.type === "dir")
          .map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type as "file" | "dir",
          }));
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async searchCode(query, limit = 20) {
      const scoped = `${query} repo:${owner}/${repo}`;
      const res = await octokit.search.code({
        q: scoped,
        per_page: limit,
      });
      return res.data.items.map((it) => ({
        path: it.path,
        url: it.html_url,
      }));
    },

    async getPullRequest(number) {
      const res = await octokit.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      return {
        number,
        state: res.data.state === "open" ? "open" : "closed",
        merged: !!res.data.merged,
        url: res.data.html_url,
      };
    },

    async getPullRequestBody(number) {
      const res = await octokit.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      return res.data.body ?? "";
    },

    async updatePullRequest(number, body) {
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: number,
        body,
      });
    },

    async deleteFile(path, message, sha, branch) {
      await octokit.repos.deleteFile({
        owner,
        repo,
        path,
        message,
        sha,
        branch,
      });
    },

    async deleteBranch(name) {
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${name}`,
      });
    },

    async closePullRequest(number) {
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: number,
        state: "closed",
      });
    },

    buildBranchName(kind, path, now = Date.now()) {
      return `onyx/${kind}-${slugify(path)}-${now}`;
    },

    repoCoordinates() {
      return { owner, repo };
    },

    buildBlobUrl(branch, path) {
      return `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
    },
  };
}

/**
 * Return a `GithubClient` bound to the repo configured for `channelId`.
 * Falls back to `GITHUB_OWNER` / `GITHUB_REPO` env defaults when the channel
 * has no explicit binding (or when `channelId` is empty).
 */
export function getClientForChannel(channelId: string): GithubClient {
  const binding = getRepoBinding(channelId);
  return createGithubClient(binding.owner, binding.repo);
}

// ---------------------------------------------------------------------------
// Backward-compat named exports — delegate to the default env-based client.
// Used by integration tests and any call sites not yet migrated to the factory.
// ---------------------------------------------------------------------------

const _default = createGithubClient(
  (process.env.GITHUB_OWNER || "").trim(),
  (process.env.GITHUB_REPO || "").trim(),
);

/** @deprecated Prefer `getClientForChannel(channelId)` for channel-aware routing. */
export const readFile = (path: string, branch?: string) => _default.readFile(path, branch);

/** @deprecated Prefer `getClientForChannel(channelId)` for channel-aware routing. */
export const writeFile = (
  path: string,
  content: string,
  message: string,
  sha?: string,
  branch?: string,
) => _default.writeFile(path, content, message, sha, branch);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const getDefaultBranch = () => _default.getDefaultBranch();

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const createBranch = (name: string, fromSha: string) => _default.createBranch(name, fromSha);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const openPullRequest = (title: string, body: string, head: string, base: string) =>
  _default.openPullRequest(title, body, head, base);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const listDirectory = (path: string, branch?: string) =>
  _default.listDirectory(path, branch);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const searchCode = (query: string, limit?: number) => _default.searchCode(query, limit);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const getPullRequest = (number: number) => _default.getPullRequest(number);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const getPullRequestBody = (number: number) => _default.getPullRequestBody(number);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const updatePullRequest = (number: number, body: string) =>
  _default.updatePullRequest(number, body);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const deleteFile = (path: string, message: string, sha: string, branch: string) =>
  _default.deleteFile(path, message, sha, branch);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const deleteBranch = (name: string) => _default.deleteBranch(name);

/** @deprecated Prefer `getClientForChannel(channelId)`. */
export const closePullRequest = (number: number) => _default.closePullRequest(number);

/**
 * Build a deterministic, GitHub-safe branch name like
 * `onyx/create-src-util-log-ts-1714003200000`.
 */
export function buildBranchName(
  kind: "create" | "edit" | "delete" | "feature" | "refine",
  path: string,
  now: number = Date.now(),
): string {
  return _default.buildBranchName(kind, path, now);
}

/** Configured repo coordinates — exposed so renderers can build blob links. */
export function repoCoordinates(): { owner: string; repo: string } {
  return _default.repoCoordinates();
}

/**
 * Build the GitHub web URL for a file on a specific branch — used by the
 * diff-preview renderer to link out when content overflows Discord's limits.
 */
export function buildBlobUrl(branch: string, path: string): string {
  return _default.buildBlobUrl(branch, path);
}

/** Lower-case, replace any non-alphanum with `-`, collapse runs, trim, cap length. */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 60).replace(/-+$/g, "") || "file";
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}

function isForbidden(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 403
  );
}

/**
 * Accept any pending repository invitations for the bot account.
 * Uses the bot's GITHUB_TOKEN to call the GitHub API.
 * Safe to call repeatedly; no-op if no invitations are pending.
 */
export async function acceptRepoInvitations(): Promise<void> {
  const token = (process.env.GITHUB_TOKEN || "").trim();
  if (!token) return;
  const octokit = new Octokit({ auth: token });
  try {
    const { data: invitations } = await octokit.request("GET /user/repository_invitations");
    if (!Array.isArray(invitations) || invitations.length === 0) return;
    await Promise.all(
      invitations.map((inv) =>
        octokit
          .request("PATCH /user/repository_invitations/{invitation_id}", {
            invitation_id: inv.id,
          })
          .then(() => {
            const repo = inv.repository?.full_name ?? `#${inv.id}`;
            console.log(`Accepted repo invitation: ${repo}`);
          })
          .catch((err) => {
            console.error(`Failed to accept invitation ${inv.id}:`, err);
          }),
      ),
    );
  } catch (err) {
    // Non-fatal: the bot can still function, the user may need to accept manually.
    console.error("Error checking repo invitations:", err);
  }
}
