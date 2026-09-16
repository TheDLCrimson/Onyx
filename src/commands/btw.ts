import { SlashCommandBuilder } from "discord.js";
import { runAgent } from "../services/agent";
import { READ_TOOLS } from "../services/readTools";
import { formatHistory, getOrCreateSession, getRecentTurns } from "../services/sessions";
import type { SlashCommand } from "../types";
import { streamToInteraction } from "../utils/stream";

const BTW_SYSTEM_PROMPT =
  "You are a concise programming buddy embedded in a Discord channel. " +
  "You have read-only tools (Read, List, Grep) for exploring a GitHub " +
  "repository — use them to find what you need before answering. Prefer " +
  "List to discover structure, Grep to locate symbols on the default " +
  "branch, and Read to fetch a file's full contents. Use markdown when " +
  "helpful, but DO NOT use markdown tables — Discord does not render " +
  "them. Use bulleted or numbered lists instead. Keep answers tight.";

const btw: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("btw")
    .setDescription("Quick exploratory question — ephemeral, doesn't pollute feature context")
    .addStringOption((o) =>
      o.setName("question").setDescription("Your question").setRequired(true),
    ),

  /**
   * Ephemeral /ask: explore the repo without accumulating context.
   * Unlike /ask, this doesn't write back to session.messages, so the question
   * won't affect the next /feature or /refine run.
   */
  async execute(i) {
    await i.deferReply();
    const question = i.options.getString("question", true);
    const session = getOrCreateSession(i.channelId);
    await i.editReply("⏳ Thinking…");

    const result = await runAgent({
      system: BTW_SYSTEM_PROMPT,
      user: question,
      tools: READ_TOOLS,
      ctx: {
        mode: session.mode,
        activeBranch: session.active?.branch ?? undefined,
        channelId: i.channelId,
      },
      // Committed-work summary so the model understands what's already been done.
      // Note: we don't pass initialMessages — /btw is amnesia by design.
      history: formatHistory(getRecentTurns(session)),
      onToolCall: async (event) => {
        const arg = describeArgs(event.args);
        await i.editReply(`🔧 \`${event.name}\` ${arg}…`);
      },
    });

    // NO recording — /btw is intentionally ephemeral.
    // The question leaves no trace on session.messages or session.turns.

    // /btw is ephemeral (no stored context), so we can't resume after truncation.
    // Surface a note so the user knows the answer is incomplete.
    const text =
      !result.paused && result.truncated
        ? result.text +
          "\n\n⚠️ Tool-call limit reached. Use `/ask` (which stores context) to continue this question."
        : result.text;

    await streamToInteraction(i, single(text));
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

export default btw;
