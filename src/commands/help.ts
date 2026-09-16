import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types";

const help: SlashCommand = {
  data: new SlashCommandBuilder().setName("help").setDescription("Show Onyx command usage"),

  /** Reply (ephemerally) with the bot's command list. */
  async execute(i) {
    await i.reply({
      content: [
        "**Onyx — Discord programming buddy**",
        "",
        "**Write files**",
        "`/create <path> <description>` — generate a new file from a description",
        "`/edit <path> <instruction>` — modify an existing file",
        "",
        "**Agentic features**",
        "`/feature <vague intent>` — plan + execute a multi-file feature (enters plan mode)",
        "`/refine <intent>` — modify the active feature (same loop, pre-filled context)",
        "",
        "**Explore the repo**",
        "`/ask <question>` — ask about the repo (remembers prior questions, full context)",
        "`/btw <question>` — quick question with amnesia (no session trace)",
        "",
        "**Session management**",
        "`/session` — show active feature + recent activity",
        "`/context` — show session stats (message count, tokens, status)",
        "`/compact` — compress old messages into a summary",
        "`/reset` — clear session (doesn't close the PR)",
        "",
        "**Repo binding**",
        "`/repo set <owner> <repo>` — bind this channel to a GitHub repo",
        "`/repo show` — show the repo currently bound to this channel",
        "`/repo clear` — remove the binding, reverting to the bot's default repo",
        "",
        "**Getting started**",
        "`/start` — walk through setup, step by step (new users start here)",
        "`/help` — show this message",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default help;
