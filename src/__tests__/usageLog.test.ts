import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock fn references so the vi.mock factory can close over them.
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockRenameSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn(() => false),
    mockReadFileSync: vi.fn(() => "[]"),
    mockWriteFileSync: vi.fn(),
    mockRenameSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const mocks = {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    mkdirSync: mockMkdirSync,
  };
  return { ...actual, ...mocks, default: mocks };
});

import {
  appendUsage,
  dailyBudgetUsd,
  getChannelEntries,
  isBudgetExceeded,
  retentionWindowMs,
  rollupCost,
  TWENTY_FOUR_HOURS_MS,
} from "../utils/usageLog";
import type { UsageEntry } from "../utils/usageLog";

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    timestamp: Date.now(),
    channelId: "ch-1",
    model: "anthropic/claude-sonnet-4.6",
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.001,
    ...overrides,
  };
}

/** Prime the fs mock to return a specific set of entries. */
function seedLog(entries: UsageEntry[]): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(JSON.stringify(entries));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ONYX_CHANNEL_BUDGET_USD;
  delete process.env.ONYX_USAGE_RETENTION_DAYS;
});

afterEach(() => {
  delete process.env.ONYX_CHANNEL_BUDGET_USD;
  delete process.env.ONYX_USAGE_RETENTION_DAYS;
});

// ---------------------------------------------------------------------------
// appendUsage
// ---------------------------------------------------------------------------
describe("appendUsage", () => {
  it("writes the entry to disk via tmpfile+rename", () => {
    appendUsage(makeEntry());
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockRenameSync).toHaveBeenCalled();
  });

  it("appends to existing entries when log file is present", () => {
    const existing = makeEntry({ costUsd: 0.001 });
    seedLog([existing]);
    const fresh = makeEntry({ costUsd: 0.002 });
    appendUsage(fresh);

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as UsageEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.costUsd).toBe(0.002);
  });

  it("does not throw when the fs write fails", () => {
    mockWriteFileSync.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => appendUsage(makeEntry())).not.toThrow();
  });

  it("prunes entries older than the retention window before writing", () => {
    const now = Date.now();
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    seedLog([
      makeEntry({ timestamp: now - retentionMs - 1 }), // outside — pruned
      makeEntry({ timestamp: now - retentionMs + 1000 }), // inside — kept
    ]);
    appendUsage(makeEntry({ costUsd: 0.005 }));

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as UsageEntry[];
    // stale entry pruned; kept entry + new entry = 2
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.costUsd).toBe(0.005);
  });

  it("respects ONYX_USAGE_RETENTION_DAYS when pruning", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "1";
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    seedLog([
      makeEntry({ timestamp: now - oneDayMs - 1 }), // outside 1-day window — pruned
      makeEntry({ timestamp: now - oneDayMs + 1000 }), // inside — kept
    ]);
    appendUsage(makeEntry());

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as UsageEntry[];
    expect(parsed).toHaveLength(2);
  });

  it("keeps the new entry even when it would otherwise be at the boundary", () => {
    // All existing entries are stale — only the new one should survive
    const stale = makeEntry({ timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    seedLog([stale, stale, stale]);
    appendUsage(makeEntry({ costUsd: 0.99 }));

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as UsageEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.costUsd).toBe(0.99);
  });
});

// ---------------------------------------------------------------------------
// retentionWindowMs
// ---------------------------------------------------------------------------
describe("retentionWindowMs", () => {
  it("returns 7 days in ms by default", () => {
    expect(retentionWindowMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns 7 days when env var is absent or blank", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "";
    expect(retentionWindowMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns 7 days when env var is non-numeric", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "abc";
    expect(retentionWindowMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns 7 days for zero or negative values", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "0";
    expect(retentionWindowMs()).toBe(7 * 24 * 60 * 60 * 1000);
    process.env.ONYX_USAGE_RETENTION_DAYS = "-3";
    expect(retentionWindowMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses a valid positive integer", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "30";
    expect(retentionWindowMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("parses a fractional day value", () => {
    process.env.ONYX_USAGE_RETENTION_DAYS = "0.5";
    expect(retentionWindowMs()).toBe(0.5 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// getChannelEntries
// ---------------------------------------------------------------------------
describe("getChannelEntries", () => {
  it("returns entries matching the channelId within the window", () => {
    const now = Date.now();
    seedLog([
      makeEntry({ channelId: "ch-1", timestamp: now - 1000 }),
      makeEntry({ channelId: "ch-1", timestamp: now - 1000 }),
      makeEntry({ channelId: "ch-2", timestamp: now - 1000 }),
    ]);
    const result = getChannelEntries("ch-1");
    expect(result).toHaveLength(2);
  });

  it("excludes entries outside the time window", () => {
    const now = Date.now();
    seedLog([
      makeEntry({ channelId: "ch-1", timestamp: now - TWENTY_FOUR_HOURS_MS - 1 }),
      makeEntry({ channelId: "ch-1", timestamp: now - 1000 }),
    ]);
    const result = getChannelEntries("ch-1");
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no entries for the channel", () => {
    seedLog([makeEntry({ channelId: "ch-other" })]);
    expect(getChannelEntries("ch-1")).toHaveLength(0);
  });

  it("returns empty array when log file is absent", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getChannelEntries("ch-1")).toHaveLength(0);
  });

  it("respects a custom windowMs", () => {
    const now = Date.now();
    seedLog([
      makeEntry({ channelId: "ch-1", timestamp: now - 5000 }),
      makeEntry({ channelId: "ch-1", timestamp: now - 500 }),
    ]);
    const result = getChannelEntries("ch-1", 1000);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rollupCost
// ---------------------------------------------------------------------------
describe("rollupCost", () => {
  it("sums costUsd across entries", () => {
    const entries = [
      makeEntry({ costUsd: 0.001 }),
      makeEntry({ costUsd: 0.002 }),
      makeEntry({ costUsd: 0.003 }),
    ];
    expect(rollupCost(entries)).toBeCloseTo(0.006);
  });

  it("returns 0 for an empty list", () => {
    expect(rollupCost([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dailyBudgetUsd
// ---------------------------------------------------------------------------
describe("dailyBudgetUsd", () => {
  it("returns Infinity when env var is absent", () => {
    expect(dailyBudgetUsd()).toBe(Infinity);
  });

  it("returns Infinity when env var is empty string", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "";
    expect(dailyBudgetUsd()).toBe(Infinity);
  });

  it("returns Infinity when env var is non-numeric", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "abc";
    expect(dailyBudgetUsd()).toBe(Infinity);
  });

  it("returns Infinity for zero or negative values", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "0";
    expect(dailyBudgetUsd()).toBe(Infinity);
    process.env.ONYX_CHANNEL_BUDGET_USD = "-5";
    expect(dailyBudgetUsd()).toBe(Infinity);
  });

  it("parses a valid positive number", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "1.50";
    expect(dailyBudgetUsd()).toBe(1.5);
  });

  it("trims surrounding whitespace before parsing", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "  2.00  ";
    expect(dailyBudgetUsd()).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// isBudgetExceeded
// ---------------------------------------------------------------------------
describe("isBudgetExceeded", () => {
  it("returns false when no budget is configured (unlimited)", () => {
    seedLog([makeEntry({ channelId: "ch-1", costUsd: 999 })]);
    expect(isBudgetExceeded("ch-1")).toBe(false);
  });

  it("returns false when spend is below the budget", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "1.00";
    seedLog([makeEntry({ channelId: "ch-1", costUsd: 0.5 })]);
    expect(isBudgetExceeded("ch-1")).toBe(false);
  });

  it("returns true when spend equals the budget", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "1.00";
    seedLog([makeEntry({ channelId: "ch-1", costUsd: 1.0 })]);
    expect(isBudgetExceeded("ch-1")).toBe(true);
  });

  it("returns true when spend exceeds the budget", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "0.50";
    seedLog([
      makeEntry({ channelId: "ch-1", costUsd: 0.3 }),
      makeEntry({ channelId: "ch-1", costUsd: 0.3 }),
    ]);
    expect(isBudgetExceeded("ch-1")).toBe(true);
  });

  it("does not count entries from a different channel toward the budget", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "0.10";
    seedLog([makeEntry({ channelId: "ch-other", costUsd: 999 })]);
    expect(isBudgetExceeded("ch-1")).toBe(false);
  });

  it("does not count entries outside the 24h window", () => {
    process.env.ONYX_CHANNEL_BUDGET_USD = "0.50";
    seedLog([
      // Inside the window
      makeEntry({ channelId: "ch-1", costUsd: 0.1, timestamp: Date.now() - 1000 }),
      // Outside the window
      makeEntry({
        channelId: "ch-1",
        costUsd: 999,
        timestamp: Date.now() - TWENTY_FOUR_HOURS_MS - 1,
      }),
    ]);
    expect(isBudgetExceeded("ch-1")).toBe(false);
  });
});
