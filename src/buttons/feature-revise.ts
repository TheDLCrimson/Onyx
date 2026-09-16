import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { encodeCustomId } from "../utils/customId";
import type { ButtonHandler } from "./index";

const featureRevise: ButtonHandler = {
  namespace: "feature",
  action: "revise",
  /** ✏️ Revise — open a modal for the new instructions. */
  async execute(i) {
    const scopeId = i.customId.split(":")[2] ?? "";
    const modal = new ModalBuilder()
      .setCustomId(
        encodeCustomId({
          namespace: "modal",
          action: "revise",
          scopeId,
        }),
      )
      .setTitle("Revise the plan");
    const input = new TextInputBuilder()
      .setCustomId("revisionInstructions")
      .setLabel("How should the plan change?")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1500);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await i.showModal(modal);
  },
};

export default featureRevise;
