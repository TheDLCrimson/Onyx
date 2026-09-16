import { MessageFlags } from "discord.js";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureRetry: ButtonHandler = {
  namespace: "feature",
  action: "retry",
  /** 🔁 Retry — resume after a tool-error completion to re-attempt failed operations. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content:
          "⚠️ No paused run to retry — this button is stale. Run `/feature` to start a new one.",
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
    await resumeFeature(
      {
        session,
        channel: i.channel,
        scopeId: i.customId.split(":")[2] ?? "",
        initiatorId: session.runningAgent!.initiatorId,
      },
      { kind: "button-retry" },
    );
  },
};

export default featureRetry;
