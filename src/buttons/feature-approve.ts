import { MessageFlags } from "discord.js";
import { resumeFeature } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureApprove: ButtonHandler = {
  namespace: "feature",
  action: "approve",
  /** ✅ Run — flip mode plan→pr and resume the agent loop with approval. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content:
          "⚠️ No paused plan to approve — this button is stale. Run `/feature` to start a new one.",
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
        scopeId: pickScopeId(i.customId),
        initiatorId: session.runningAgent!.initiatorId,
      },
      { kind: "button-approve" },
    );
  },
};

function pickScopeId(customId: string): string {
  // customId format guaranteed by the encoder: "feature:approve:<scopeId>"
  return customId.split(":")[2] ?? "";
}

export default featureApprove;
