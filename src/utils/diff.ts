import { createPatch } from "diff";

/**
 * Per-write Discord diff-preview cap. Discord's hard limit is 2000; we cap
 * the body well below that so the header + truncation marker + GitHub link
 * footer all fit. When the body is clipped we link out to the file on
 * GitHub instead of trying to spread the content across follow-up messages.
 */
const DIFF_BODY_MAX = 1000;

/** Args for `renderDiffPreview`. */
export interface DiffPreviewArgs {
  kind: "create" | "edit" | "delete";
  path: string;
  before?: string;
  after?: string;
  /**
   * Branch the file lives on (or is about to land on). When supplied AND
   * the body gets truncated, a `📂 View full file on GitHub` footer with a
   * blob URL is appended. Skipped silently if `branch` is undefined.
   */
  branch?: string;
  /** Repo coordinates for the blob URL footer. Pulled from env in callers. */
  owner?: string;
  repo?: string;
}

/**
 * Render a Discord-friendly preview of a single file write. Output: a
 * markdown header + a fenced unified-diff (for `edit`) or plain content
 * preview (for `create` / `delete`). When the content overflows
 * `DIFF_BODY_MAX`, truncates with a `…(truncated)` marker and — if a branch
 * was supplied — a `📂 View full file on GitHub` link footer.
 */
export function renderDiffPreview(args: DiffPreviewArgs): string {
  switch (args.kind) {
    case "create":
      return wrapBlock({
        header: `🆕 **Create** \`${args.path}\``,
        body: args.after ?? "",
        lang: languageFor(args.path),
        link: blobLink(args),
      });
    case "delete":
      return wrapBlock({
        header: `🗑️ **Delete** \`${args.path}\` — file content shown for confirmation:`,
        body: args.before ?? "",
        lang: languageFor(args.path),
        link: blobLink(args),
      });
    case "edit": {
      if (args.before === undefined || args.after === undefined) {
        throw new Error("Edit diff requires both `before` and `after`.");
      }
      const patch = createPatch(args.path, args.before, args.after, "before", "after");
      return wrapBlock({
        header: `✏️ **Edit** \`${args.path}\``,
        body: stripPatchHeader(patch),
        lang: "diff",
        link: blobLink(args),
      });
    }
  }
}

interface WrapArgs {
  header: string;
  body: string;
  lang: string;
  /** Blob URL appended only when truncation actually fires. */
  link: string | null;
}

function wrapBlock({ header, body, lang, link }: WrapArgs): string {
  const truncated = body.length > DIFF_BODY_MAX;
  const shown = truncated ? body.slice(0, DIFF_BODY_MAX) + "\n…(truncated)" : body;
  const fenced = `\`\`\`${lang}\n${shown}\n\`\`\``;
  if (truncated && link) {
    return `${header}\n${fenced}\n📂 [View full file on GitHub](${link})`;
  }
  return `${header}\n${fenced}`;
}

/** Drop the `Index:` + `===` header lines that `createPatch` emits. */
function stripPatchHeader(patch: string): string {
  const lines = patch.split("\n");
  const start = lines[0]?.startsWith("Index:") ? 3 : 0;
  return lines.slice(start).join("\n").trimEnd();
}

/**
 * Build the GitHub blob URL for the file on the supplied branch. Returns
 * null if any required piece is missing — the caller appends a footer only
 * when this resolves.
 */
function blobLink(args: DiffPreviewArgs): string | null {
  if (!args.branch || !args.owner || !args.repo) return null;
  return `https://github.com/${args.owner}/${args.repo}/blob/${args.branch}/${args.path}`;
}

/** Map a path to a fenced-code language hint. Defaults to no language. */
function languageFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
      return "bash";
    case "html":
      return "html";
    case "css":
      return "css";
    default:
      return "";
  }
}
