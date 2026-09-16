import { MessageFlags } from "discord.js";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureBuildFix: ButtonHandler = {
  namespace: "feature",
  action: "build-fix",
  /** 🔁 Auto-fix — resume after build failure to fix the reported errors. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!session.active?.prNumber) {
      await i.reply({
        content: "⚠️ No active feature — this button is stale. Run `/feature` to start a new one.",
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
        initiatorId: session.runningAgent?.initiatorId ?? i.user.id,
      },
      { kind: "button-build-fix" },
    );
  },
};

export default featureBuildFix;
