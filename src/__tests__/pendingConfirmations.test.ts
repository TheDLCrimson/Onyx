import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPendingForTesting,
  peekRetryDelete,
  popRetryDelete,
  registerPending,
  registerRetryDelete,
  resolvePending,
} from "../utils/pendingConfirmations";

afterEach(() => {
  _resetPendingForTesting();
});

describe("pendingConfirmations", () => {
  it("resolves true when resolvePending is called with true", async () => {
    const p = registerPending("msg-1");
    resolvePending("msg-1", true);
    expect(await p).toBe(true);
  });

  it("resolves false when resolvePending is called with false", async () => {
    const p = registerPending("msg-2");
    resolvePending("msg-2", false);
    expect(await p).toBe(false);
  });

  it("returns true (was pending) on first resolution", () => {
    registerPending("msg-3");
    expect(resolvePending("msg-3", true)).toBe(true);
  });

  it("returns false (already handled) on second resolution", () => {
    registerPending("msg-4");
    resolvePending("msg-4", true);
    expect(resolvePending("msg-4", false)).toBe(false);
  });

  it("returns false when resolving a non-existent id", () => {
    expect(resolvePending("ghost-id", true)).toBe(false);
  });

  it("handles multiple concurrent pending confirmations independently", async () => {
    const p1 = registerPending("msg-a");
    const p2 = registerPending("msg-b");
    resolvePending("msg-b", false);
    resolvePending("msg-a", true);
    expect(await p1).toBe(true);
    expect(await p2).toBe(false);
  });
});

describe("retryDelete store", () => {
  it("returns entry on first pop", () => {
    const key = registerRetryDelete({
      channelId: "ch-1",
      path: "src/foo.ts",
      featureScopeId: "s1",
    });
    const entry = popRetryDelete(key);
    expect(entry).toEqual({ channelId: "ch-1", path: "src/foo.ts", featureScopeId: "s1" });
  });

  it("returns null on second pop (one-shot)", () => {
    const key = registerRetryDelete({
      channelId: "ch-1",
      path: "src/foo.ts",
      featureScopeId: "s1",
    });
    popRetryDelete(key);
    expect(popRetryDelete(key)).toBeNull();
  });

  it("returns null for an unknown key", () => {
    expect(popRetryDelete("ghost-key")).toBeNull();
  });

  it("peek returns entry without consuming it", () => {
    const key = registerRetryDelete({ channelId: "ch-1", path: "a.ts", featureScopeId: "s1" });
    expect(peekRetryDelete(key)).toEqual({ channelId: "ch-1", path: "a.ts", featureScopeId: "s1" });
    expect(peekRetryDelete(key)).toEqual({ channelId: "ch-1", path: "a.ts", featureScopeId: "s1" });
    expect(popRetryDelete(key)).toEqual({ channelId: "ch-1", path: "a.ts", featureScopeId: "s1" });
  });

  it("peek returns null for an unknown key", () => {
    expect(peekRetryDelete("ghost-key")).toBeNull();
  });

  it("generates unique keys for concurrent entries", () => {
    const k1 = registerRetryDelete({ channelId: "ch-1", path: "a.ts", featureScopeId: "s1" });
    const k2 = registerRetryDelete({ channelId: "ch-1", path: "b.ts", featureScopeId: "s1" });
    expect(k1).not.toBe(k2);
    expect(popRetryDelete(k1)?.path).toBe("a.ts");
    expect(popRetryDelete(k2)?.path).toBe("b.ts");
  });
});
