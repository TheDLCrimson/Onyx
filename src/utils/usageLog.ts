import fs from "fs";
import { DATA_DIR, dataFile } from "./dataDir";
import path from "path";

/** One OpenRouter API call's usage metrics, persisted to data/usage.json. */
export interface UsageEntry {
  timestamp: number;
  channelId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /**
   * Prompt-cache hit count from the provider's usage payload. When >0 a
   * portion of the input tokens were served from Anthropic's prompt cache
   * at the 0.1× input price. Absent on legacy entries written before the
   * caching PR landed; absent when the provider response omits the field.
   */
  cachedTokens?: number;
  /**
   * Prompt-cache write count — tokens billed at the 1.25× write premium
   * when a fresh prefix was inserted into the cache. Useful for spotting
   * the first call in a cache window vs. follow-up reads. Absent when the
   * provider response omits the field.
   */
  cacheWriteTokens?: number;
}

const USAGE_FILE = dataFile("usage.json");

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;

/**
 * Parse ONYX_USAGE_RETENTION_DAYS. Returns the default (7) when absent, blank,
 * non-numeric, or non-positive — same ||+trim() pattern used across the codebase.
 */
export function retentionWindowMs(): number {
  const raw = (process.env.ONYX_USAGE_RETENTION_DAYS || "").trim();
  const parsed = Number(raw);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function readUsageLog(): UsageEntry[] {
  try {
    if (!fs.existsSync(USAGE_FILE)) return [];
    const raw = fs.readFileSync(USAGE_FILE, "utf8");
    return JSON.parse(raw) as UsageEntry[];
  } catch {
    return [];
  }
}

/**
 * Append one usage entry to data/usage.json using the tmpfile+rename pattern.
 * Prunes entries older than ONYX_USAGE_RETENTION_DAYS (default 7) on every write
 * so the file stays bounded. Never throws — logging failures are non-fatal.
 */
export function appendUsage(entry: UsageEntry): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = readUsageLog();
    entries.push(entry);
    const cutoff = Date.now() - retentionWindowMs();
    const pruned = entries.filter((e) => e.timestamp >= cutoff);
    const tmp = `${USAGE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), "utf8");
    fs.renameSync(tmp, USAGE_FILE);
  } catch (err) {
    console.error("[usageLog] Failed to append usage entry:", err);
  }
}

/**
 * Return all entries for a given channelId within the specified time window.
 * Defaults to the rolling 24-hour window used by the budget guard.
 */
export function getChannelEntries(
  channelId: string,
  windowMs: number = TWENTY_FOUR_HOURS_MS,
): UsageEntry[] {
  const cutoff = Date.now() - windowMs;
  return readUsageLog().filter((e) => e.channelId === channelId && e.timestamp >= cutoff);
}

/** Sum the costUsd field across a list of entries. Returns 0 for an empty list. */
export function rollupCost(entries: UsageEntry[]): number {
  return entries.reduce((sum, e) => sum + e.costUsd, 0);
}

/**
 * Parse the ONYX_CHANNEL_BUDGET_USD env var. Returns Infinity (unlimited) when
 * absent, blank, or non-numeric — same ||+trim() pattern used across the codebase.
 */
export function dailyBudgetUsd(): number {
  const raw = (process.env.ONYX_CHANNEL_BUDGET_USD || "").trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

/**
 * Returns true when a daily budget is configured and the channel's rolling
 * 24-hour spend meets or exceeds it. Always returns false when no budget is set.
 */
export function isBudgetExceeded(channelId: string): boolean {
  const budget = dailyBudgetUsd();
  if (!Number.isFinite(budget)) return false;
  const spent = rollupCost(getChannelEntries(channelId));
  return spent >= budget;
}

/** User-facing message posted when the budget guard fires. */
export function budgetExceededReply(): string {
  return "💸 Daily budget exceeded for this channel. Contact the bot operator to raise the limit.";
}
