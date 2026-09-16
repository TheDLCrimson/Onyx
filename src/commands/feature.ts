import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { startFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { SlashCommand } from "../types";
import { newScopeId } from "../utils/customId";
import { budgetExceededReply, isBudgetExceeded } from "../utils/usageLog";

const feature: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("feature")
    .setDescription("Start a multi-file feature: plan, approve, then execute")
    .addStringOption((o) =>
      o.setName("intent").setDescription("Vague description of what you want").setRequired(true),
    ),

  /** Enter plan mode and run the agent loop until it pauses or completes. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (isBusy(session)) {
      await i.reply({
        content: `⚠️ Channel is in plan mode (active feature: **${
          session.active?.title ?? "in progress"
        }**). Approve or cancel the plan first, or run \`/reset\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (isBudgetExceeded(i.channelId)) {
      await i.reply({ content: budgetExceededReply(), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.channel || !i.channel.isSendable()) {
      await i.reply({
        content: "❌ /feature must be run in a sendable text channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const intent = i.options.getString("intent", true);
    await i.reply({
      content: `🧠 Planning **${intent}** — watch this channel for clarifications and the plan.`,
      flags: MessageFlags.Ephemeral,
    });
    await startFeature({
      session,
      channel: i.channel,
      scopeId: newScopeId(),
      initiatorId: i.user.id,
      intent,
    });
  },
};

export default feature;
