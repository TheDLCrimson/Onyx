import type { Client } from "discord.js";
import { register as registerGuildCreate } from "./guildCreate";
import { register as registerInteractionCreate } from "./interactionCreate";
import { register as registerMessageCreate } from "./messageCreate";
import { register as registerReady } from "./ready";

/** Wire all Discord event listeners onto the client. */
export function registerEvents(client: Client): void {
  registerReady(client);
  registerGuildCreate(client);
  registerInteractionCreate(client);
  registerMessageCreate(client);
}
