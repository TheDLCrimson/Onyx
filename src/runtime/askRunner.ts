import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type SendableChannels } from "discord.js";
import { resumeAgent } from "../services/agent";
import type { ResumeInput, RunAgentOutput } from "../services/agent";
import { READ_TOOLS } from "../services/readTools";
import { clearRunningAgent } from "../services/sessions";
import type { Session } from "../types";
import { encodeCustomId } from "../utils/customId";
import { errText, sendLong } from "../utils/discord";
import { loggableError } from "../utils/modelErrors";
import { syncMessages } from "./featureRunner";

export const ASK_SYSTEM_PROMPT =
  "You are a concise programming buddy embedded in a Discord channel. " +
  "You have read-only tools (Read, List, Grep) for exploring a GitHub " +
  "repository — use them to find what you need before answering. Prefer " +
  "List to discover structure, Grep to locate symbols on the default " +
  "branch, and Read to fetch a file's full contents. Use markdown when " +
  "helpful, but DO NOT use markdown tables — Discord does not render " +
  "them. Use bulleted or numbered lists instead. Keep answers tight.";

/** Args for the ask runner — channel context scoped to one /ask invocation. */
export interface AskRunnerArgs {
  session: Session;
  channel: SendableChannels;
  /** Button scope id embedded in customIds so handlers route to this ask. */
  scopeId: string;
}

/**
 * Resume an /ask paused by the iteration cap. Routes button-continue to
 * another agent loop iteration, and button-cancel to a clean teardown.
 */
export async function resumeAsk(args: AskRunnerArgs, next: ResumeInput): Promise<void> {
  const running = args.session.runningAgent;
  if (!running || running.kind !== "ask") return;

  if (next.kind === "button-cancel") {
    clearRunningAgent(args.session);
    await args.channel.send("❌ Ask cancelled.");
    return;
  }

  const priorMessages = args.session.messages.slice(running.cursor);
  const fullMessages = [{ role: "system" as const, content: ASK_SYSTEM_PROMPT }, ...priorMessages];
  const ctx = {
    mode: args.session.mode,
    activeBranch: args.session.active?.branch ?? undefined,
    channelId: args.session.channelId,
  };

  let out: RunAgentOutput;
  try {
    out = await resumeAgent({
      messages: fullMessages,
      tools: READ_TOOLS,
      ctx,
      next,
    });
  } catch (err) {
    // A failed model call must not leave the channel busy with a dead ask —
    // the Continue button is already gone, so nothing could resume it.
    console.error("[askRunner] Resume failed:", loggableError(err));
    clearRunningAgent(args.session);
    await args.channel.send(
      `❌ ${errText(err)}\nThe question was dropped - run \`/ask\` again when you're ready.`,
    );
    return;
  }

  if (!out.paused && out.truncated) {
    // Hit the cap again — sync and re-offer buttons.
    syncMessages(args.session, out.messages);
    await postAskIterationCapPause(args.channel, args.scopeId, out.text);
    return;
  }

  // Clean finish (paused/plan-mode can't occur here — all tools are read-only and non-pauseAfter).
  syncMessages(args.session, out.messages);
  clearRunningAgent(args.session);
  await sendLong(args.channel, out.text);
}

/**
 * Post the /ask iteration-cap message: partial model text + [▶️ Continue] [❌ Cancel].
 * No [✅ Finish here] button — /ask has no PR to attach to. Exported for unit tests.
 */
export async function postAskIterationCapPause(
  channel: SendableChannels,
  scopeId: string,
  modelText: string,
): Promise<void> {
  if (modelText.trim()) {
    await sendLong(channel, modelText);
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ namespace: "feature", action: "continue", scopeId }))
      .setLabel("Continue")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ namespace: "feature", action: "cancel", scopeId }))
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );
  await channel.send({
    content:
      "⚠️ **Tool-call limit reached.** The answer may be incomplete — continue to finish it.",
    components: [row],
  });
}
