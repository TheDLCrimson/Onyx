import { MessageFlags } from "discord.js";
import { resumeAsk } from "../runtime/askRunner";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureCancel: ButtonHandler = {
  namespace: "feature",
  action: "cancel",
  /** ❌ Cancel — drop the in-flight plan / ask and restore prePlanMode. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content: "ℹ️ No active run to cancel.",
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
    await i.update({ components: [] });
    const scopeId = i.customId.split(":")[2] ?? "";
    if (session.runningAgent?.kind === "ask") {
      await resumeAsk({ session, channel: i.channel, scopeId }, { kind: "button-cancel" });
    } else {
      await resumeFeature(
        {
          session,
          channel: i.channel,
          scopeId,
          initiatorId: session.runningAgent!.initiatorId,
        },
        { kind: "button-cancel" },
      );
    }
  },
};

export default featureCancel;
