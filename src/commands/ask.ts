import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { runAgent } from "../services/agent";
import { READ_TOOLS } from "../services/readTools";
import {
  formatHistory,
  getOrCreateSession,
  getRecentTurns,
  recordTurn,
} from "../services/sessions";
import type { SlashCommand } from "../types";
import { newScopeId } from "../utils/customId";
import { streamToInteraction } from "../utils/stream";
import { ASK_SYSTEM_PROMPT, postAskIterationCapPause } from "../runtime/askRunner";
import { syncMessages } from "../runtime/featureRunner";
import { budgetExceededReply, isBudgetExceeded } from "../utils/usageLog";

const ask: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask a question about the repo — the model picks what to read")
    .addStringOption((o) =>
      o.setName("question").setDescription("Your question").setRequired(true),
    ),

  /**
   * Run an agentic /ask: hand the model the read-tool registry and let it
   * decide what to fetch. When the iteration cap fires, pauses with
   * [▶️ Continue] [❌ Cancel] buttons rather than posting a truncated answer.
   */
  async execute(i) {
    if (isBudgetExceeded(i.channelId)) {
      await i.reply({ content: budgetExceededReply(), flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const question = i.options.getString("question", true);
    const session = getOrCreateSession(i.channelId);
    await i.editReply("⏳ Thinking…");

    // Capture cursor before the run so the resume slice is correct.
    const cursor = session.messages.length;

    const result = await runAgent({
      system: ASK_SYSTEM_PROMPT,
      user: question,
      tools: READ_TOOLS,
      ctx: {
        mode: session.mode,
        activeBranch: session.active?.branch ?? undefined,
        channelId: i.channelId,
      },
      // Full conversation history for rich context.
      initialMessages: session.messages,
      // Committed-work summary so the model understands what's already been done.
      history: formatHistory(getRecentTurns(session)),
      onToolCall: async (event) => {
        const arg = describeArgs(event.args);
        await i.editReply(`🔧 \`${event.name}\` ${arg}…`);
      },
    });

    if (!result.paused && result.truncated) {
      // Don't overwrite a paused feature's runningAgent — just show partial text.
      if (session.runningAgent) {
        await streamToInteraction(
          i,
          single(
            result.text +
              "\n\n⚠️ Tool-call limit reached. Resolve the active feature first, then retry `/ask`.",
          ),
        );
        return;
      }
      const channel = i.channel;
      if (!channel?.isSendable()) {
        // No sendable channel — fall back to posting text via the interaction.
        await streamToInteraction(i, single(result.text));
        return;
      }
      // Stash state so the Continue button can resume from here.
      session.runningAgent = {
        kind: "ask",
        state: "awaiting-button",
        cursor,
        initiatorId: i.user.id,
        startedAt: Date.now(),
      };
      syncMessages(session, result.messages);
      // Complete the deferred interaction before posting channel buttons.
      await i.editReply("⚠️ Tool-call limit reached — see below.");
      const scopeId = newScopeId();
      await postAskIterationCapPause(channel, scopeId, result.text);
      return;
    }

    // Normal path — persist Q&A so follow-up /ask calls have context.
    session.messages.push({ role: "user", content: question });
    session.messages.push({ role: "assistant", content: result.text });

    recordTurn(session, {
      kind: "ask",
      paths: [],
      prompt: question,
      summary: null,
      timestamp: Date.now(),
    });

    await streamToInteraction(i, single(result.text));
  },
};

/** Wrap a finished string as a one-chunk async generator for streamToInteraction. */
async function* single(text: string): AsyncGenerator<string, void, void> {
  yield text;
}

/** Best-effort one-line summary of a tool call's args, for status updates. */
function describeArgs(rawJson: string): string {
  try {
    const obj = JSON.parse(rawJson) as Record<string, unknown>;
    const path = typeof obj.path === "string" ? obj.path : null;
    const query = typeof obj.query === "string" ? obj.query : null;
    if (path) return `\`${path}\``;
    if (query) return `\`${query}\``;
    return "";
  } catch {
    return "";
  }
}

export default ask;
