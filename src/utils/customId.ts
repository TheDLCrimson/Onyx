/**
 * Discord button + modal `customId`s use a `<namespace>:<action>:<scopeId>`
 * shape so a single router can dispatch by namespace without parsing logic
 * scattered across handlers. Discord caps customId at 100 chars; this
 * encoding stays well under that.
 */

/** Namespace + action labels the bot uses. Add as new flows ship. */
export const CUSTOM_ID_NAMESPACES = [
  "feature", // plan approval / collision UX
  "recovery", // failure-recovery buttons
  "modal", // modal payloads
  "confirm", // destructive-action confirmation buttons
] as const;

export type CustomIdNamespace = (typeof CUSTOM_ID_NAMESPACES)[number];

export interface ParsedCustomId {
  namespace: CustomIdNamespace;
  action: string;
  scopeId: string;
}

/** Build a customId. Throws if any part contains `:` (would corrupt parse). */
export function encodeCustomId(parts: ParsedCustomId): string {
  for (const v of [parts.namespace, parts.action, parts.scopeId]) {
    if (v.includes(":")) {
      throw new Error(`customId parts cannot contain ':' — got "${v}"`);
    }
  }
  const encoded = `${parts.namespace}:${parts.action}:${parts.scopeId}`;
  if (encoded.length > 100) {
    throw new Error(`customId exceeds Discord's 100-char limit (${encoded.length}): ${encoded}`);
  }
  return encoded;
}

/** Parse a customId string. Returns null on malformed input. */
export function parseCustomId(raw: string): ParsedCustomId | null {
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [namespace, action, scopeId] = parts;
  if (!isNamespace(namespace) || !action || !scopeId) return null;
  return { namespace, action, scopeId };
}

function isNamespace(v: string): v is CustomIdNamespace {
  return (CUSTOM_ID_NAMESPACES as readonly string[]).includes(v);
}

/**
 * Mint a fresh short scope id (~12 chars) — used as the third segment in a
 * customId so the same button shape (e.g. "feature:approve:…") can scope to
 * a specific feature loop. Random-enough for in-memory state; not a secret.
 */
export function newScopeId(): string {
  const part = Math.random().toString(36).slice(2, 10);
  return `s${part}${Date.now().toString(36).slice(-4)}`;
}
