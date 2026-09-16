import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { describeBotAccount } from "../services/github";
import { getRepoBinding } from "../services/repoStore";
import type { SlashCommand } from "../types";

const start: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("start")
    .setDescription("Walk through Onyx setup, step by step"),

  async execute(i) {
    const binding = getRepoBinding(i.channelId);
    const hasRepo = !!(binding.owner && binding.repo);
    const hasDefault =
      (process.env.GITHUB_OWNER || "").trim() && (process.env.GITHUB_REPO || "").trim();

    if (hasRepo) {
      const label = hasDefault ? binding.repo : `${binding.owner}/${binding.repo}`;
      await i.reply({
        content: [
          "✅ **You're all set!**",
          "",
          `Repo: \`${binding.owner}/${binding.repo}\``,
          "",
          "**Try your first feature:**",
          "`/feature <what you want>` — I'll plan it, then build it.",
          "",
          "Or type `/help` to see all commands.",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const bot = await describeBotAccount();
    await i.reply({
      content: [
        "👋 **Onyx is ready. Let's get you set up.**",
        "",
        "**1. Give me repo access**",
        `Invite ${bot} as a collaborator (permission: Write or Admin):`,
        "https://github.com/<owner>/<repo>/settings/access",
        "(Skip this if the repo already belongs to that account.)",
        "",
        "**2. Link this channel to your repo**",
        "`/repo set <owner> <repo>`",
        "",
        "**3. Start building**",
        "`/feature <what you want>` → I’ll break it down and help you build it.",
        "",
        "💡 **Tip:** Each channel is its own workspace — you can connect different repos in different channels.",
        "",
        "Type `/help` anytime to see what I can do.",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default start;
