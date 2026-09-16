import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { SlashCommand } from "../types";
import { COMPACT_RECENT, buildAskContext } from "../utils/compact";

const compact: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription(
      "Compress older conversation context into a summary, keeping the last 20 messages intact",
    ),

  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const session = getOrCreateSession(i.channelId);

    if (isBusy(session)) {
      await i.editReply(
        "⏳ An agent is currently running — wait for it to finish before compacting.",
      );
      return;
    }

    const before = session.messages.length;
    if (before <= COMPACT_RECENT) {
      await i.editReply(
        `Nothing to compact — session has ${before} message${before === 1 ? "" : "s"} (threshold is ${COMPACT_RECENT}).`,
      );
      return;
    }

    session.messages = buildAskContext(session.messages);
    const compacted = before - COMPACT_RECENT;
    await i.editReply(
      `✅ Compacted ${compacted} older message${compacted === 1 ? "" : "s"} into a summary.\n` +
        `Last ${COMPACT_RECENT} messages preserved in full. Session: ${before} → ${session.messages.length} messages.`,
    );
  },
};

export default compact;
