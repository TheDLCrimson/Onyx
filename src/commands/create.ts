import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { generateFile } from "../services/llm";
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

const create: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("create")
    .setDescription("Create a new file from a natural-language description")
    .addStringOption((o) =>
      o
        .setName("path")
        .setDescription("Repo-relative path (e.g. src/util/log.ts)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("description").setDescription("What the file should do").setRequired(true),
    ),

  /** Generate a brand-new file and either open a PR or commit directly. */
  async execute(i) {
    if (isBudgetExceeded(i.channelId)) {
      await i.reply({ content: budgetExceededReply(), flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const path = i.options.getString("path", true);
    const description = i.options.getString("description", true);
    const session = getOrCreateSession(i.channelId);
    if (isBusy(session)) {
      await i.editReply(
        `⚠️ Channel is in plan mode (active feature: **${
          session.active?.title ?? "in progress"
        }**). Approve or cancel the plan first, or run \`/reset\`.`,
      );
      return;
    }
    const branch = session.active?.branch ?? undefined;
    const existing = await readFile(path, branch);
    if (existing) {
      const where = branch ? ` on branch \`${branch}\`` : "";
      await i.editReply(`❌ \`${path}\` already exists${where}. Use /edit instead.`);
      return;
    }
    await i.editReply(`⏳ Creating \`${path}\`…`);
    const content = await generateFile(path, description, formatHistory(getRecentTurns(session)));
    const outcome = await commitChange(
      { kind: "create", path, content, prompt: description },
      session,
    );
    recordTurn(session, {
      kind: "create",
      paths: [path],
      prompt: description,
      summary: outcome.mode === "pr" ? outcome.summary : null,
      timestamp: Date.now(),
    });
    if (outcome.mode === "pr") {
      const verb = outcome.attached ? "Added" : "Created";
      await i.editReply(`✅ ${verb} \`${path}\` (${content.length} bytes). PR: ${outcome.pr.url}`);
    } else {
      await i.editReply(`✅ Created \`${path}\` (${content.length} bytes).`);
    }
  },
};

export default create;
