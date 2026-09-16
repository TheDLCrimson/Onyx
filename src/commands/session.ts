import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getOrCreateSession } from "../services/sessions";
import type { ActiveFeature, SlashCommand } from "../types";

const session: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("session")
    .setDescription("Show the channel's active Onyx feature, mode, and recent activity"),

  /** Read-only snapshot of the current session. Always allowed regardless of mode. */
  async execute(i) {
    const s = getOrCreateSession(i.channelId);
    const age = formatAge(Date.now() - s.lastUsedAt);
    const lastLine = age === "just now" ? "just now" : `${age} ago`;
    const lines = [
      `**Mode:** \`${s.mode}\``,
      `**Active feature:** ${formatActive(s.active)}`,
      `**Last activity:** ${lastLine}`,
    ];
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  },
};

function formatActive(f: ActiveFeature | null): string {
  if (!f) return "_none_";
  const paths = f.paths.size > 0 ? [...f.paths].join(", ") : "_(none yet)_";
  const pr = f.prNumber !== null ? `PR #${f.prNumber}` : "(no PR opened yet)";
  return [
    `**${f.title}**`,
    `  • ${pr}`,
    `  • Branch: \`${f.branch ?? "(pending)"}\``,
    `  • Files touched: ${paths}`,
  ].join("\n");
}

/** Render an elapsed-ms duration as "2d", "4h", "12m", or "just now". */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default session;
