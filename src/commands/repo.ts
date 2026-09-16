import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { acceptRepoInvitations, createGithubClient, describeBotAccount } from "../services/github";
import {
  getRepoBinding,
  hasExplicitBinding,
  removeRepoBinding,
  setRepoBinding,
} from "../services/repoStore";
import type { SlashCommand } from "../types";

const repo: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Manage the GitHub repo bound to this channel")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Bind this channel to a GitHub repo")
        .addStringOption((o) =>
          o.setName("owner").setDescription("GitHub owner (user or org)").setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("repo").setDescription("Repository name").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("show").setDescription("Show the repo currently bound to this channel"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Remove the explicit binding, reverting to the bot's default repo"),
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === "show") {
      const binding = getRepoBinding(i.channelId);
      const label = hasExplicitBinding(i.channelId) ? "(explicit binding)" : "(bot default)";
      if (!binding.owner || !binding.repo) {
        await i.reply({
          content:
            "❌ No repo bound to this channel and no default configured.\n" +
            `Run \`/repo set <owner> <repo>\` and invite ${await describeBotAccount()} as a collaborator first.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await i.reply({
          content: `📦 **Repo:** \`${binding.owner}/${binding.repo}\` ${label}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === "clear") {
      removeRepoBinding(i.channelId);
      const fallback = getRepoBinding(i.channelId);
      const msg = fallback.owner
        ? `↩️ Cleared explicit binding. Falling back to default: \`${fallback.owner}/${fallback.repo}\``
        : "↩️ Cleared explicit binding. No default repo is configured — use `/repo set` to bind one.";
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }

    // sub === "set"
    const owner = i.options.getString("owner", true).trim();
    const repoName = i.options.getString("repo", true).trim();

    await i.deferReply({ flags: MessageFlags.Ephemeral });

    // Accept any pending repo invitations first — user may have just invited the bot.
    // This makes the bind instant once the invite is sent.
    await acceptRepoInvitations();

    // Validate access: confirm the repo exists and the bot has write permission.
    const client = createGithubClient(owner, repoName);
    const bot = await describeBotAccount();
    try {
      await client.getDefaultBranch();
    } catch {
      await i.editReply(
        `❌ Can't access \`${owner}/${repoName}\`. Make sure the repo exists and ${bot} has been invited:\n` +
          `https://github.com/${owner}/${repoName}/settings/access`,
      );
      return;
    }

    const hasWriteAccess = await client.checkBotIsCollaborator();
    if (!hasWriteAccess) {
      await i.editReply(
        `❌ ${bot} can read \`${owner}/${repoName}\` but does not have write access.\n` +
          `Invite it as a collaborator with **Write** or **Admin** permission:\n` +
          `https://github.com/${owner}/${repoName}/settings/access\n\n` +
          `Once invited and accepted, run \`/repo set\` again.`,
      );
      return;
    }

    setRepoBinding(i.channelId, { owner, repo: repoName });
    await i.editReply(
      `✅ This channel is now bound to \`${owner}/${repoName}\`.\n` +
        `All future commands in this channel will target that repo.`,
    );
  },
};

export default repo;
