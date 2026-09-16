import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

/**
 * One Button handler — bound by `customId` namespace+action. The router
 * dispatches via `parseCustomId(interaction.customId)` and looks up by
 * `(namespace, action)`.
 */
export interface ButtonHandler {
  namespace: string;
  action: string;
  execute(interaction: ButtonInteraction): Promise<void>;
}

/** One Modal handler. Same routing shape as buttons. */
export interface ModalHandler {
  namespace: string;
  action: string;
  execute(interaction: ModalSubmitInteraction): Promise<void>;
}

import confirmNo from "./confirm-no";
import confirmRetryDelete from "./confirm-retry-delete";
import confirmYes from "./confirm-yes";
import featureApprove from "./feature-approve";
import featureBuildFix from "./feature-build-fix";
import featureCancel from "./feature-cancel";
import featureContinue from "./feature-continue";
import featureFinish from "./feature-finish";
import featureRetry from "./feature-retry";
import featureRevise from "./feature-revise";

/** All button handlers — interactionCreate dispatches via parsed customId. */
export const buttonHandlers: readonly ButtonHandler[] = [
  featureApprove,
  featureRevise,
  featureCancel,
  featureContinue,
  featureFinish,
  featureRetry,
  featureBuildFix,
  confirmYes,
  confirmNo,
  confirmRetryDelete,
];
