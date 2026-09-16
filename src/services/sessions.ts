import fs from "fs";
import { DATA_DIR, dataFile } from "../utils/dataDir";
import path from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type { AgentBudget, ActiveFeature, Mode, RunningAgent, Session, Turn } from "../types";

/** Maximum turns retained per active feature (FIFO). */
export const MAX_TURNS = 20;

// ---------------------------------------------------------------------------
// Persistence helpers — write-through to data/sessions.json on every mutation.
// runningAgent + messages are persisted and restored within ONYX_RESUME_WINDOW_MINUTES.
// Sessions stuck in "plan" mode are reset to "pr" on load.
// ---------------------------------------------------------------------------

const SESSIONS_FILE = dataFile("sessions.json");

interface PersistedActiveFeature {
  branch: string | null;
  prNumber: number | null;
  title: string;
  paths: string[];
  turns: Turn[];
  createdAt: number;
  lastPlanText?: string;
  /** Persisted so PR URL announcement survives bot restarts / resume cycles. */
  prAnnounced?: boolean;
  buildFixAttempts?: number;
}

interface PersistedRunningAgent {
  kind: "feature" | "refine" | "ask";
  state: "running" | "awaiting-button" | "awaiting-user-text";
  cursor: number;
  initiatorId: string;
  startedAt: number;
  planText?: string;
  retryStartedAt?: number;
  /** Remaining budget at last flush — restored on resume so the model continues with correct limits. */
  budget?: AgentBudget;
}

interface PersistedSession {
  channelId: string;
  mode: Mode;
  prePlanMode?: Mode;
  lastUsedAt: number;
  lastTurnAt: number;
  active: PersistedActiveFeature | null;
  /** v2: persisted agent loop state for crash-recovery resumption. */
  runningAgent?: PersistedRunningAgent;
  /** v2: conversation messages to restore alongside runningAgent. */
  messages?: ChatCompletionMessageParam[];
}

/** Load sessions from disk into the in-memory map. Call once at startup. */
export function loadPersistedSessions(): void {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, PersistedSession>;
    const windowMs = resumeWindowMs();
    const now = Date.now();
    for (const [channelId, p] of Object.entries(data)) {
      const active: ActiveFeature | null = p.active
        ? { ...p.active, paths: new Set(p.active.paths) }
        : null;
      const restoredMode: Mode = p.mode === "plan" ? (p.prePlanMode ?? "pr") : p.mode;
      // Restore runningAgent only if it's within the resume window.
      const restoredAgent: RunningAgent | null =
        p.runningAgent && now - p.runningAgent.startedAt <= windowMs ? p.runningAgent : null;
      const session: Session = {
        channelId,
        mode: restoredMode,
        active,
        runningAgent: restoredAgent,
        lastUsedAt: p.lastUsedAt,
        lastTurnAt: p.lastTurnAt,
        messages: restoredAgent ? (p.messages ?? []) : [],
      };
      sessions.set(channelId, session);
    }
  } catch {
    console.warn("[sessions] Failed to load persisted sessions, starting fresh.");
  }
}

function saveSessions(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data: Record<string, PersistedSession> = {};
    for (const [channelId, s] of sessions) {
      data[channelId] = {
        channelId: s.channelId,
        mode: s.mode,
        prePlanMode: s.prePlanMode,
        lastUsedAt: s.lastUsedAt,
        lastTurnAt: s.lastTurnAt,
        active: s.active
          ? {
              branch: s.active.branch,
              prNumber: s.active.prNumber,
              title: s.active.title,
              paths: Array.from(s.active.paths),
              turns: s.active.turns,
              createdAt: s.active.createdAt,
              lastPlanText: s.active.lastPlanText,
              prAnnounced: s.active.prAnnounced,
              buildFixAttempts: s.active.buildFixAttempts,
            }
          : null,
        runningAgent: s.runningAgent ?? undefined,
        messages: s.messages.length > 0 ? s.messages : undefined,
      };
    }
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (err) {
    console.error("[sessions] Failed to save sessions:", err);
  }
}

const DEFAULT_SESSION_TIMEOUT_DAYS = 7;
const DEFAULT_CONTEXT_WINDOW_MINUTES = 60;

/**
 * 7-day soft active-feature lifetime, configurable via
 * `ONYX_SESSION_TIMEOUT_DAYS`. Activity extends; eviction runs lazily.
 */
export function sessionTimeoutMs(): number {
  const raw = (process.env.ONYX_SESSION_TIMEOUT_DAYS || "").trim();
  const parsed = Number(raw);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TIMEOUT_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * 1-hour rolling conversation-context window, configurable via
 * `ONYX_CONTEXT_WINDOW_MINUTES`. Older turns survive on the session for
 * /session display but don't feed model calls.
 */
export function contextWindowMs(): number {
  const raw = (process.env.ONYX_CONTEXT_WINDOW_MINUTES || "").trim();
  const parsed = Number(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW_MINUTES;
  return minutes * 60 * 1000;
}

const DEFAULT_RESUME_WINDOW_MINUTES = 60;

/**
 * How long a persisted `runningAgent` is eligible for crash-recovery resumption,
 * configurable via `ONYX_RESUME_WINDOW_MINUTES` (default 60). Agents older than
 * this are dropped on load — the conversation context window would already have
 * evicted the relevant turns.
 */
export function resumeWindowMs(): number {
  const raw = (process.env.ONYX_RESUME_WINDOW_MINUTES || "").trim();
  const parsed = Number(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESUME_WINDOW_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Flush all sessions to disk immediately. Callers use this to guarantee the
 * latest in-memory state (messages, runningAgent) is persisted after each
 * agent loop iteration or pause, so a bot restart can recover from the most
 * recent checkpoint. Named to reflect it flushes ALL sessions globally, not
 * just the one the caller is working on.
 */
export function flushSessionsToDisk(): void {
  saveSessions();
}

/**
 * Return the channelIds of every session that has a restored (non-null)
 * `runningAgent`. Called at startup by `restoreRunningAgents` to find channels
 * that need a resume message posted.
 */
export function getChannelsNeedingRestore(): string[] {
  const out: string[] = [];
  for (const [channelId, s] of sessions) {
    if (s.runningAgent) out.push(channelId);
  }
  return out;
}

const sessions = new Map<string, Session>();

/**
 * Fetch the channel's session, creating it if absent. Lazily evicts every
 * session whose `lastUsedAt` is outside the active-feature lifetime — keeps
 * the in-memory map from growing unbounded.
 */
export function getOrCreateSession(channelId: string, now: number = Date.now()): Session {
  evictStale(now);
  let session = sessions.get(channelId);
  if (!session) {
    session = {
      channelId,
      active: null,
      mode: "pr",
      runningAgent: null,
      lastUsedAt: now,
      lastTurnAt: now,
      messages: [],
    };
    sessions.set(channelId, session);
  } else {
    session.lastUsedAt = now;
  }
  return session;
}

/** End the channel's session entirely (used by /reset). */
export function dropSession(channelId: string): boolean {
  const deleted = sessions.delete(channelId);
  if (deleted) saveSessions();
  return deleted;
}

/**
 * Append a turn, capping at MAX_TURNS (FIFO). Updates `lastTurnAt` and
 * `lastUsedAt`, and threads the path(s) into the active feature's `paths`
 * set when one is attached.
 */
export function recordTurn(session: Session, turn: Turn): void {
  if (session.active) {
    session.active.turns.push(turn);
    if (session.active.turns.length > MAX_TURNS) {
      session.active.turns.splice(0, session.active.turns.length - MAX_TURNS);
    }
    for (const p of turn.paths) session.active.paths.add(p);
  }
  session.lastTurnAt = turn.timestamp;
  session.lastUsedAt = turn.timestamp;
  saveSessions();
}

/** Attach (or replace) the active feature for a session. */
export function attachActiveFeature(session: Session, feature: ActiveFeature): void {
  session.active = feature;
  session.lastUsedAt = feature.createdAt;
  saveSessions();
}

/**
 * Clear the session's active feature — leaves the GitHub PR untouched. Used
 * when PR revalidation finds the PR has been closed/merged out from under us.
 */
export function endActiveFeature(session: Session): void {
  session.active = null;
  saveSessions();
}

/** True when an agent loop is paused awaiting input — gates write commands. */
export function isBusy(session: Session): boolean {
  return session.runningAgent !== null;
}

/** Set the running agent + flip session mode if entering plan mode. */
export function setRunningAgent(
  session: Session,
  agent: RunningAgent,
  mode: Session["mode"],
): void {
  if (mode === "plan" && session.mode !== "plan") {
    session.prePlanMode = session.mode;
  }
  session.mode = mode;
  session.runningAgent = agent;
  saveSessions();
}

/** Clear the running agent and restore prePlanMode if applicable. */
export function clearRunningAgent(session: Session): void {
  session.runningAgent = null;
  if (session.mode === "plan") {
    session.mode = session.prePlanMode ?? "pr";
    delete session.prePlanMode;
  }
  saveSessions();
}

/**
 * Read the latest TodoWrite snapshot off the active feature's turns. Returns
 * null if no TodoWrite call has been made yet for this feature.
 */
export function extractLatestTodoList(session: Session): readonly TodoItem[] | null {
  if (!session.active) return null;
  for (let i = session.active.turns.length - 1; i >= 0; i--) {
    const t = session.active.turns[i];
    if (t.kind === "tool" && t.prompt.startsWith("TodoWrite:")) {
      try {
        const json = t.prompt.slice("TodoWrite:".length).trim();
        const parsed = JSON.parse(json) as unknown;
        if (Array.isArray(parsed)) return parsed as TodoItem[];
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** One item in a TodoWrite checklist. Mirrored as the model-facing schema. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Snapshot of a single agent loop's progress, for the iteration-cap pause UX
 * and for /session display. Counts only `create` / `edit` / `delete` turns
 * since `sinceMs` (typically `runningAgent.startedAt`); also surfaces the
 * latest TodoWrite snapshot if any.
 */
export interface ProgressSummary {
  created: string[];
  edited: string[];
  deleted: string[];
  todos: readonly TodoItem[] | null;
}

/** Build a {@link ProgressSummary} from the active feature's recent turns. */
export function summarizeRecentProgress(session: Session, sinceMs: number): ProgressSummary {
  const out: ProgressSummary = {
    created: [],
    edited: [],
    deleted: [],
    todos: extractLatestTodoList(session),
  };
  if (!session.active) return out;
  for (const t of session.active.turns) {
    if (t.timestamp < sinceMs) continue;
    const path = t.paths[0];
    if (!path) continue;
    if (t.kind === "create") out.created.push(path);
    else if (t.kind === "edit") out.edited.push(path);
    else if (t.kind === "delete") out.deleted.push(path);
  }
  return out;
}

/**
 * Return turns from the active feature within the rolling context window.
 * Returns an empty array when no feature is attached.
 */
export function getRecentTurns(session: Session, now: number = Date.now()): Turn[] {
  if (!session.active) return [];
  const cutoff = now - contextWindowMs();
  return session.active.turns.filter((t) => t.timestamp >= cutoff);
}

/**
 * Render recent turns as a labeled "Recent activity" block for prepending
 * to a model user prompt. Returns "" when there's nothing to render so
 * callers can no-op without branching.
 */
export function formatHistory(turns: Turn[]): string {
  if (turns.length === 0) return "";
  const lines = turns.map((t) => {
    const pathBit = t.paths.length > 0 ? ` ${t.paths.join(", ")}` : "";
    return `- [${t.kind}]${pathBit}: ${t.prompt}`;
  });
  return lines.join("\n");
}

/** Test-only: clear every session. Not exported through the public API surface. */
export function _resetAllSessionsForTesting(): void {
  sessions.clear();
}

function evictStale(now: number): void {
  const limit = sessionTimeoutMs();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > limit) sessions.delete(id);
  }
}
