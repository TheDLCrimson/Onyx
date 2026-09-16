import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { editFile } from "../services/llm";
import { commitChange } from "../services/commitFlow";
import { readFile } from "../services/github";
import {
  formatHistory,
  getOrCreateSession,
  getRecentTurns,
  isBusy,
  recordTurn,
} from "../services/sessions";
import type { SlashCommand } from "../types";
import { budgetExceededReply, isBudgetExceeded } from "../utils/usageLog";

const edit: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Edit an existing file with a natural-language instruction")
    .addStringOption((o) =>
      o.setName("path").setDescription("Repo-relative path").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("instruction").setDescription("What change to make").setRequired(true),
    ),

  /** Apply a natural-language instruction to an existing file and commit / PR. */
  async execute(i) {
    if (isBudgetExceeded(i.channelId)) {
      await i.reply({ content: budgetExceededReply(), flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const path = i.options.getString("path", true);
    const instruction = i.options.getString("instruction", true);
    const session = getOrCreateSession(i.channelId);
    if (isBusy(session)) {
      await i.editReply(
        `⚠️ Channel is in plan mode (active feature: **${
          session.active?.title ?? "in progress"
        }**). Approve or cancel the plan first, or run \`/reset\`.`,
      );
      return;
    }
    // When a feature branch is active, edit the version that lives on it
    // (commits made there may have outpaced the default branch).
    const branch = session.active?.branch ?? undefined;
    const existing = await readFile(path, branch);
    if (!existing) {
      const where = branch ? ` on branch \`${branch}\`` : "";
      await i.editReply(`❌ \`${path}\` not found${where}. Use /create first.`);
      return;
    }
    await i.editReply(`⏳ Editing \`${path}\`…`);
    const updated = await editFile(
      path,
      existing.content,
      instruction,
      formatHistory(getRecentTurns(session)),
    );
    const outcome = await commitChange(
      {
        kind: "edit",
        path,
        content: updated,
        prompt: instruction,
        sha: existing.sha,
      },
      session,
    );
    recordTurn(session, {
      kind: "edit",
      paths: [path],
      prompt: instruction,
      summary: outcome.mode === "pr" ? outcome.summary : null,
      timestamp: Date.now(),
    });
    if (outcome.mode === "pr") {
      await i.editReply(`✅ Edited \`${path}\`. PR: ${outcome.pr.url}`);
    } else {
      await i.editReply(`✅ Edited \`${path}\`.`);
    }
  },
};

export default edit;
