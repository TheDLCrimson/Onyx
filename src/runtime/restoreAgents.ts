import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import {
  clearRunningAgent,
  flushSessionsToDisk,
  getChannelsNeedingRestore,
  getOrCreateSession,
} from "../services/sessions";
import { encodeCustomId } from "../utils/customId";
import { splitMessage } from "../utils/discord";

/**
 * Called once in the `ready` event after Discord connects. Iterates every
 * channel whose `runningAgent` was restored from disk (i.e. within
 * `ONYX_RESUME_WINDOW_MINUTES`), posts a resume message with action buttons,
 * and normalises `state: "running"` → `"awaiting-button"` since the loop is
 * no longer executing. Channels that are no longer reachable have their
 * `runningAgent` cleared so they don't block future commands.
 */
export async function restoreRunningAgents(client: Client): Promise<void> {
  const channelIds = getChannelsNeedingRestore();
  if (channelIds.length > 0) {
    console.log(`[restore] ${channelIds.length} channel(s) have an in-flight agent to restore.`);
  }

  for (const channelId of channelIds) {
    const session = getOrCreateSession(channelId);
    const agent = session.runningAgent;
    if (!agent) continue;

    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.isSendable()) {
        console.log(`[restore] Channel ${channelId} not sendable — clearing agent.`);
        clearRunningAgent(session);
        continue;
      }

      // Normalise: if the bot crashed while the loop was running (not paused),
      // mark it as awaiting-button so the resume path works correctly.
      if (agent.state === "running") {
        agent.state = "awaiting-button";
        flushSessionsToDisk();
      }

      const title = session.active?.title ?? "in-progress feature";
      // Use channelId as scopeId — stable across restarts. Button handlers look
      // up sessions by interaction.channelId, not by the encoded scopeId.
      const scopeId = channelId;

      if (agent.planText) {
        // Plan was ready but bot restarted before or during execution.
        // Re-surface the plan with Approve / Cancel so the user can decide.
        const header = `🔄 **Bot restarted** — resuming: **"${title}"**\n\n**Pending plan:**\n${agent.planText}`;
        const chunks = splitMessage(header);
        for (const chunk of chunks) await ch.send(chunk);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ namespace: "feature", action: "approve", scopeId }))
            .setLabel("Run plan")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ namespace: "feature", action: "cancel", scopeId }))
            .setLabel("Cancel")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger),
        );
        await ch.send({ content: "Approve or cancel to continue.", components: [row] });
      } else {
        // Mid-execution (no pending plan text) — offer Continue / Cancel.
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ namespace: "feature", action: "continue", scopeId }))
            .setLabel("Continue")
            .setEmoji("▶️")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ namespace: "feature", action: "cancel", scopeId }))
            .setLabel("Cancel")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger),
        );
        await ch.send({
          content:
            `🔄 **Bot restarted** — resuming: **"${title}"**\n` +
            `Click **Continue** to pick up where we left off, or **Cancel** to stop.`,
          components: [row],
        });
      }

      console.log(`[restore] Posted resume prompt for channel ${channelId} ("${title}").`);
    } catch {
      // Channel unreachable or unexpected API error — clear and move on.
      console.log(`[restore] Failed to restore channel ${channelId} — clearing agent.`);
      clearRunningAgent(session);
    }
  }
}
