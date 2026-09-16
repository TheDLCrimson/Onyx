/** Required env vars the bot needs at runtime to log in and operate. */
const REQUIRED_ENV = ["DISCORD_TOKEN", "OPENROUTER_API_KEY", "GITHUB_TOKEN"] as const;

/** Verify all required env vars are present, exit with an actionable error otherwise. */
export function assertEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !(process.env[key] || "").trim());
  if (missing.length > 0) {
    console.error(`Missing env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  // Non-fatal: without the application id, slash commands never register.
  if (!(process.env.DISCORD_CLIENT_ID || "").trim()) {
    console.warn(
      "[env] DISCORD_CLIENT_ID is not set — slash commands will not be registered. " +
        "Copy the Application ID from the Discord developer portal.",
    );
  }

  // Non-fatal: warn if no default repo and no channel bindings file yet.
  const hasDefaultRepo =
    (process.env.GITHUB_OWNER || "").trim() && (process.env.GITHUB_REPO || "").trim();
  if (!hasDefaultRepo) {
    console.warn(
      "[env] No default GITHUB_OWNER/GITHUB_REPO set. " +
        "Use /repo set <owner> <repo> in each channel before running commands.",
    );
  }
}

/**
 * Whether `/create` and `/edit` should open a PR (true, default) or commit
 * directly to the default branch (false). Reads `ONYX_PR_MODE`.
 */
export function prMode(): boolean {
  const raw = (process.env.ONYX_PR_MODE || "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}
