import { MessageFlags } from "discord.js";
import { resumeAsk } from "../runtime/askRunner";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureContinue: ButtonHandler = {
  namespace: "feature",
  action: "continue",
  /** ▶️ Continue — resume after the iteration cap fired (feature/refine or ask). */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content:
          "⚠️ No paused run to continue — this button is stale. Run `/feature` or `/ask` to start a new one.",
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
      await resumeAsk({ session, channel: i.channel, scopeId }, { kind: "button-continue" });
    } else {
      await resumeFeature(
        {
          session,
          channel: i.channel,
          scopeId,
          initiatorId: session.runningAgent!.initiatorId,
        },
        { kind: "button-continue" },
      );
    }
  },
};

export default featureContinue;
