import { getClientForChannel } from "./github";
import type { Tool, ToolContext } from "./tools";
import { TOOL_RESULT_PAGE_SIZE } from "./tools";

/**
 * The `Read` tool — fetch a file's contents with pagination. Large files are
 * returned in pages of up to TOOL_RESULT_PAGE_SIZE chars; the model follows
 * `next_offset` to read subsequent pages.
 */
export const readTool: Tool = {
  name: "Read",
  description:
    "Returns the contents of a file at the given repo-relative path, " +
    "starting from `offset` (default 0). Reads from the session's active " +
    "feature branch if one exists, otherwise the default branch. Returns a " +
    "JSON object: " +
    "`{content, offset, next_offset, total_lines, bytes_remaining, _truncated, read_complete}`. " +
    "**If `_truncated` is true (equivalently `read_complete` is false) you " +
    "MUST call Read again with `offset: next_offset` before editing that " +
    "file — partial content must not be used as the basis for a Write or " +
    "Edit.** " +
    "Returns an error if the path does not exist or is a directory — use " +
    "List for directories.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Repo-relative path, e.g. "src/index.ts".',
      },
      offset: {
        type: "integer",
        description:
          "Character offset from the start of the file. Default 0. " +
          "Pass the `next_offset` value from the previous response to read the next page.",
        minimum: 0,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isReadOnly: true,
  isDestructive: false,
  async execute(args, ctx: ToolContext) {
    const path = requireString(args, "path");
    const offset = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset)) : 0;
    const client = getClientForChannel(ctx.channelId ?? "");
    const file = await client.readFile(path, ctx.activeBranch);
    if (!file) throw new Error(`Path not found: ${path}`);

    const full = file.content;
    const totalLines = full.split("\n").length;
    const slice = full.slice(offset, offset + TOOL_RESULT_PAGE_SIZE);
    const nextOffset = offset + slice.length;
    const bytesRemaining = Math.max(0, full.length - nextOffset);
    const truncated = bytesRemaining > 0;

    return JSON.stringify({
      content: slice,
      offset,
      next_offset: nextOffset,
      total_lines: totalLines,
      bytes_remaining: bytesRemaining,
      _truncated: truncated,
      read_complete: !truncated,
    });
  },
};

/**
 * The `List` tool — list a directory's children. Use `""` or `"/"` for repo
 * root. Output is one `path\ttype` line per entry.
 */
export const listTool: Tool = {
  name: "List",
  description:
    "Returns the names of files and subdirectories at the given repo-" +
    'relative directory path (use "" or "/" for the repo root). Reads ' +
    "from the active feature branch when set. Use this to discover what " +
    "files exist before deciding what to Read. Output: one `path<TAB>type` " +
    "line per entry, where type is `file` or `dir`.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Directory path. Empty string or "/" for the repo root.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isReadOnly: true,
  isDestructive: false,
  async execute(args, ctx: ToolContext) {
    const path = requireString(args, "path");
    const client = getClientForChannel(ctx.channelId ?? "");
    const entries = await client.listDirectory(path, ctx.activeBranch);
    if (entries === null) throw new Error(`Directory not found: ${path}`);
    if (entries.length === 0) return "(empty directory)";
    return entries.map((e) => `${e.path}\t${e.type}`).join("\n");
  },
};

/**
 * The `Grep` tool — search code via GitHub's code-search index. Default-branch
 * only; doesn't see recent commits or the active feature branch (use Read on
 * a known path for those).
 */
export const grepTool: Tool = {
  name: "Grep",
  description:
    "Searches indexed code on the repo's default branch via GitHub code-" +
    "search. NEVER conclude a file is missing from a Grep result: the index " +
    "lags pushes by minutes, the endpoint allows only about 10 searches per " +
    "minute before refusing, and it never sees the active feature branch. An " +
    "empty result or an error means 'search could not tell you', not 'the code " +
    "does not exist' — confirm with List (browse a directory) or Read (open a " +
    "known path) before telling the user something is absent. Does not support " +
    "regex; matches keywords with optional `path:` qualifier (e.g. `useState " +
    "path:src/components`). Output: one `path<TAB>url` line per match, up to " +
    "`limit` matches (default 20).",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Code-search query. Keywords plus optional `path:`, `language:`, " +
          "`extension:` qualifiers.",
      },
      limit: {
        type: "integer",
        description: "Max matches to return. Default 20, max 50.",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isReadOnly: true,
  isDestructive: false,
  async execute(args, ctx: ToolContext) {
    const query = requireString(args, "query");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const client = getClientForChannel(ctx.channelId ?? "");
    let matches;
    try {
      matches = await client.searchCode(query, Math.min(50, Math.max(1, limit)));
    } catch (err) {
      if (isSearchUnavailable(err)) {
        // Thrown so the dispatcher marks it a tool error and the model reacts.
        // Observed live: a burst of searches hit the ~10/minute cap, Grep came
        // back empty, and the model told the user their merged code did not exist.
        throw new Error(
          "GitHub code search refused this query (rate limit is about 10 searches " +
            "per minute). This says nothing about whether the code exists. Use List " +
            "to browse directories and Read to open known paths instead.",
        );
      }
      throw err;
    }
    if (matches.length === 0) {
      return (
        "(no matches) — GitHub's code index lags recent pushes and never covers the " +
        "active feature branch, so a file can exist with no matches here. Confirm " +
        "with List or Read before concluding it is absent."
      );
    }
    return matches.map((m) => `${m.path}\t${m.url}`).join("\n");
  },
};

/** The full read-tool registry available to /ask in PR B. */
export const READ_TOOLS: readonly Tool[] = [readTool, listTool, grepTool];

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`Argument \`${key}\` is required and must be a string.`);
  }
  return v;
}

/**
 * True when GitHub refused a code search rather than answering it: 403 is the
 * secondary rate limit (about 10 searches/minute), 429 the primary one.
 * Exported for tests.
 */
export function isSearchUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { status: unknown }).status;
  return status === 403 || status === 429;
}
