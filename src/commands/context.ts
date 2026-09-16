import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { getOrCreateSession } from "../services/sessions";
import type { SlashCommand } from "../types";
import { COMPACT_RECENT } from "../utils/compact";
import { getChannelEntries, rollupCost } from "../utils/usageLog";

/** Colour constants for embed. */
const COLOR_OK = 0x57f287; // green
const COLOR_WARN = 0xfee75c; // yellow
const COLOR_IDLE = 0x5865f2; // blurple

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(messages: { content?: unknown }[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
  }
  return Math.round(chars / 4);
}

const context: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("context")
    .setDescription(
      "View the current session context — message count, compaction, agent, and mode",
    ),

  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const session = getOrCreateSession(i.channelId);

    const total = session.messages.length;

    // Detect if the oldest messages have already been compacted.
    const firstMsg = session.messages[0];
    const isCompacted =
      total > 0 &&
      firstMsg?.role === "user" &&
      typeof firstMsg.content === "string" &&
      firstMsg.content.startsWith("[Earlier conversation — summarised:]");

    // --- Messages field ---
    let messagesValue: string;
    if (total === 0) {
      messagesValue = "Empty — no history yet.";
    } else if (isCompacted) {
      const recent = total - 2; // subtract the 2 summary-pair messages
      messagesValue =
        `**${total}** messages ` +
        `*(1 compacted summary + 1 ack + **${recent}** recent in full)*\n` +
        `Use \`/compact\` again only after more messages accumulate.`;
    } else if (total > COMPACT_RECENT) {
      const older = total - COMPACT_RECENT;
      messagesValue =
        `**${total}** messages ` +
        `*(${older} older + **${COMPACT_RECENT}** recent)*\n` +
        `> 💡 Run \`/compact\` to compress the older ${older} into a summary (~${COMPACT_RECENT + 2} total).`;
    } else {
      messagesValue = `**${total}** messages — all preserved in full (under the ${COMPACT_RECENT}-message threshold).`;
    }

    // --- Token estimate ---
    const tokenEst = estimateTokens(session.messages);
    const tokenValue = `~${tokenEst.toLocaleString()} tokens`;

    // --- Session cost (rolling 24h for this channel) ---
    const costEntries = getChannelEntries(i.channelId);
    const costUsd = rollupCost(costEntries);
    const costValue = `$${costUsd.toFixed(4)} (24h rolling)`;

    // --- Prompt cache effectiveness (rolling 24h, only entries with cache fields) ---
    const cacheEntries = costEntries.filter((e) => typeof e.cachedTokens === "number");
    let cacheValue: string;
    if (cacheEntries.length === 0) {
      cacheValue = "No data yet — caching kicks in once a /feature runs.";
    } else {
      const cached = cacheEntries.reduce((s, e) => s + (e.cachedTokens ?? 0), 0);
      const prompt = cacheEntries.reduce((s, e) => s + e.promptTokens, 0);
      const hitPct = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
      // Anthropic cache-read price is 0.1× input — savings ≈ cached × 0.9 × per-token price.
      // We don't know the per-token price here, so estimate via the entries' own cost ratio:
      // savings ≈ cached / prompt × (sum of entry costs) × 0.9.
      const sumCost = cacheEntries.reduce((s, e) => s + e.costUsd, 0);
      const savedUsd = prompt > 0 ? (cached / prompt) * sumCost * 0.9 : 0;
      cacheValue = `**${hitPct}%** hits over last 24h (saved ~$${savedUsd.toFixed(4)})`;
    }

    // --- Mode field ---
    const modeEmoji: Record<string, string> = {
      plan: "📋",
      pr: "🔀",
      direct: "⚡",
    };
    const modeDesc: Record<string, string> = {
      plan: "**plan** — write tools locked; awaiting approval",
      pr: "**pr** — normal; writes open PRs",
      direct: "**direct** — writes commit straight to default branch",
    };
    const modeValue = `${modeEmoji[session.mode] ?? "❓"} ${modeDesc[session.mode] ?? session.mode}`;

    // --- Agent field ---
    let agentValue: string;
    if (!session.runningAgent) {
      agentValue = "None — idle";
    } else {
      const ra = session.runningAgent;
      const stateEmoji: Record<string, string> = {
        running: "⚙️",
        "awaiting-button": "🔘",
        "awaiting-user-text": "💬",
      };
      const elapsed = Math.round((Date.now() - ra.startedAt) / 1000);
      agentValue =
        `${stateEmoji[ra.state] ?? "❓"} \`${ra.kind}\` in **${ra.state}**\n` +
        `Started ${elapsed}s ago · cursor @ msg ${ra.cursor}`;
    }

    // --- Active feature field ---
    let featureValue: string;
    if (!session.active) {
      featureValue = "None — use \`/feature <intent>\` to start one.";
    } else {
      const f = session.active;
      const pr = f.prNumber ? `PR #${f.prNumber}` : "no PR yet";
      const branch = f.branch ? `\`${f.branch}\`` : "no branch yet";
      const paths = f.paths.size;
      featureValue =
        `**${f.title}**\n` + `${pr} · ${branch} · ${paths} file${paths === 1 ? "" : "s"} touched`;
    }

    // --- Pick embed colour ---
    let color = COLOR_IDLE;
    if (session.runningAgent) color = COLOR_WARN;
    else if (total > 0) color = COLOR_OK;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle("📊 Session Context")
      .addFields(
        { name: "💬 Messages", value: messagesValue, inline: false },
        { name: "🪙 Est. Tokens", value: tokenValue, inline: true },
        { name: "💰 Session Cost", value: costValue, inline: true },
        { name: "📦 Prompt Cache", value: cacheValue, inline: false },
        { name: "🔑 Mode", value: modeValue, inline: false },
        { name: "🤖 Agent", value: agentValue, inline: false },
        { name: "✨ Active Feature", value: featureValue, inline: false },
      )
      .setFooter({ text: "Only this channel's session is shown · /compact to reduce context" })
      .setTimestamp();

    await i.editReply({ embeds: [embed] });
  },
};

export default context;
