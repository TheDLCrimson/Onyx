import { MessageFlags } from "discord.js";
import type { ModalHandler } from "../buttons";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";

const revisePlan: ModalHandler = {
  namespace: "modal",
  action: "revise",
  /** Modal submit — feed the user's new instructions back into the loop. */
  async execute(i) {
    if (!i.channelId) {
      await i.reply({
        content: "❌ Cannot revise — modal has no channel context.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content: "⚠️ No active plan to revise — this modal is stale.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!i.channel?.isSendable()) {
      await i.reply({
        content: "❌ Cannot resume here — channel isn't sendable.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const instructions = i.fields.getTextInputValue("revisionInstructions");
    await i.reply({
      content: "✏️ Revising the plan…",
      flags: MessageFlags.Ephemeral,
    });
    await resumeFeature(
      {
        session,
        channel: i.channel,
        scopeId: i.customId.split(":")[2] ?? "",
        initiatorId: session.runningAgent!.initiatorId,
      },
      { kind: "button-revise", instructions },
    );
  },
};

export default revisePlan;
