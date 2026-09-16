import type { ModalHandler } from "../buttons";
import revisePlan from "./revise-plan";

/** All modal handlers — routed by parsed customId namespace+action. */
export const modalHandlers: readonly ModalHandler[] = [revisePlan];
