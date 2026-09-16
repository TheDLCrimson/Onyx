import { Events, type Client, type Message } from "discord.js";
import { resumeFeature } from "../runtime/featureRunner";
import { answerQuestion, editFile, generateFile } from "../services/llm";
import { commitChange } from "../services/commitFlow";
import { readFile } from "../services/github";
import {
  formatHistory,
  getOrCreateSession,
  getRecentTurns,
  recordTurn,
} from "../services/sessions";
import type { CommandKind, ParsedCommand, Session } from "../types";
import { errText, replyLong } from "../utils/discord";

/** Min length for a channel message to be fed back to a paused agent. */
const PLAN_REPLY_MIN_LENGTH = 4;

/** Bind the prefix-command (`!create` / `!edit` / `!ask`) fallback handler. */
export function register(client: Client): void {
  client.on(Events.MessageCreate, (msg) => {
    void handle(msg);
  });
}

async function handle(msg: Message): Promise<void> {
  if (msg.author.bot) return;

  // 1. Prefix commands take priority — same behaviour as before.
  const cmd = parse(msg.content);
  if (cmd) {
    if ("sendTyping" in msg.channel) await msg.channel.sendTyping();
    try {
      const session = getOrCreateSession(msg.channelId);
      const reply = await dispatch(cmd, session);
      if (msg.channel.isSendable()) {
        await replyLong({ reply: (c: string) => msg.reply(c), channel: msg.channel }, reply);
      } else {
        await msg.reply(reply);
      }
    } catch (err) {
      await msg.reply(`❌ ${errText(err)}`);
    }
    return;
  }

  // 2. Otherwise: if the channel has a paused /feature loop awaiting user
  //    text, feed this message in as the next turn.
  const session = getOrCreateSession(msg.channelId);
  const running = session.runningAgent;
  if (
    running &&
    running.state === "awaiting-user-text" &&
    msg.author.id === running.initiatorId &&
    msg.content.trim().length >= PLAN_REPLY_MIN_LENGTH &&
    msg.channel.isSendable()
  ) {
    try {
      await resumeFeature(
        { session, channel: msg.channel, scopeId: "msg", initiatorId: running.initiatorId },
        { kind: "user-text", text: msg.content.trim() },
      );
    } catch (err) {
      await msg.reply(`❌ ${errText(err)}`);
    }
  }
}

/** Parse a Discord message into a prefix command. Grammar: `!<kind> <path> <body...>`. */
export function parse(raw: string): ParsedCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("!")) return null;
  const [head, path, ...rest] = trimmed.slice(1).split(/\s+/);
  const kind = head as CommandKind;
  if (kind !== "create" && kind !== "edit" && kind !== "ask") return null;
  if (!path || rest.length === 0) return null;
  return { kind, path, body: rest.join(" ") };
}

/** Run the right model + GitHub flow for the parsed prefix command. */
async function dispatch(cmd: ParsedCommand, session: Session): Promise<string> {
  const branch = session.active?.branch ?? undefined;
  switch (cmd.kind) {
    case "create": {
      const existing = await readFile(cmd.path, branch);
      if (existing) throw new Error(`\`${cmd.path}\` already exists. Use !edit instead.`);
      const content = await generateFile(cmd.path, cmd.body);
      const outcome = await commitChange(
        {
          kind: "create",
          path: cmd.path,
          content,
          prompt: cmd.body,
        },
        session,
      );
      recordTurn(session, {
        kind: "create",
        paths: [cmd.path],
        prompt: cmd.body,
        summary: outcome.mode === "pr" ? outcome.summary : null,
        timestamp: Date.now(),
      });
      const suffix = outcome.mode === "pr" ? ` PR: ${outcome.pr.url}` : "";
      const verb = outcome.mode === "pr" && outcome.attached ? "Added" : "Created";
      return `✅ ${verb} \`${cmd.path}\` (${content.length} bytes).${suffix}`;
    }
    case "edit": {
      const existing = await readFile(cmd.path, branch);
      if (!existing) throw new Error(`\`${cmd.path}\` not found. Use !create first.`);
      const updated = await editFile(cmd.path, existing.content, cmd.body);
      const outcome = await commitChange(
        {
          kind: "edit",
          path: cmd.path,
          content: updated,
          prompt: cmd.body,
          sha: existing.sha,
        },
        session,
      );
      recordTurn(session, {
        kind: "edit",
        paths: [cmd.path],
        prompt: cmd.body,
        summary: outcome.mode === "pr" ? outcome.summary : null,
        timestamp: Date.now(),
      });
      const suffix = outcome.mode === "pr" ? ` PR: ${outcome.pr.url}` : "";
      return `✅ Edited \`${cmd.path}\`.${suffix}`;
    }
    case "ask": {
      const existing = await readFile(cmd.path, branch);
      if (!existing) throw new Error(`\`${cmd.path}\` not found.`);
      const history = formatHistory(getRecentTurns(session));
      const answer = await answerQuestion(cmd.path, existing.content, cmd.body, history);
      recordTurn(session, {
        kind: "ask",
        paths: [cmd.path],
        prompt: cmd.body,
        summary: null,
        timestamp: Date.now(),
      });
      return answer;
    }
  }
}
