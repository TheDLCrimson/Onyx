import { Events, type Client } from "discord.js";

/** Bind the one-shot ready listener — logs the bot's tag once connected. */
export function register(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}`);
  });
}
