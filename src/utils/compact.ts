import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

/** Number of most-recent messages preserved verbatim by compaction. */
export const COMPACT_RECENT = 20;

/**
 * Summarise older messages into a plain-text block for context injection.
 * Skips tool-result messages (too verbose); extracts user requests, assistant
 * tool-call names, and final assistant text.
 */
export function compactMessages(messages: ChatCompletionMessageParam[]): string {
  const lines: string[] = ["[Earlier conversation — summarised:]"];
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      lines.push(`• User: ${msg.content.slice(0, 300)}`);
    } else if (msg.role === "assistant") {
      const m = msg as { content?: string | null; tool_calls?: { function?: { name: string } }[] };
      if (m.tool_calls?.length) {
        const names = m.tool_calls.map((tc) => tc.function?.name ?? "?").join(", ");
        lines.push(`• Called: ${names}`);
      } else if (m.content?.trim()) {
        lines.push(`• Said: ${m.content.slice(0, 300)}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Return an initialMessages array for a model call that needs session context
 * without sending the full history. When the session has more than
 * COMPACT_RECENT messages the older portion is compacted into a single summary
 * pair so the model gets the gist without a large token spend.
 */
export function buildAskContext(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (messages.length <= COMPACT_RECENT) return messages;
  const older = messages.slice(0, -COMPACT_RECENT);
  const recent = messages.slice(-COMPACT_RECENT);
  return [
    { role: "user", content: compactMessages(older) },
    { role: "assistant", content: "Understood." },
    ...recent,
  ];
}
