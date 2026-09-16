import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type SendableChannels,
} from "discord.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import { resumeAgent, runAgent, DEFAULT_BUDGET, BUILD_FIX_BUDGET } from "../services/agent";
import type { ResumeInput, RunAgentOutput } from "../services/agent";
import { verifyPlan, VERIFY_UNAVAILABLE_NOTE } from "../services/llm";
import { buildCommandLabel, detectRepoKind, runBuildGate } from "../services/buildGate";
import type { RepoKind } from "../services/buildGate";
import { getClientForChannel } from "../services/github";
import { READ_TOOLS } from "../services/readTools";
import { buildPlanTools } from "../services/planTools";
import { commitChange } from "../services/commitFlow";
import {
  clearRunningAgent,
  flushSessionsToDisk,
  formatHistory,
  getRecentTurns,
  recordTurn,
  setRunningAgent,
  summarizeRecentProgress,
} from "../services/sessions";
import type { ProgressSummary, TodoItem } from "../services/sessions";
import type { Tool, ToolContext } from "../services/tools";
import { buildWriteTools } from "../services/writeTools";
import type { ActiveFeature, AgentBudget, Session, Turn } from "../types";
import { encodeCustomId } from "../utils/customId";
import { registerPending, registerRetryDelete } from "../utils/pendingConfirmations";
import { errText, sendLong, splitMessage, truncate } from "../utils/discord";
import { loggableError } from "../utils/modelErrors";
import {
  appendBuildErrorsSection,
  appendBuildSkippedNote,
  appendVerificationSection,
} from "../utils/prBody";

const FEATURE_SYSTEM_PROMPT =
  "You are a programming buddy embedded in a Discord channel. You operate " +
  "the user's GitHub repo via tools. The user just invoked /feature with a " +
  "vague intent.\n\n" +
  "WORKFLOW:\n" +
  "1. Use Read / List / Grep to explore the repo until you understand the " +
  "scope.\n" +
  "2. Ask clarifying questions in plain text (no tool call) if you need " +
  "more info — the user will reply in chat.\n" +
  "3. Maintain a TodoWrite checklist as you go; update it on every " +
  "meaningful step.\n" +
  "4. When you have a concrete plan, call ExitPlanMode with the full plan " +
  "text. The bot pauses and shows the user [✅ Run] [✏️ Revise] [❌ Cancel].\n" +
  "5. After the user approves, you'll be unblocked: use Write / Edit / " +
  "Delete / MultiEdit to stage changes. Each staged op posts a diff " +
  "preview in Discord; non-destructive writes auto-proceed; Delete " +
  "requires a button confirmation.\n" +
  "6. Call Commit(message) after each logical phase (e.g. 'feat: add " +
  "models', 'feat: wire up controllers'). One Commit per phase — not " +
  "one per file.\n" +
  "7. Monitor the remaining budget shown at the bottom of this system " +
  "message. When it gets low (reads ≤ 3, writes ≤ 1, or tokens ≤ 5 000) " +
  "call RequestCheckpoint to arm a one-time wrap-up reserve (5 reads + " +
  "2 writes + 10 K tokens). Then Commit any staged files and write your " +
  "summary. Do not start new work after RequestCheckpoint.\n" +
  "8. When done, reply with a short summary in plain text.\n\n" +
  "FILE SAFETY RULES:\n" +
  "- Never edit a file you have only partially read. When `Read` returns " +
  "`_truncated: true` (equivalently `read_complete: false`) you MUST call " +
  "`Read` again with `offset: next_offset` and continue until the file is " +
  "fully read. Using partial content as the basis for a Write or Edit " +
  "silently corrupts files — a real Unity refactor session once shipped " +
  "a `.cs` file ending mid-statement because the model edited from a " +
  "half-read view.\n" +
  "- The `Write` tool refuses overwrites where new content is < 80% of " +
  "the existing file size unless you pass `acknowledge_shrink: true`. " +
  "This shrink guard catches the partial-read-then-full-rewrite pattern. " +
  "If you hit it, re-Read the file in full before retrying — do NOT just " +
  "set the flag to bypass.\n" +
  "- Prefer `MultiEdit` over `Edit` for localized changes on large files. " +
  "`MultiEdit` applies an ordered array of `{find, replace}` pairs " +
  "atomically and is safer than re-issuing a full-file Edit.\n\n" +
  "REFACTOR SAFETY RULES:\n" +
  "- After renaming a symbol (variable, function, type, member) you MUST " +
  "grep for call sites across the repo. `Grep` only sees the default " +
  "branch — recent edits on the active feature branch will NOT appear " +
  "there. After a rename, also re-Read files you touched and any files " +
  "that might import the renamed symbol.\n" +
  "- A prior session shipped a Unity refactor where three files " +
  "compile-broke because callers of a renamed property were missed by " +
  "Grep. Treat Grep results as a hint, not as ground truth.\n" +
  "- The build gate (see BUILD RECOVERY FLOW below) is the safety net, " +
  "but earlier detection via explicit re-reads is cheaper than a build " +
  "round-trip.\n\n" +
  "TOOL GOTCHAS:\n" +
  "- `Grep` is keyword-only and indexed on the default branch. No regex, " +
  "no recent commits, no view of the active feature branch. For accurate " +
  "current-state reads of files you know the path of, prefer `Read`.\n" +
  "- `Edit` returns the full post-edit file contents in its result. Use " +
  "those contents to verify the edit landed — do NOT call `Read` on the " +
  "same file just to confirm an Edit. That wastes a tool slot and burns " +
  "budget.\n" +
  "- Do NOT call `Edit` on the same file twice in one loop unless the " +
  "first call returned an error. Consolidate all changes to each file " +
  "into a single Edit (or MultiEdit) call.\n" +
  "- `List` and `Grep` target the default branch; `Read` and the write " +
  "tools target the active feature branch when one exists.\n\n" +
  "COMMIT SEMANTICS:\n" +
  "- Write / Edit / Delete / MultiEdit STAGE changes locally. They do " +
  "not commit on their own. Staged operations show up as diff previews " +
  "in Discord but no GitHub commit lands until you call " +
  "`Commit(message)`.\n" +
  "- One Commit per logical phase — for example one Commit for 'feat: " +
  "add models' and a second for 'feat: wire up controllers'. NOT one " +
  "Commit per file. Phase boundaries matter; per-file commit spam " +
  "clutters the PR history.\n" +
  "- `Commit` takes a message string that becomes the GitHub commit " +
  "message for every file in the batch. Phrase it as a clear " +
  "feat/fix/refactor line of imperative intent.\n" +
  "- The staging area is capped at 20 files. If you hit this cap, call " +
  "Commit before staging more. Staging does NOT persist across bot " +
  "crashes — if the loop is interrupted before Commit fires, the staged " +
  "work is lost and must be re-staged.\n" +
  "- Always call Commit before reading any file you just staged — Read " +
  "targets the active feature branch, and uncommitted changes are " +
  "invisible there.\n\n" +
  "BUILD RECOVERY FLOW:\n" +
  "- After your final Commit, Onyx runs the project's build on a shallow " +
  "clone of the feature branch and posts any errors to the PR body.\n" +
  "- If the build fails, the user gets a `[🔁 Auto-fix]` button in " +
  "Discord. Clicking it re-enters this same agent loop with the build " +
  "errors injected as a synthetic user turn and a smaller " +
  "BUILD_FIX_BUDGET (10 reads / 5 writes / 30 K tokens).\n" +
  "- Maximum 3 auto-fix attempts per feature. After the third, the user " +
  "must /reset and start over. Use the budget conservatively in fix " +
  "loops — address the specific compile / type / lint issue reported, " +
  "not adjacent code that wasn't flagged.\n" +
  "- A failed build is not a hard error — it's an opportunity to fix " +
  "the exact issue without re-doing the whole plan.\n\n" +
  "Be concise. Use markdown but never tables (Discord doesn't render them).";

const REFINE_SYSTEM_PROMPT =
  "You are a programming buddy embedded in a Discord channel. You are " +
  "refining an existing feature via tools.\n\n" +
  "Context: The user already has an active feature with a PR open. Your " +
  "job is to make a small, focused change to this feature.\n\n" +
  "IMPORTANT CONSTRAINTS:\n" +
  "- Do NOT redesign or rewrite the feature.\n" +
  "- Only modify what is necessary for this refinement.\n" +
  "- Prefer editing existing files over creating new ones.\n\n" +
  "WORKFLOW:\n" +
  "1. Use Read / List / Grep to understand the specific area to change. " +
  "Be targeted — you're refining, not rebuilding.\n" +
  "2. Default: go straight to ExitPlanMode without asking questions. Only " +
  "pause to ask if a critical ambiguity would make the plan wrong (e.g. " +
  "which of two unrelated files to touch). Never ask for info you can " +
  "infer from the code or the intent.\n" +
  "3. Maintain a TodoWrite checklist; update it on every meaningful step.\n" +
  "4. When you have a concrete plan, call ExitPlanMode with the full plan " +
  "text. The bot pauses and shows [✅ Run] [✏️ Revise] [❌ Cancel].\n" +
  "5. After approval, use Write / Edit / Delete / MultiEdit to stage " +
  "changes. Diff previews post to Discord automatically.\n" +
  "6. Call Commit(message) after each logical phase — usually just one " +
  "Commit suffices for a refinement.\n" +
  "7. Monitor the remaining budget. When low (reads ≤ 3, writes ≤ 1, or " +
  "tokens ≤ 5 000) call RequestCheckpoint to arm a one-time wrap-up " +
  "reserve (5 reads + 2 writes + 10 K tokens). Then Commit and summarise. " +
  "Do not start new work after RequestCheckpoint.\n" +
  "8. When done, reply with a short summary in plain text.\n\n" +
  "FILE SAFETY RULES:\n" +
  "- Never edit a file you have only partially read. When `Read` returns " +
  "`_truncated: true` (equivalently `read_complete: false`) you MUST call " +
  "`Read` again with `offset: next_offset` and continue until the file is " +
  "fully read. Partial content as the basis for a Write or Edit silently " +
  "corrupts files.\n" +
  "- `Write` refuses overwrites where new content is < 80% of the " +
  "existing file size unless `acknowledge_shrink: true` is passed. If " +
  "you hit the guard, re-Read the file in full before retrying — do NOT " +
  "just set the flag to bypass.\n" +
  "- Prefer `MultiEdit` over `Edit` for localized changes on large " +
  "files. MultiEdit applies an array of `{find, replace}` pairs " +
  "atomically.\n\n" +
  "REFACTOR SAFETY RULES:\n" +
  "- After renaming a symbol you MUST grep for call sites. `Grep` only " +
  "sees the default branch; recent edits on the active feature branch " +
  "are invisible. Re-Read files you touched and any importers — a prior " +
  "Onyx session shipped a refactor where three files compile-broke " +
  "because callers of a renamed property were missed by Grep alone.\n" +
  "- A refinement is the wrong place for sweeping refactors. If you " +
  "find yourself touching more than 5 files, you're probably out of " +
  "scope — stop and surface that this should be a fresh /feature " +
  "instead, in plain text.\n" +
  "- The build gate (see BUILD RECOVERY FLOW below) is the safety net " +
  "for missed call sites, but earlier detection via explicit re-reads " +
  "is cheaper than a build round-trip.\n" +
  "- If the original feature spec was unclear about a constraint that's " +
  "now blocking your refinement (e.g. the user wants a behaviour change " +
  "that contradicts the approved plan), pause and surface the conflict " +
  "rather than silently changing the original design.\n\n" +
  "TOOL GOTCHAS:\n" +
  "- `Grep` is keyword-only and default-branch only. No regex, no recent " +
  "commits, no view of the active feature branch. Prefer `Read` on " +
  "known paths for current-state reads.\n" +
  "- `Edit` returns the full post-edit file contents in its result; do " +
  "NOT `Read` the same file afterward just to verify the edit. Burns " +
  "budget.\n" +
  "- Do NOT call `Edit` on the same file twice in one loop unless the " +
  "first call returned an error. Consolidate all changes per file into " +
  "one call.\n" +
  "- `List` and `Grep` target the default branch; `Read` and write " +
  "tools target the active feature branch when one exists.\n\n" +
  "COMMIT SEMANTICS:\n" +
  "- Write / Edit / Delete / MultiEdit STAGE changes locally. No GitHub " +
  "commit lands until you call `Commit(message)`.\n" +
  "- For a refinement, usually one Commit is enough. The message should " +
  "describe the specific change ('fix: validate empty input').\n" +
  "- Staging caps at 20 files; staging does NOT persist across bot " +
  "crashes. Commit promptly.\n" +
  "- Always Commit before reading any file you just staged — Read " +
  "targets the active feature branch, and uncommitted changes are " +
  "invisible there.\n\n" +
  "BUILD RECOVERY FLOW:\n" +
  "- After your final Commit the build gate runs on the feature branch. " +
  "Failures post to the PR body with an `[🔁 Auto-fix]` button.\n" +
  "- The auto-fix loop re-enters this agent with the build errors as a " +
  "synthetic user turn and a smaller BUILD_FIX_BUDGET (10 reads / " +
  "5 writes / 30 K tokens). Maximum 3 fix attempts per feature.\n" +
  "- Do not over-fix: address the specific compile / type error " +
  "reported, not adjacent code that wasn't flagged. Refinement scope " +
  "stays narrow even inside the auto-fix loop.\n\n" +
  "Be concise. Use markdown but never tables (Discord doesn't render them).";

// ---------------------------------------------------------------------------
// Unified session context helpers
// ---------------------------------------------------------------------------

/** Maximum non-system messages kept in session.messages before oldest are dropped. */
const MAX_SESSION_MESSAGES = 100;

/**
 * Write the agent loop's output messages back to `session.messages`.
 * Filters system messages by role (not by index), caps at MAX_SESSION_MESSAGES,
 * and adjusts runningAgent.cursor after any trim so resume always reconstructs
 * the correct slice. Exported so askRunner can reuse the same logic.
 */
export function syncMessages(session: Session, fullMessages: ChatCompletionMessageParam[]): void {
  const noSystem = fullMessages.filter((m) => m.role !== "system");
  const overrun = noSystem.length - MAX_SESSION_MESSAGES;
  if (overrun > 0) {
    session.messages = noSystem.slice(overrun);
    if (session.runningAgent) {
      session.runningAgent.cursor = Math.max(0, session.runningAgent.cursor - overrun);
    }
  } else {
    session.messages = noSystem;
  }
}

/**
 * Returns an `onIteration` callback to pass to `runAgent`/`resumeAgent`.
 * After each agent loop iteration's tool calls complete, syncs messages back
 * to the session (and persists the remaining budget) then flushes to disk so
 * a bot restart can recover mid-execution with the correct remaining budget.
 */
function makeOnIteration(args: FeatureRunnerArgs) {
  return (messages: ChatCompletionMessageParam[], budget?: AgentBudget) => {
    syncMessages(args.session, messages);
    if (budget && args.session.runningAgent) {
      args.session.runningAgent.budget = { ...budget };
    }
    flushSessionsToDisk();
  };
}

/**
 * If the running agent has staged file ops, flush them to GitHub before
 * pausing or running post-loop hooks (build gate, verification). The flush
 * must happen before those systems inspect the feature branch so they see
 * committed state, not staged-only-in-memory state.
 *
 * Uses the same incremental-shift contract as the Commit tool: entries are
 * removed from staging one by one after each successful commit, so a partial
 * failure leaves only the unprocessed entries in staging. Errors are logged
 * and swallowed per entry — the caller must proceed regardless.
 */
async function performAutoFlush(args: FeatureRunnerArgs): Promise<void> {
  const staging = args.session.runningAgent?.stagingArea;
  if (!staging || staging.length === 0) return;
  try {
    await safeSend(
      args.channel,
      `⚠️ Auto-committing ${staging.length} staged file(s) before pausing: ` +
        staging.map((e) => `\`${e.path}\``).join(", "),
    );
    const autoMsg = "feat: staged changes (auto-committed on pause)";
    while (staging.length > 0) {
      const entry = staging[0];
      try {
        const outcome = await commitChange({ ...entry, commitMessage: autoMsg }, args.session);
        recordTurn(args.session, {
          kind: entry.kind,
          paths: [entry.path],
          prompt: entry.prompt,
          summary: outcome.mode === "pr" ? outcome.summary : null,
          timestamp: Date.now(),
        });
        staging.shift();
        if (outcome.mode === "pr" && !args.session.active?.prAnnounced) {
          if (args.session.active) args.session.active.prAnnounced = true;
          await safeSend(
            args.channel,
            `📎 Opened **PR #${outcome.pr.number}** — ${outcome.pr.url}`,
          );
        }
      } catch (err) {
        console.error(`[featureRunner] Auto-flush failed for ${entry.path}:`, err);
        staging.shift(); // skip failing entry to avoid infinite loop
      }
    }
  } catch (err) {
    console.error("[featureRunner] Auto-flush outer error:", err);
  }
}

/**
 * Run one agent-loop invocation, turning a thrown model/transport error
 * (rate limit, invalid model id, provider outage) into a recoverable state
 * instead of leaving the channel stuck with `state: "running"`. Returns null
 * when the failure was handled. Only the loop is guarded — errors raised while
 * rendering its output still propagate to the interaction error handler.
 */
async function guardLoop(
  args: FeatureRunnerArgs,
  loop: () => Promise<RunAgentOutput>,
): Promise<RunAgentOutput | null> {
  try {
    return await loop();
  } catch (err) {
    await handleLoopFailure(args, err);
    return null;
  }
}

/**
 * Recover from a failed agent loop. Staged writes are committed first so no
 * work is lost. If the run made progress (messages synced past its cursor by
 * `onIteration`), pause with [▶️ Continue] [❌ Cancel] so the user can retry
 * from the last completed step. Otherwise clear the run: nothing happened,
 * so the command can simply be re-run. Exported for unit tests.
 */
export async function handleLoopFailure(args: FeatureRunnerArgs, err: unknown): Promise<void> {
  console.error("[featureRunner] Agent loop failed:", loggableError(err));
  const reason = errText(err);
  await performAutoFlush(args);
  const running = args.session.runningAgent;
  if (running && args.session.messages.length > running.cursor) {
    running.state = "awaiting-button";
    flushSessionsToDisk();
    await postLoopFailurePause(args, reason);
    return;
  }
  clearRunningAgent(args.session);
  await safeSend(
    args.channel,
    `❌ ${reason}\nNo changes were made in this run - run the command again when you're ready.`,
  );
}

/** Post the model-failure pause: the reason + [▶️ Continue] [❌ Cancel]. */
async function postLoopFailurePause(args: FeatureRunnerArgs, reason: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ namespace: "feature", action: "continue", scopeId: args.scopeId }),
      )
      .setLabel("Continue")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ namespace: "feature", action: "cancel", scopeId: args.scopeId }),
      )
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
  await args.channel.send({
    content:
      `⚠️ **The model call failed.** ${reason}\n` +
      "Progress up to the last completed step is saved. **Continue** retries from there; **Cancel** stops.",
    components: [row],
  });
}

/** State for one /feature loop, scoped to a single channel + session. */
export interface FeatureRunnerArgs {
  session: Session;
  channel: SendableChannels;
  scopeId: string;
  /** Discord user ID of the member who started this loop — only their messages are accepted as clarification replies. */
  initiatorId: string;
}

/** Kick off a brand-new /feature loop. Posts the banner first, then runs. */
export async function startFeature(args: FeatureRunnerArgs & { intent: string }): Promise<void> {
  await postPlanInProgressBanner(args.channel, args.intent);
  // Preserve plan text from any prior loop before overwriting runningAgent.
  if (args.session.active && args.session.runningAgent?.planText) {
    args.session.active.lastPlanText = args.session.runningAgent.planText;
  }
  const cursor = args.session.messages.length;
  setRunningAgent(
    args.session,
    {
      kind: "feature",
      state: "running",
      cursor,
      initiatorId: args.initiatorId,
      startedAt: Date.now(),
    },
    "plan",
  );
  const tools = buildToolRegistry(args);
  const stopTyping = startTypingIndicator(args.channel);
  try {
    const out = await guardLoop(args, () =>
      runAgent({
        system: FEATURE_SYSTEM_PROMPT,
        user: args.intent,
        initialMessages: args.session.messages,
        history: formatHistory(getRecentTurns(args.session)),
        tools,
        ctx: makeCtx(args.session),
        budget: { ...DEFAULT_BUDGET },
        onIteration: makeOnIteration(args),
      }),
    );
    if (out) await handleAgentOutput(args, out);
  } finally {
    stopTyping();
  }
}

/** Kick off a /refine loop against the active feature. */
export async function startRefine(args: FeatureRunnerArgs & { intent: string }): Promise<void> {
  const active = args.session.active;
  if (!active) {
    await safeSend(args.channel, "❌ No active feature to refine. Use `/feature` to start one.");
    return;
  }
  await postRefineBanner(args.channel, args.intent, active.title);
  // Preserve plan text from the prior loop before overwriting runningAgent.
  if (args.session.runningAgent?.planText) {
    active.lastPlanText = args.session.runningAgent.planText;
  }
  const cursor = args.session.messages.length;
  setRunningAgent(
    args.session,
    {
      kind: "refine",
      state: "running",
      cursor,
      initiatorId: args.initiatorId,
      startedAt: Date.now(),
    },
    "plan",
  );
  const tools = buildToolRegistry(args);
  const userPrompt = buildRefineUserPrompt(args.intent, active);
  const stopTyping = startTypingIndicator(args.channel);
  try {
    const out = await guardLoop(args, () =>
      runAgent({
        system: REFINE_SYSTEM_PROMPT,
        user: userPrompt,
        initialMessages: args.session.messages,
        history: formatHistory(getRecentTurns(args.session)),
        tools,
        ctx: makeCtx(args.session),
        budget: { ...DEFAULT_BUDGET },
        onIteration: makeOnIteration(args),
      }),
    );
    if (out) await handleAgentOutput(args, out);
  } finally {
    stopTyping();
  }
}

/** Build the user prompt for /refine with active-feature context. */
function buildRefineUserPrompt(intent: string, active: ActiveFeature): string {
  const files = Array.from(active.paths);
  const shown = files.slice(0, 10).join(", ");
  const more = files.length > 10 ? ` (+${files.length - 10} more)` : "";
  return [
    `Refinement intent: ${intent}`,
    ``,
    `Active feature: "${active.title}"`,
    `Files already touched: ${shown || "(none yet)"}${more}`,
    ``,
    `IMPORTANT: This is a small, focused refinement. Do NOT redesign or ` +
      `rewrite the feature. Only modify what is necessary. Prefer editing ` +
      `existing files over creating new ones.`,
  ].join("\n");
}

/** Post the refine banner to the channel. */
async function postRefineBanner(
  channel: SendableChannels,
  intent: string,
  title: string,
): Promise<void> {
  const banner =
    `🧠 **Refining feature:** *${title}*\n` +
    `Intent: *${truncate(intent)}*\n` +
    `Reply in this channel to continue, or \`/reset\` to exit.`;
  await safeSend(channel, truncate(banner));
}

const RETRY_DELETE_SYSTEM_PROMPT =
  "You are executing a single targeted delete operation. The user previously " +
  "declined a file deletion but has now reconsidered and wants to proceed. " +
  "Call the Delete tool immediately with the specified path, then reply with " +
  "a short confirmation. Do NOT enter plan mode — execute directly.";

/** Re-run a delete for a path the user previously cancelled and now wants to retry.
 *  Starts a fresh pr-mode mini-loop — no plan phase. */
export async function startRetryDeleteRun(args: FeatureRunnerArgs, path: string): Promise<void> {
  if (!args.session.active) return;
  const cursor = args.session.messages.length;
  setRunningAgent(
    args.session,
    {
      kind: "feature",
      state: "running",
      cursor,
      initiatorId: args.initiatorId,
      startedAt: Date.now(),
    },
    "pr",
  );
  const tools = buildToolRegistry(args);
  const stopTyping = startTypingIndicator(args.channel);
  try {
    const out = await guardLoop(args, () =>
      runAgent({
        system: RETRY_DELETE_SYSTEM_PROMPT,
        user: `Please delete \`${path}\`. The user has confirmed they want to proceed with this deletion.`,
        tools,
        ctx: makeCtx(args.session),
        budget: { ...BUILD_FIX_BUDGET },
        onIteration: makeOnIteration(args),
      }),
    );
    if (out) await handleAgentOutput(args, out);
  } finally {
    stopTyping();
  }
}

/** Resume an in-flight /feature loop with a new user input. */
export async function resumeFeature(args: FeatureRunnerArgs, next: ResumeInput): Promise<void> {
  // Build-fix fires after the agent already cleared on clean completion.
  // Reconstruct a fresh running-agent context so the rest of this function works normally.
  if (next.kind === "button-build-fix" && !args.session.runningAgent) {
    setRunningAgent(
      args.session,
      {
        kind: "feature",
        state: "running",
        cursor: args.session.messages.length,
        initiatorId: args.initiatorId,
        startedAt: Date.now(),
      },
      args.session.mode,
    );
  }

  const running = args.session.runningAgent;
  if (!running) {
    throw new Error("Cannot resume — no running agent on this session.");
  }
  let effectiveNext: ResumeInput = next;
  // Approval flips mode plan→pr; revise stays in plan; cancel restores.
  if (next.kind === "button-approve" && args.session.mode === "plan") {
    args.session.mode = "pr";
    running.state = "awaiting-user-text"; // back to listening
    if (!running.planText) {
      clearRunningAgent(args.session);
      await safeSend(
        args.channel,
        "❌ Could not resume: no plan text was found. The plan may have been lost. Please start a fresh `/feature` or `/refine`.",
      );
      return;
    }
    effectiveNext = { kind: "button-approve", planText: running.planText };
  }
  if (next.kind === "button-cancel") {
    clearRunningAgent(args.session);
    await safeSend(
      args.channel,
      "❌ Plan cancelled. Start a fresh `/feature` to continue, or `/reset` to wipe context.",
    );
    return;
  }
  // Track when this retry started so handleAgentOutput can detect if the model
  // gives up without attempting any writes (and re-surface the Retry button).
  if (next.kind === "button-retry") {
    running.retryStartedAt = Date.now();
  }

  // Build-fix: enforce retry ceiling then inject error text as a user-text turn.
  // Uses BUILD_FIX_BUDGET instead of a raw iteration cap.
  let resumeBudget: AgentBudget | undefined;
  if (next.kind === "button-build-fix") {
    const active = args.session.active;
    if (!active?.prNumber) {
      await safeSend(
        args.channel,
        "⚠️ No active PR — cannot auto-fix. Please start a new `/feature`.",
      );
      clearRunningAgent(args.session);
      return;
    }
    const attempts = (active.buildFixAttempts ?? 0) + 1;
    if (attempts > 3) {
      await safeSend(
        args.channel,
        "⛔ Max auto-fix attempts (3) reached — please review the build errors manually on GitHub.",
      );
      clearRunningAgent(args.session);
      return;
    }
    active.buildFixAttempts = attempts;
    const client = getClientForChannel(args.session.channelId);
    const prBody = await client.getPullRequestBody(active.prNumber);
    const errorText = extractBuildErrorsSection(prBody);
    const kind = await detectRepoKind(args.session.channelId, active.branch ?? "");
    effectiveNext = {
      kind: "user-text",
      text: [
        `Build failed (attempt ${attempts}/3). Fix ONLY the errors below — do not refactor unrelated code.`,
        `Build command: ${buildCommandLabel(kind)}`,
        `Errors:\n${errorText}`,
      ].join("\n\n"),
    };
    resumeBudget = { ...BUILD_FIX_BUDGET };
  } else if (next.kind === "button-continue") {
    // Budget exhausted — give a fresh DEFAULT_BUDGET for the continuation.
    // Budgets are per-continuation-session, not per-feature-task.
    resumeBudget = { ...DEFAULT_BUDGET };
  } else {
    // All other resumes (approve, retry, revise, user-text): continue with
    // whatever budget remained at the pause point, or default if none stored.
    resumeBudget = running.budget ? { ...running.budget } : { ...DEFAULT_BUDGET };
  }

  const systemPrompt = running.kind === "refine" ? REFINE_SYSTEM_PROMPT : FEATURE_SYSTEM_PROMPT;
  const priorMessages = args.session.messages.slice(running.cursor);
  const fullMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...priorMessages,
  ];
  const tools = buildToolRegistry(args);
  const stopTyping = startTypingIndicator(args.channel);
  try {
    const out = await guardLoop(args, () =>
      resumeAgent({
        messages: fullMessages,
        tools,
        ctx: makeCtx(args.session),
        next: effectiveNext,
        budget: resumeBudget,
        onIteration: makeOnIteration(args),
      }),
    );
    if (out) await handleAgentOutput(args, out);
  } finally {
    stopTyping();
  }
}

/** Build the full tool registry for one feature loop. */
function buildToolRegistry(args: FeatureRunnerArgs): readonly Tool[] {
  const writeHooks = makeWriteHooks(args);
  const planHooks = makePlanHooks(args);
  return [
    ...READ_TOOLS,
    ...buildWriteTools({ session: args.session, hooks: writeHooks }),
    ...buildPlanTools({
      session: args.session,
      hooks: planHooks,
      scopeId: args.scopeId,
    }),
  ];
}

function makeCtx(session: Session): ToolContext {
  return {
    mode: session.mode,
    activeBranch: session.active?.branch ?? undefined,
    channelId: session.channelId,
  };
}

/**
 * Persist the new pause state (or clear runningAgent on completion). Posts the
 * model's text either way. The pause state stores ONLY `messages` per the
 * "resume a conversation, not a process" rule. When the iteration cap fires,
 * stash the messages and surface [▶️ Continue] [✅ Finish] [❌ Cancel] buttons
 * instead of clearing — the user can resume.
 */
async function handleAgentOutput(args: FeatureRunnerArgs, out: RunAgentOutput): Promise<void> {
  if (out.paused) {
    await performAutoFlush(args);
    syncMessages(args.session, out.messages);
    if (args.session.runningAgent) {
      args.session.runningAgent.state =
        out.reason === "awaiting-button" ? "awaiting-button" : "awaiting-user-text";
    }
    flushSessionsToDisk();
    if (out.reason === "awaiting-user-text" && out.text.trim()) {
      await postClarificationPause(args, out.text);
    }
    // For awaiting-button (ExitPlanMode), the plan + buttons were already
    // posted by the tool; nothing more to render here.
    return;
  }
  if (out.truncated) {
    // Iteration cap fired — flush staging first so build/verify see committed state,
    // then pause and ask the user what to do.
    await performAutoFlush(args);
    syncMessages(args.session, out.messages);
    if (args.session.runningAgent) {
      args.session.runningAgent.state = "awaiting-button";
    }
    flushSessionsToDisk();
    const startedAt = args.session.runningAgent?.startedAt ?? 0;
    const summary = summarizeRecentProgress(args.session, startedAt);
    await postIterationCapPause(args, out.text, summary);
    return;
  }
  // Loop completed — but writes may have partially failed.
  const planText = args.session.runningAgent?.planText;
  const startedAt = args.session.runningAgent?.startedAt ?? 0;
  const active = args.session.active;

  if (out.hadToolError) {
    // Flush staging before pausing so partial writes land on the branch.
    await performAutoFlush(args);
    // Sync messages and stash state so [🔁 Retry] can resume from the exact failure point.
    syncMessages(args.session, out.messages);
    if (args.session.runningAgent) {
      args.session.runningAgent.state = "awaiting-button";
    }
    flushSessionsToDisk();
    await postToolErrorPause(args, out.text);
    return; // skip verification — writes may be incomplete
  }

  // Clean completion: clear agent and run verification if applicable.
  //
  // Special case: if this was a retry run and the model produced no write turns
  // since the retry started, it likely gave up without re-attempting the failed
  // operations (e.g. it already knows it lacks write access). Re-surface the
  // Retry button so the user can try again after fixing the underlying issue.
  const retryStartedAt = args.session.runningAgent?.retryStartedAt;
  if (retryStartedAt !== undefined) {
    const writeSinceRetry = (active?.turns ?? []).filter(
      (t) =>
        t.timestamp >= retryStartedAt &&
        (t.kind === "create" || t.kind === "edit" || t.kind === "delete"),
    );
    if (writeSinceRetry.length === 0) {
      await performAutoFlush(args);
      syncMessages(args.session, out.messages);
      if (args.session.runningAgent) {
        args.session.runningAgent.state = "awaiting-button";
        args.session.runningAgent.retryStartedAt = Date.now();
      }
      flushSessionsToDisk();
      await postToolErrorPause(args, out.text);
      return;
    }
  }

  // Flush any staged-but-not-committed items before build gate + verification
  // so those systems inspect committed branch state, not staged-only-in-memory state.
  await performAutoFlush(args);
  syncMessages(args.session, out.messages);
  // Before clearing, save this loop's plan to active for the next refine to reference.
  if (planText && active) {
    active.lastPlanText = planText;
  }
  clearRunningAgent(args.session);
  await sendLong(args.channel, out.text);
  // Post-execution hooks (build gate first, then semantic verification).
  // Build is a stronger signal — if it fails, skip semantic verify to avoid
  // contradictory "✅ match" + "❌ Build failed" on the same PR body.
  const { outcome: buildOutcome, kind: buildKind } = await runBuildStep(args);
  const effectivePlanText = planText ?? active?.lastPlanText;
  // Each skip is logged: a PR that silently lacks its Verification section is
  // indistinguishable from one where the verifier failed.
  if (buildOutcome === "failed") {
    console.log("[verify] skipped — the build gate failed; fix the build first.");
  } else if (!effectivePlanText) {
    console.log("[verify] skipped — no plan text on this run (nothing to compare against).");
  } else if (!active?.prNumber) {
    console.log("[verify] skipped — no pull request is open for this feature.");
  } else {
    // Skip verification if exec-phase todos are still pending — premature completion.
    // No exec-phase TodoWrite (null) → still verify.
    const execTodos = getLatestTodoListSince(active.turns, startedAt);
    const pending = execTodos?.filter((t) => t.status !== "completed") ?? [];
    if (pending.length > 0) {
      console.log(
        `[verify] skipped — ${pending.length} plan item(s) still pending: ` +
          pending.map((t) => t.content).join(", "),
      );
    } else {
      const diffSummary = buildDiffSummary(active.turns);
      if (!hasInformativeDiffSummary(diffSummary)) {
        // Record the build result and say plainly that the plan was not judged,
        // rather than letting the verifier invent a verdict from placeholders.
        console.log("[verify] skipped — no usable change summary to verify against.");
        await postUnverifiedSection(args, active.prNumber, {
          outcome: buildOutcome,
          kind: buildKind,
        });
      } else {
        await runVerification({
          planText: effectivePlanText,
          active,
          prNumber: active.prNumber,
          channelId: args.session.channelId,
          buildStatus: { outcome: buildOutcome, kind: buildKind },
        });
      }
    }
  }
}

/**
 * Post the tool-error pause: model summary text + [🔁 Retry] and [❌ Cancel]
 * buttons. Keeps the session alive so the user can retry failed operations
 * without restarting the whole workflow. Exported for unit tests.
 */
export async function postToolErrorPause(
  args: FeatureRunnerArgs,
  modelText: string,
): Promise<void> {
  if (modelText.trim()) {
    await sendLong(args.channel, modelText);
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ namespace: "feature", action: "retry", scopeId: args.scopeId }))
      .setLabel("Retry")
      .setEmoji("🔁")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ namespace: "feature", action: "cancel", scopeId: args.scopeId }),
      )
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
  await args.channel.send({
    content:
      "⚠️ **Some tool calls failed during this run.**\nUse **Retry** to attempt the failed operations again, or **Cancel** to stop.",
    components: [row],
  });
}

/** Verifier timeout — keep the post-execution hook from blocking forever. */
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Return the most recent TodoWrite snapshot whose turn was recorded after
 * `sinceMs`. Returns null if no TodoWrite was written in that window.
 * Used to detect premature clean-completion: if the latest exec-phase todo
 * still has pending items, the model likely returned text early rather than
 * finishing, so we skip verification to avoid a stale comment. Exported for
 * unit tests.
 */
export function getLatestTodoListSince(
  turns: readonly Turn[],
  sinceMs: number,
): readonly TodoItem[] | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.timestamp < sinceMs) break;
    if (t.kind === "tool" && t.prompt.startsWith("TodoWrite:")) {
      try {
        const parsed = JSON.parse(t.prompt.slice("TodoWrite:".length)) as unknown;
        if (Array.isArray(parsed)) return parsed as TodoItem[];
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Record the build result on the PR while stating the plan was not judged.
 * Used when there is nothing meaningful to verify against, so the PR never
 * carries a verdict the verifier did not actually reach.
 */
async function postUnverifiedSection(
  args: FeatureRunnerArgs,
  prNumber: number,
  buildStatus: import("../utils/prBody").BuildStatus,
): Promise<void> {
  try {
    const client = getClientForChannel(args.session.channelId);
    const body = await client.getPullRequestBody(prNumber);
    const updated = appendVerificationSection(
      body,
      { verdict: "partial", notes: VERIFY_UNAVAILABLE_NOTE },
      new Date(),
      buildStatus,
    );
    await client.updatePullRequest(prNumber, updated);
  } catch (err) {
    console.warn("[verify] could not record the unverified note:", loggableError(err));
  }
}

/**
 * Fire-and-await the plan-verification step: build a diff summary from the
 * loop's turns, ask the light-tier model whether the diff matches the plan,
 * then idempotently append a Verification section to the PR body. Errors
 * are swallowed; this never blocks the loop. Exported for unit tests.
 */
export async function runVerification(opts: {
  planText: string;
  active: ActiveFeature;
  prNumber: number;
  channelId: string;
  buildStatus?: import("../utils/prBody").BuildStatus;
}): Promise<void> {
  try {
    const diffSummary = buildDiffSummary(opts.active.turns);
    if (!diffSummary.trim()) return; // nothing to verify against
    const result = await Promise.race([
      verifyPlan({ planText: opts.planText, diffSummary }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("verify timeout")), VERIFY_TIMEOUT_MS),
      ),
    ]);
    const client = getClientForChannel(opts.channelId);
    const currentBody = await client.getPullRequestBody(opts.prNumber);
    const newBody = appendVerificationSection(currentBody, result, new Date(), opts.buildStatus);
    await client.updatePullRequest(opts.prNumber, newBody);
  } catch (err) {
    // Verifier never blocks the PR, but a silent swallow made a missing
    // Verification section impossible to explain after the fact.
    console.warn("[verify] verification step failed:", loggableError(err));
  }
}

/**
 * Run the build gate for the active feature branch. Returns outcome + detected
 * repo kind. Errors are swallowed — never blocks the PR. Exported for tests.
 */
export async function runBuildStep(
  args: FeatureRunnerArgs,
): Promise<{ outcome: "passed" | "failed" | "skipped"; kind: RepoKind | null }> {
  const active = args.session.active;
  if (!active?.branch || !active.prNumber) return { outcome: "skipped", kind: null };
  try {
    const kind = await detectRepoKind(args.session.channelId, active.branch);
    const result = await runBuildGate(kind, active.branch, args.session.channelId);

    if (result.skipped) {
      if (kind === "unknown") {
        // Leave a lightweight PR note — no Discord message
        const client = getClientForChannel(args.session.channelId);
        const body = await client.getPullRequestBody(active.prNumber);
        await client.updatePullRequest(active.prNumber, appendBuildSkippedNote(body));
      }
      return { outcome: "skipped", kind };
    }

    if (result.success) return { outcome: "passed", kind };

    // Build failed: update PR body and surface the auto-fix button
    const client = getClientForChannel(args.session.channelId);
    const body = await client.getPullRequestBody(active.prNumber);
    await client.updatePullRequest(active.prNumber, appendBuildErrorsSection(body, result.errors));
    await postBuildFailurePause(args, result.errors, result.kind);
    return { outcome: "failed", kind };
  } catch {
    return { outcome: "skipped", kind: null }; // never block the PR
  }
}

/** Post the build-failure pause: error count + [🔁 Auto-fix] [❌ Skip] buttons. */
async function postBuildFailurePause(
  args: FeatureRunnerArgs,
  errors: string[],
  kind: import("../services/buildGate").RepoKind,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ namespace: "feature", action: "build-fix", scopeId: args.scopeId }),
      )
      .setLabel("Auto-fix")
      .setEmoji("🔁")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ namespace: "feature", action: "cancel", scopeId: args.scopeId }),
      )
      .setLabel("Skip")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );
  await args.channel.send({
    content:
      `⚠️ **Build failed (${kind}) — ${errors.length} error(s) found.** ` +
      "Click **Auto-fix** to re-run the agent with the errors injected. Max 3 auto-fix cycles.",
    components: [row],
  });
}

/**
 * Extract the bulleted content from a `## Build Errors` section in a PR body.
 * Returns a plain-text block of error lines for injection into the agent loop.
 */
function extractBuildErrorsSection(body: string): string {
  const match = /## Build Errors\s*\n([\s\S]*?)(?=\n## |\s*$)/.exec(body);
  if (!match) return "(no build errors found in PR body)";
  // Strip markdown bullets and backticks for cleaner model injection
  return match[1]
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.replace(/^- `?/, "").replace(/`?$/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("_"))
    .join("\n");
}

/**
 * Render write turns since `sinceMs` as a flat text block fed to the verifier.
 * One line per turn: kind + path + per-turn summary.
 */
function buildDiffSummary(turns: readonly Turn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.kind !== "create" && t.kind !== "edit" && t.kind !== "delete") {
      continue;
    }
    const path = t.paths[0] ?? "(unknown)";
    const summary = t.summary?.trim() || "(no summary)";
    lines.push(`[${t.kind}] ${path}\n${summary}`);
  }
  return lines.join("\n\n");
}

/**
 * True when a diff summary carries something the verifier can actually judge.
 * Turn summaries come from a light-tier model call that can fail, leaving only
 * "(no summary)" placeholders — and a verifier handed those reports a confident
 * "mismatch" for a change that was in fact correct. Exported for tests.
 */
export function hasInformativeDiffSummary(summary: string): boolean {
  const informative = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line === "(no summary)" || line === "(summary unavailable)") return false;
      return !/^\[(create|edit|delete)\] /.test(line);
    });
  return informative.length > 0;
}

/**
 * Render the iteration-cap pause: progress summary + 3 buttons.
 * `[▶️ Continue]` resumes the loop; `[✅ Finish here]` accepts what's done;
 * `[❌ Cancel]` drops the session.
 */
async function postIterationCapPause(
  args: FeatureRunnerArgs,
  modelText: string,
  summary: ProgressSummary,
): Promise<void> {
  if (modelText.trim()) {
    await sendLong(args.channel, modelText);
  }
  const statusBlock = [
    "⚠️ **Budget exhausted.**",
    "",
    "**Progress so far:**",
    ...formatProgressBullets(summary),
  ].join("\n");
  await sendLong(args.channel, statusBlock);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({
          namespace: "feature",
          action: "continue",
          scopeId: args.scopeId,
        }),
      )
      .setLabel("Continue")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({
          namespace: "feature",
          action: "finish",
          scopeId: args.scopeId,
        }),
      )
      .setLabel("Finish here")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({
          namespace: "feature",
          action: "cancel",
          scopeId: args.scopeId,
        }),
      )
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
  await args.channel.send({ content: "What would you like to do?", components: [row] });
}

/**
 * Post the model's clarification question with a Cancel button so the user
 * knows to reply in chat and has a clear escape hatch. Exported for unit tests.
 */
export async function postClarificationPause(args: FeatureRunnerArgs, text: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({
          namespace: "feature",
          action: "cancel",
          scopeId: args.scopeId,
        }),
      )
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
  await sendLong(args.channel, text);
  await args.channel.send({ content: "💬 Reply in this channel to continue.", components: [row] });
}

/** Pretty-print a {@link ProgressSummary} as Discord-friendly bullets. */
export function formatProgressBullets(summary: ProgressSummary): string[] {
  const out: string[] = [];
  if (summary.created.length > 0) {
    out.push(
      `✅ ${summary.created.length} created (${summary.created.map((p) => `\`${p}\``).join(", ")})`,
    );
  }
  if (summary.edited.length > 0) {
    out.push(
      `✏️ ${summary.edited.length} edited (${summary.edited.map((p) => `\`${p}\``).join(", ")})`,
    );
  }
  if (summary.deleted.length > 0) {
    out.push(
      `🗑️ ${summary.deleted.length} deleted (${summary.deleted.map((p) => `\`${p}\``).join(", ")})`,
    );
  }
  if (summary.todos && summary.todos.length > 0) {
    const remaining = summary.todos.filter((t) => t.status !== "completed");
    if (remaining.length > 0) {
      out.push(`⏳ ${remaining.length} todo item(s) still pending`);
    } else {
      out.push("📝 All todo items completed");
    }
  }
  if (out.length === 0) {
    out.push("_(no commits landed yet)_");
  }
  return out;
}

function makeWriteHooks(args: FeatureRunnerArgs) {
  return {
    async postPreview(text: string): Promise<string> {
      // renderDiffPreview owns truncation; sending the body verbatim keeps a
      // single source of truth and avoids the cascading truncation marker.
      const msg = await args.channel.send(text);
      return msg.id;
    },
    async awaitConfirmation(messageId: string): Promise<boolean> {
      const msg = await fetchMessage(args.channel, messageId);
      if (!msg) return false;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId({ namespace: "confirm", action: "yes", scopeId: messageId }))
          .setLabel("Confirm Delete")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(encodeCustomId({ namespace: "confirm", action: "no", scopeId: messageId }))
          .setLabel("Cancel")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      try {
        await msg.edit({ content: msg.content, components: [row] });
      } catch {
        return false; // can't add buttons — treat as rejected
      }

      return registerPending(messageId);
    },
    async postCommitResult(text: string): Promise<void> {
      await safeSend(args.channel, truncate(text));
    },
    async postPullRequestLink(url: string, number: number): Promise<void> {
      if (args.session.active?.prAnnounced) return;
      if (args.session.active) args.session.active.prAnnounced = true;
      await safeSend(args.channel, `📎 Opened **PR #${number}** — ${url}`);
    },
    async postCancelledDelete(path: string): Promise<void> {
      const key = registerRetryDelete({
        channelId: args.channel.id,
        path,
        featureScopeId: args.scopeId,
      });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId({ namespace: "confirm", action: "retry-delete", scopeId: key }),
          )
          .setLabel("Retry Delete")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Secondary),
      );
      await args.channel.send({
        content: `⏭️ Skipped deleting \`${path}\`. Changed your mind?`,
        components: [row],
      });
    },
  };
}

function makePlanHooks(args: FeatureRunnerArgs) {
  let todoMessage: Message | null = null;
  return {
    async renderTodoList(items: readonly TodoItem[]): Promise<void> {
      if (args.session.mode === "plan") return; // don't show execution todos before approval
      const budget = args.session.runningAgent?.budget;
      const footer = budget ? getBudgetFooter(budget) : null;
      const body = renderTodoListMarkdown(items, footer);
      if (todoMessage) {
        try {
          await todoMessage.edit(truncate(body));
          return;
        } catch {
          todoMessage = null;
        }
      }
      todoMessage = await args.channel.send(truncate(body));
    },
    async postPlanForApproval(planText: string, scopeId: string): Promise<string> {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId({
              namespace: "feature",
              action: "approve",
              scopeId,
            }),
          )
          .setLabel("Run")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId({
              namespace: "feature",
              action: "revise",
              scopeId,
            }),
          )
          .setLabel("Revise")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(
            encodeCustomId({
              namespace: "feature",
              action: "cancel",
              scopeId,
            }),
          )
          .setLabel("Cancel")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Danger),
      );
      const chunks = splitMessage(`**Plan ready:**\n${planText}`);
      for (let i = 0; i < chunks.length - 1; i++) {
        await args.channel.send(chunks[i]);
      }
      const msg = await args.channel.send({
        content: chunks.at(-1)!,
        components: [row],
      });
      return msg.id;
    },
  };
}

/** Render a TodoWrite snapshot as a Discord-friendly checklist. */
export function renderTodoListMarkdown(items: readonly TodoItem[], footer?: string | null): string {
  if (items.length === 0) return "📝 *(empty checklist)*";
  const lines = items.map((it) => {
    const box = it.status === "completed" ? "✅" : it.status === "in_progress" ? "🔄" : "⬜";
    return `${box} ${it.content}`;
  });
  const body = ["**📝 Plan progress**", ...lines].join("\n");
  return footer ? `${body}\n${footer}` : body;
}

/**
 * Return a budget footer line for the TodoWrite progress message showing the
 * axis closest to exhaustion. Returns `null` when all axes are above 50% of
 * their defaults (plenty of budget — avoid noise).
 */
function getBudgetFooter(budget: AgentBudget): string | null {
  const axes = [
    { label: "reads", value: budget.reads, default: 50 },
    { label: "writes", value: budget.writes, default: 20 },
    { label: "tokens", value: budget.tokens, default: 200_000 },
  ];
  // Find the axis with the lowest ratio to its default.
  let minRatio = 1;
  let minAxis = axes[0];
  for (const ax of axes) {
    const ratio = ax.value / ax.default;
    if (ratio < minRatio) {
      minRatio = ratio;
      minAxis = ax;
    }
  }
  if (minRatio > 0.5) return null; // all axes healthy — no footer
  if (minAxis.label === "tokens") {
    return `⏱ ${Math.max(0, Math.round(minAxis.value / 1000))}K tokens left`;
  }
  return `⏱ ${Math.max(0, minAxis.value)} ${minAxis.label} left`;
}

async function postPlanInProgressBanner(channel: SendableChannels, intent: string): Promise<void> {
  const banner =
    `🧠 **Plan in progress** — *${truncate(intent)}*\n` +
    `Reply in this channel to continue, or \`/reset\` to exit.`;
  await safeSend(channel, truncate(banner));
}

async function safeSend(channel: SendableChannels, content: string): Promise<void> {
  await channel.send(content);
}

/**
 * Show a Discord typing indicator while the agent is running and return a
 * cleanup function that stops it. Errors are swallowed — this is best-effort.
 * Discord's indicator expires after ~10 s, so we refresh every 9 s.
 */
function startTypingIndicator(channel: SendableChannels): () => void {
  const tryTyping = () => {
    try {
      void (channel.sendTyping() as Promise<void>).catch(() => undefined);
    } catch {
      // best-effort — unavailable in certain channel types or test mocks
    }
  };
  tryTyping();
  const id = setInterval(tryTyping, 9000);
  return () => clearInterval(id);
}

async function fetchMessage(channel: SendableChannels, messageId: string): Promise<Message | null> {
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}
