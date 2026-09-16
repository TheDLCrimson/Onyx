import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import "dotenv/config";
import { registerEvents } from "./events";
import { loadBindings } from "./services/repoStore";
import { loadPersistedSessions } from "./services/sessions";
import { assertEnv } from "./utils/env";
import { acceptRepoInvitations, getBotLogin } from "./services/github";
import { buildInviteUrl } from "./utils/invite";
import { commandData } from "./commands";
import { restoreRunningAgents } from "./runtime/restoreAgents";

assertEnv();
loadBindings();
loadPersistedSessions();

// Accept any pending repo invitations on startup.
// The /repo set command also calls this before validating access.
void acceptRepoInvitations();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

registerEvents(client);

/** Register slash commands for all guilds the bot is in. */
async function registerCommands(): Promise<void> {
  const token = (process.env.DISCORD_TOKEN || "").trim();
  const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
  const guildIdOverride = (process.env.DISCORD_GUILD_ID || "").trim();

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID — skipping command registration.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildIdOverride) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildIdOverride), {
      body: commandData,
    });
    console.log(`Registered commands — guild ${guildIdOverride} (override).`);
    return;
  }

  const guilds = client.guilds.cache;
  console.log(`Registering commands for ${guilds.size} guild(s)...`);

  let successCount = 0;
  for (const [guildId, guild] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
      successCount++;
      console.log(`  Registered for ${guild.name} (${guildId})`);
    } catch (err) {
      console.error(`  FAILED for ${guild.name} (${guildId}):`, err);
    }
  }

  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commandData });
    console.log("Registered commands globally (safety net for new guilds).");
  } catch (err) {
    console.error("Global registration failed:", err);
  }

  console.log(`Command registration done: ${successCount}/${guilds.size} guilds, + global.`);
}

client.once(Events.ClientReady, async () => {
  // "Logged in as …" is logged by events/ready.ts.
  const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
  if (clientId) console.log(`Invite URL: ${buildInviteUrl(clientId)}`);
  const botLogin = await getBotLogin();
  console.log(
    botLogin
      ? `GitHub identity: ${botLogin} (commits and PRs are made as this account)`
      : "GitHub identity: unknown — check GITHUB_TOKEN.",
  );
  await registerCommands();
  await restoreRunningAgents(client);
});

// A rejected promise that reaches the top level would terminate the process
// under Node's default policy, dropping every channel's session. Log loudly
// and keep serving; uncaught exceptions still exit so the container restarts.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaught exception — exiting:", error);
  process.exit(1);
});

void client.login(process.env.DISCORD_TOKEN);
