import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { dropSession } from "../services/sessions";
import type { SlashCommand } from "../types";

const reset: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear the channel's Onyx session (active feature, history)"),

  /** Drop the channel's session. Doesn't touch the GitHub PR. */
  async execute(i) {
    const had = dropSession(i.channelId);
    const msg = had
      ? "✅ Session cleared. Next command starts fresh."
      : "ℹ️ No active session for this channel — already fresh.";
    await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
  },
};

export default reset;
