import { MessageFlags } from "discord.js";
import { resolvePending } from "../utils/pendingConfirmations";
import type { ButtonHandler } from "./index";

const confirmNo: ButtonHandler = {
  namespace: "confirm",
  action: "no",
  async execute(i) {
    const messageId = i.customId.split(":")[2] ?? "";
    const wasPending = resolvePending(messageId, false);
    if (!wasPending) {
      await i.reply({ content: "ℹ️ Confirmation already handled.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.update({
      content: (i.message.content ?? "") + "\n❌ Delete cancelled.",
      components: [],
    });
  },
};

export default confirmNo;
