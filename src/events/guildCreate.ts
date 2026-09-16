import { Client, Guild, TextChannel, REST, Routes } from "discord.js";
import { commandData } from "../commands";
import { describeBotAccount } from "../services/github";

/**
 * Fires when the bot joins a new server (guild).
 * Sends a brief onboarding message to the system channel or the first
 * available text channel where the bot can write messages.
 */
export function register(client: Client): void {
  client.on("guildCreate", async (guild: Guild) => {
    // Register slash commands for the new guild (instant availability).
    const token = (process.env.DISCORD_TOKEN || "").trim();
    const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
    if (token && clientId) {
      try {
        const rest = new REST({ version: "10" }).setToken(token);
        await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commandData });
        console.log(`Registered commands for new guild: ${guild.name} (${guild.id})`);
      } catch (err) {
        console.error(`Failed to register commands for new guild ${guild.name}:`, err);
      }
    }

    const system = guild.systemChannel;
    let target: TextChannel | null = system && system.isTextBased() ? system : null;

    if (!target) {
      const found = guild.channels.cache.find(
        (ch): ch is TextChannel =>
          ch.isTextBased() && ch.permissionsFor(guild.members.me!)?.has("SendMessages"),
      );
      target = found ?? null;
    }

    if (!target) return;

    try {
      const bot = await describeBotAccount();
      await target.send({
        content: [
          "👋 **Onyx is online.**",
          "",
          "I'm your AI dev partner — I help you plan, refine, and build features directly in your repo.",
          "",
          "⚡ **Quick setup (takes ~30 seconds):**",
          "",
          "**1. Give me repo access**",
          `Invite ${bot} as a **collaborator** (skip if the repo already belongs to that account):`,
          "https://github.com/<owner>/<repo>/settings/access",
          "",
          "**2. Link this channel to your repo**",
          "`/repo set <owner> <repo>`",
          "",
          "🧠 **Then you're ready:**",
          "`/feature <what you want>` → I'll break it down + start building",
          "",
          "💡 Tip: Each channel = its own workspace. You can connect different repos in different channels.",
          "",
          "Type `/help` to explore more commands.",
        ].join("\n"),
      });
    } catch {
      // Channel may have been deleted or permissions revoked between lookup and send.
    }
  });
}
