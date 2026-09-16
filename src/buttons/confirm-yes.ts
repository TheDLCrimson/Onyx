import { MessageFlags } from "discord.js";
import { resolvePending } from "../utils/pendingConfirmations";
import type { ButtonHandler } from "./index";

const confirmYes: ButtonHandler = {
  namespace: "confirm",
  action: "yes",
  async execute(i) {
    // scopeId (third segment) IS the preview message ID registered in pendingConfirmations.
    const messageId = i.customId.split(":")[2] ?? "";
    const wasPending = resolvePending(messageId, true);
    if (!wasPending) {
      await i.reply({ content: "ℹ️ Confirmation already handled.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.update({
      content: (i.message.content ?? "") + "\n✅ Delete confirmed.",
      components: [],
    });
  },
};

export default confirmYes;
