import {
  Events,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { buttonHandlers } from "../buttons";
import { commands } from "../commands";
import { modalHandlers } from "../modals";
import { errText } from "../utils/discord";
import { parseCustomId } from "../utils/customId";
import { loggableError } from "../utils/modelErrors";

/**
 * Bind the slash + button + modal router. Slash commands look up by name;
 * buttons and modals route via their parsed `customId` (namespace + action).
 */
export function register(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void route(interaction);
  });
}

/**
 * Discord invalidates an interaction token 3 s after it is created. When the
 * gateway hands us one that is already near that age, every reply path fails
 * with "Unknown interaction" (10062) however fast the handler is, and the user
 * sees a dead command with no explanation. Measured against `createdTimestamp`,
 * so it reflects delivery lag rather than handler cost.
 */
const STALE_INTERACTION_MS = 2_500;

/** How long ago Discord created this interaction. */
function interactionAgeMs(interaction: Interaction): number {
  return Date.now() - interaction.createdTimestamp;
}

/** Short label for logs and messages: command name, custom id, or type. */
function describeInteraction(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) return `/${interaction.commandName}`;
  if (interaction.isButton()) return `button ${interaction.customId}`;
  if (interaction.isModalSubmit()) return `modal ${interaction.customId}`;
  return "interaction";
}

/**
 * Tell the user in-channel that their command or click arrived too late to be
 * answered, instead of letting Discord show a bare failure. Exported for tests.
 */
export async function noteStaleInteraction(interaction: Interaction, ageMs: number): Promise<void> {
  const label = describeInteraction(interaction);
  console.warn(
    `[interaction] ${label} arrived ${ageMs}ms after Discord created it ` +
      `(tokens expire at 3000ms) — gateway lag, replying in-channel instead.`,
  );
  try {
    const channel = "channel" in interaction ? interaction.channel : null;
    if (channel && channel.isSendable()) {
      const notice =
        `⚠️ ${label} reached me too late for Discord to accept a reply ` +
        `(network lag between Discord and this bot). Nothing ran — please try again.`;
      await channel.send(notice);
    }
  } catch (err) {
    console.error("[interaction] could not post the stale-interaction notice:", loggableError(err));
  }
}

async function route(interaction: Interaction): Promise<void> {
  const ageMs = interactionAgeMs(interaction);
  if (ageMs > STALE_INTERACTION_MS) {
    await noteStaleInteraction(interaction, ageMs);
    return;
  }
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      await replyError(interaction, err);
    }
    return;
  }
  if (interaction.isButton()) {
    await routeButton(interaction);
    return;
  }
  if (interaction.isModalSubmit()) {
    await routeModal(interaction);
    return;
  }
}

async function routeButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const handler = buttonHandlers.find(
    (h) => h.namespace === parsed.namespace && h.action === parsed.action,
  );
  if (!handler) return;
  try {
    await handler.execute(interaction);
  } catch (err) {
    await replyError(interaction, err);
  }
}

async function routeModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const handler = modalHandlers.find(
    (h) => h.namespace === parsed.namespace && h.action === parsed.action,
  );
  if (!handler) return;
  try {
    await handler.execute(interaction);
  } catch (err) {
    await replyError(interaction, err);
  }
}

/**
 * Report a handler failure to the user. Never throws: Discord rejects a second
 * acknowledgement of the same interaction (error 40060) and expires tokens after
 * 15 minutes, and an unhandled rejection here would take the whole bot down.
 * Exported for tests.
 */
export async function replyError(
  interaction: Extract<Interaction, { reply: unknown }>,
  err: unknown,
): Promise<void> {
  const text = `❌ ${errText(err)}`;
  // Log first: the delivery attempt below may fail, and the original cause is
  // what an operator needs.
  console.error("[interaction] handler failed:", loggableError(err));
  const alreadyAcknowledged =
    "deferred" in interaction &&
    "replied" in interaction &&
    (interaction.deferred || interaction.replied);
  try {
    if (alreadyAcknowledged) {
      await interaction.editReply(text);
    } else {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
    return;
  } catch (deliveryErr) {
    console.warn("[interaction] first error reply failed:", loggableError(deliveryErr));
  }
  // Fall back to a follow-up — covers the race where the interaction was
  // acknowledged after the flags above were read.
  try {
    if ("followUp" in interaction) {
      await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (followUpErr) {
    console.warn("[interaction] error follow-up failed:", loggableError(followUpErr));
  }
  // Last resort: the interaction is unusable (expired token, or Discord and
  // discord.js disagree about whether it was acknowledged). Post in the channel
  // so the click does not fail silently. Not ephemeral — there is no
  // interaction left to scope it to.
  try {
    const channel = "channel" in interaction ? interaction.channel : null;
    if (channel && channel.isSendable()) {
      await channel.send(text);
    }
  } catch (channelErr) {
    console.error(
      "[interaction] could not deliver the error to Discord:",
      loggableError(channelErr),
    );
  }
}
