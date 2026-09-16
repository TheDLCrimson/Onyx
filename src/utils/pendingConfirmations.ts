/**
 * In-memory registry of pending delete-confirmation Promises, keyed by the
 * Discord message ID of the preview message that carries the confirm buttons.
 *
 * Bridge between the async `awaitConfirmation` call in makeWriteHooks (which
 * holds a Promise open) and the confirm-yes / confirm-no button handlers
 * (which resolve it).
 */
const pending = new Map<string, (value: boolean) => void>();

/**
 * Register a pending confirmation for `messageId`. Returns a Promise that
 * resolves when `resolvePending` is called (by a button click or a timeout).
 */
export function registerPending(messageId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pending.set(messageId, resolve);
  });
}

/**
 * Resolve the pending confirmation for `messageId` with `value`.
 * Returns `true` if the entry was still pending (first resolution), or
 * `false` if it was already resolved or never registered. Idempotent.
 */
export function resolvePending(messageId: string, value: boolean): boolean {
  const resolve = pending.get(messageId);
  if (!resolve) return false;
  pending.delete(messageId); // delete before calling resolve to prevent double-entry
  resolve(value);
  return true;
}

/** Only for use in unit tests. */
export function _resetPendingForTesting(): void {
  pending.clear();
  retryDeletes.clear();
}

// ---------------------------------------------------------------------------
// Retry-delete store
// Maps a short generated key → the context needed by the retry button handler.
// ---------------------------------------------------------------------------

export interface RetryDeleteEntry {
  channelId: string;
  path: string;
  featureScopeId: string;
}

const retryDeletes = new Map<string, RetryDeleteEntry>();

/**
 * Store a retry-delete entry and return the key to embed in the button customId.
 */
export function registerRetryDelete(entry: RetryDeleteEntry): string {
  const key = `rd${Math.random().toString(36).slice(2, 9)}`;
  retryDeletes.set(key, entry);
  return key;
}

/**
 * Peek at the retry-delete entry for `key` without consuming it.
 * Returns `null` if never registered or already consumed.
 */
export function peekRetryDelete(key: string): RetryDeleteEntry | null {
  return retryDeletes.get(key) ?? null;
}

/**
 * Pop and return the retry-delete entry for `key`. Returns `null` if already
 * consumed or never registered (button is stale).
 */
export function popRetryDelete(key: string): RetryDeleteEntry | null {
  const entry = retryDeletes.get(key);
  if (!entry) return null;
  retryDeletes.delete(key);
  return entry;
}
