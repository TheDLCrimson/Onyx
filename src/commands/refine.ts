import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { startRefine } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { SlashCommand } from "../types";
import { newScopeId } from "../utils/customId";
import { budgetExceededReply, isBudgetExceeded } from "../utils/usageLog";

const MIN_INTENT_LENGTH = 5;

const refine: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("refine")
    .setDescription("Refine the active feature: plan, approve, then execute")
    .addStringOption((o) =>
      o.setName("intent").setDescription("What you want to refine or add").setRequired(true),
    ),

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

    if (!session.active) {
      await i.reply({
        content: "❌ No active feature to refine. Use `/feature` to start one.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (isBudgetExceeded(i.channelId)) {
      await i.reply({ content: budgetExceededReply(), flags: MessageFlags.Ephemeral });
      return;
    }

    const intent = i.options.getString("intent", true).trim();
    if (intent.length < MIN_INTENT_LENGTH) {
      await i.reply({
        content: "🤔 Can you be a bit more specific about what you'd like to refine?",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!i.channel || !i.channel.isSendable()) {
      await i.reply({
        content: "❌ /refine must be run in a sendable text channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await i.reply({
      content: `🧠 Refining **${session.active.title}** — watch this channel for the plan.`,
      flags: MessageFlags.Ephemeral,
    });

    await startRefine({
      session,
      channel: i.channel,
      scopeId: newScopeId(),
      initiatorId: i.user.id,
      intent,
    });
  },
};

export default refine;
