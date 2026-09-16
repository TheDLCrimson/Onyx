import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

/** Channel permissions Onyx needs: read the channel, post (incl. threads), embeds for /context. */
export const BOT_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
];

/**
 * OAuth2 URL that adds this bot to a server with the permissions above and
 * slash-command scope. Logged at startup so self-hosters don't have to
 * assemble it in the Discord developer portal.
 */
export function buildInviteUrl(clientId: string): string {
  const permissions = new PermissionsBitField([...BOT_PERMISSIONS]).bitfield.toString();
  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    integration_type: "0",
    scope: "bot applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
