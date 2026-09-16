import { MessageFlags } from "discord.js";
import { startRetryDeleteRun } from "../runtime/featureRunner";
import { getOrCreateSession, isBusy } from "../services/sessions";
import { peekRetryDelete, popRetryDelete } from "../utils/pendingConfirmations";
import type { ButtonHandler } from "./index";

const confirmRetryDelete: ButtonHandler = {
  namespace: "confirm",
  action: "retry-delete",
  async execute(i) {
    const key = i.customId.split(":")[2] ?? "";
    // Peek first so a "please wait" response doesn't consume the entry.
    const entry = peekRetryDelete(key);
    if (!entry) {
      await i.reply({
        content: "ℹ️ This retry button is no longer available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const session = getOrCreateSession(entry.channelId);
    if (isBusy(session)) {
      // Agent is still mid-run — don't consume the entry, let the user try again.
      await i.reply({
        content: "⏳ The agent is still running — please wait for it to finish first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!session.active) {
      popRetryDelete(key); // permanently unusable — consume it
      await i.reply({
        content: "⚠️ No active feature — the session may have been reset.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!i.channel?.isSendable()) {
      await i.reply({
        content: "❌ Cannot retry here — channel isn't sendable.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // All checks passed — consume the entry and start the retry run.
    popRetryDelete(key);
    await i.update({ components: [] });
    await startRetryDeleteRun(
      {
        session,
        channel: i.channel,
        scopeId: entry.featureScopeId,
        initiatorId: i.user.id,
      },
      entry.path,
    );
  },
};

export default confirmRetryDelete;
