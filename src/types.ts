import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

/** Discord prefix-command kinds (legacy fallback). */
export type CommandKind = "create" | "edit" | "ask";

/** A successfully parsed Discord prefix-command message. */
export interface ParsedCommand {
  kind: CommandKind;
  /** Repo-relative path, e.g. "src/util/log.ts". */
  path: string;
  /** Natural-language instruction or question that follows the path. */
  body: string;
}

/**
 * Permission mode for a channel session. `direct` commits straight to the
 * default branch; `pr` opens / attaches to a feature PR; `plan` blocks all
 * write tools (gating logic lands in PR C). Default is `pr`.
 */
export type Mode = "direct" | "plan" | "pr";

/**
 * Three-axis budget for one agent loop run. Decremented per tool dispatch
 * (reads/writes) and per LLM call (tokens). Replaces `maxIterations` as the
 * primary stop condition (PR L).
 */
export interface AgentBudget {
  reads: number;
  writes: number;
  tokens: number;
}

/**
 * One pending file operation sitting in the in-memory staging area.
 * Flushed as a logical batch when the model calls the `Commit` tool.
 * Not persisted to disk — auto-flush runs at every pause point so the
 * staging area should be empty by the time flushSessionsToDisk is called.
 */
export interface StagingEntry {
  kind: "create" | "edit" | "delete";
  path: string;
  /** New file body for create/edit. For delete, the old contents (for PR body context). */
  content: string;
  /** One-sentence intent for the PR body. */
  prompt: string;
  /** Existing blob SHA when editing/deleting on the active branch. */
  sha?: string;
}

/** One past command in a channel session — feeds conversation context + /session. */
export interface Turn {
  kind: "create" | "edit" | "delete" | "ask" | "feature" | "refine" | "tool";
  /** Repo paths the turn touched. Empty for /ask, populated for writes. */
  paths: string[];
  /** User-facing prompt, or a model action summary for `kind: "tool"`. */
  prompt: string;
  /** Bullet-list summary of the change; null for read-only turns. */
  summary: string | null;
  /** Epoch ms. */
  timestamp: number;
}

/** The PR Onyx is currently iterating on for a channel. */
export interface ActiveFeature {
  /** Branch name; null until the first successful write. */
  branch: string | null;
  /** PR number; null until the first commit lands. */
  prNumber: number | null;
  /** Display title for /session. Evolves with scope in PR C; static in PR A. */
  title: string;
  /** Every file touched by this feature so far. */
  paths: Set<string>;
  /** Append-only history of commands run against this feature. */
  turns: Turn[];
  /** Epoch ms the feature was first attached. */
  createdAt: number;
  /** Most recent plan text from an execution (for verification on subsequent refines). */
  lastPlanText?: string;
  /** Number of [🔁 Auto-fix] build-gate retries for this feature; capped at 3. */
  buildFixAttempts?: number;
  /** True once the PR URL has been announced in Discord for this feature.
   *  Persisted so resume cycles don't re-announce the same PR link. */
  prAnnounced?: boolean;
}

/**
 * A paused agent loop, awaiting either a button click or a follow-up
 * channel message. Holds routing metadata and a cursor into `Session.messages`
 * — the conversation itself lives on the session so cancel preserves context.
 */
export interface RunningAgent {
  kind: "feature" | "refine" | "ask";
  state: "running" | "awaiting-button" | "awaiting-user-text";
  /** Index into `Session.messages` at the start of this loop. Used by
   *  resumeFeature to reconstruct the exact message slice for resumeAgent. */
  cursor: number;
  /** Discord user ID of the member who started this loop. Only their messages are accepted as clarification replies. */
  initiatorId: string;
  /** Epoch ms — set when the loop first started, not on each pause. */
  startedAt: number;
  /**
   * The plan_text the model passed to ExitPlanMode in this loop. Captured so
   * the post-execution verifier (PR E) can compare plan vs. resulting diffs.
   * Cleared together with the running agent on completion.
   */
  planText?: string;
  /**
   * Epoch ms of the most recent [🔁 Retry] click. Set by resumeFeature so
   * handleAgentOutput can detect when the model gave up without retrying any
   * writes — in that case we re-surface the Retry button instead of clearing.
   */
  retryStartedAt?: number;
  /**
   * File operations queued by Write/Edit/Delete/MultiEdit, to be flushed as a
   * logical batch by the `Commit` tool (or auto-flushed on pause). Not persisted
   * to disk — see StagingEntry for the rationale.
   */
  stagingArea?: StagingEntry[];
  /**
   * Remaining three-axis budget for this loop. Updated after each iteration via
   * the `onIteration` callback. Persisted so a restarted bot resumes with the
   * correct remaining budget rather than a fresh one.
   */
  budget?: AgentBudget;
}

/** Channel-keyed session state. In-memory only in PR A. */
export interface Session {
  channelId: string;
  active: ActiveFeature | null;
  /** Current permission mode. */
  mode: Mode;
  /** Mode to restore on ExitPlanMode (set when entering plan mode). */
  prePlanMode?: Mode;
  /**
   * In-flight `/feature` or `/refine` loop, paused awaiting input. While
   * non-null, slash commands that would write are blocked.
   */
  runningAgent: RunningAgent | null;
  /** Epoch ms — touched on every command, drives 7-day eviction. */
  lastUsedAt: number;
  /** Epoch ms of the most recent context-relevant turn (drives 1h window). */
  lastTurnAt: number;
  /**
   * Accumulated conversation history (no system messages). Shared across all
   * commands on this channel — persists through cancel so context is not lost.
   * Cleared only by /reset (which drops the session entirely).
   */
  messages: ChatCompletionMessageParam[];
}

/** A file fetched from the configured GitHub repo. */
export interface RepoFile {
  path: string;
  content: string;
  /** Blob SHA — required when updating an existing file via the GitHub API. */
  sha: string;
}

/** Result of opening a pull request via `services/github.openPullRequest`. */
export interface PullRequestResult {
  /** Web URL for the PR. */
  url: string;
  /** PR number within the repo. */
  number: number;
  /** Head branch the PR is opened from. */
  branch: string;
}

/** Builder shape produced by SlashCommandBuilder, with or without options. */
export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/** A slash command — its definition plus its handler. */
export interface SlashCommand {
  data: SlashCommandData;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
