import type { Session, StagingEntry } from "../types";
import { renderDiffPreview } from "../utils/diff";
import { editFile } from "./llm";
import { commitChange } from "./commitFlow";
import { getClientForChannel } from "./github";
import { recordTurn } from "./sessions";
import type { Tool, ToolContext } from "./tools";
import { TOOL_RESULT_PAGE_SIZE } from "./tools";

/** Maximum entries allowed in the staging area before Write/Edit/Delete refuse to stage more. */
const MAX_STAGED_FILES = 20;

/**
 * Discord-side adapter the write tools call. Kept small so `services/` stays
 * Discord-free; the `/feature` command provides a Discord-backed implementation
 * and tests provide a mock.
 */
export interface WriteToolHooks {
  /** Post a diff preview message; returns the Discord message id. */
  postPreview(text: string): Promise<string>;
  /**
   * Called for destructive writes in `pr` mode and for any write in `direct`
   * mode. Adds ✅/❌ buttons to the preview message and waits for a click.
   * Non-destructive `pr`-mode writes auto-confirm without going through this hook.
   */
  awaitConfirmation(messageId: string): Promise<boolean>;
  /**
   * Post a one-line "✅ Edited foo.ts" follow-up after a successful commit.
   * The PR URL is announced separately via `postPullRequestLink` so it only
   * appears once per loop.
   */
  postCommitResult(text: string): Promise<void>;
  /**
   * Announce the active feature's PR exactly once per loop. Implementations
   * are expected to guard with a closed-over flag — every commit will call
   * this hook, but it should only render the first time.
   */
  postPullRequestLink(url: string, number: number): Promise<void>;
  /**
   * Called after a delete is cancelled. Posts a "🔁 Retry Delete" button so
   * the user can change their mind without retyping a command. Optional —
   * test mocks that don't exercise retry can omit it.
   */
  postCancelledDelete?(path: string): Promise<void>;
}

/** Build the Write / Edit / Delete / MultiEdit / Commit tool registry with channel-scoped hooks. */
export function buildWriteTools(opts: {
  session: Session;
  hooks: WriteToolHooks;
}): readonly Tool[] {
  return [
    makeWriteTool(opts),
    makeEditTool(opts),
    makeDeleteTool(opts),
    makeMultiEditTool(opts),
    makeCommitTool(opts),
  ];
}

function makeWriteTool(opts: { session: Session; hooks: WriteToolHooks }): Tool {
  return {
    name: "Write",
    description:
      "Create a new file (or overwrite an existing one) at the given repo-" +
      "relative path with the supplied UTF-8 contents. Commits to the active " +
      "feature branch (creating it lazily on the first write). Posts a diff " +
      "preview to Discord; in pr mode non-destructive writes auto-proceed " +
      "after preview, in direct mode a button confirmation is required. " +
      "If the new content is less than 80% of the existing file size the tool " +
      "refuses unless `acknowledge_shrink: true` is passed — this guards " +
      "against accidental partial overwrites from truncated reads.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path. Forward slashes; no leading slash.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 file contents. Required.",
        },
        prompt: {
          type: "string",
          description: "One-sentence intent for the PR body (e.g. 'add hello() function').",
        },
        acknowledge_shrink: {
          type: "boolean",
          description:
            "Pass true when intentionally reducing file size by >20% " +
            "(e.g. deleting a section). Without this the tool refuses to " +
            "prevent accidental overwrites from partial reads.",
        },
      },
      required: ["path", "content", "prompt"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    async execute(args, ctx) {
      const path = requireString(args, "path");
      const content = requireString(args, "content");
      const prompt = requireString(args, "prompt");
      // Detect whether this is a create or an overwrite by checking the active branch.
      const existing = await getClientForChannel(ctx.channelId ?? "").readFile(
        path,
        ctx.activeBranch,
      );
      // Shrink guard: refuse if new content is <80% of original unless opt-in.
      if (existing && content.length < 0.8 * existing.content.length) {
        if (args.acknowledge_shrink !== true) {
          const pct = Math.round((content.length / existing.content.length) * 100);
          throw new Error(
            `refused: new content is ${pct}% of original ` +
              `(${content.length} vs ${existing.content.length} chars). ` +
              `Before passing acknowledge_shrink: true, verify you have read the ` +
              `complete file (read_complete: true in the last Read result). ` +
              `If you only have a partial read, call Read with the correct offset first. ` +
              `Only pass acknowledge_shrink: true if you have confirmed the full file ` +
              `and the reduction is intentional (e.g. deleting a section).`,
          );
        }
      }
      const kind = existing ? "edit" : "create";
      const before = existing?.content;
      const previewText = renderDiffPreview({
        kind: kind === "create" ? "create" : "edit",
        path,
        before,
        after: content,
        ...blobLinkParts(opts.session),
      });
      const ok = await previewAndMaybeConfirm({
        previewText,
        hooks: opts.hooks,
        ctx,
        destructive: false,
      });
      if (!ok) {
        return `User rejected the change to ${path}. Skipped.`;
      }
      pushToStaging(opts.session, { kind, path, content, prompt, sha: existing?.sha });
      await opts.hooks.postCommitResult(`📦 Staged \`${path}\``);
      return `Staged ${path} (${content.length} bytes). Call Commit(message) when ready to push this phase.`;
    },
  };
}

function makeEditTool(opts: { session: Session; hooks: WriteToolHooks }): Tool {
  return {
    name: "Edit",
    description:
      "Apply a natural-language instruction to an existing file. The bot " +
      "fetches the file from the active feature branch (or default branch), " +
      "asks the model to produce the updated contents, posts a diff preview, " +
      "then commits. Returns an error if the path doesn't exist — use Write " +
      "for new files. Prefer MultiEdit for localized changes, especially on " +
      "large files — Edit rewrites the whole file via the model and can " +
      "accidentally corrupt unrelated sections. If the edited content is less " +
      "than 80% of the original file size, the tool refuses unless " +
      "`acknowledge_shrink: true` is passed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path of the existing file.",
        },
        instruction: {
          type: "string",
          description: "What change to make. Be specific — the model follows this verbatim.",
        },
        acknowledge_shrink: {
          type: "boolean",
          description:
            "Pass true when intentionally reducing file size by >20% " +
            "(e.g. removing large sections). Without this the tool refuses to " +
            "prevent accidental shrinkage from overly aggressive edits.",
        },
      },
      required: ["path", "instruction"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    async execute(args, ctx) {
      const path = requireString(args, "path");
      const instruction = requireString(args, "instruction");
      const acknowledge_shrink = args.acknowledge_shrink === true ? true : false;
      const existing = await getClientForChannel(ctx.channelId ?? "").readFile(
        path,
        ctx.activeBranch,
      );
      if (!existing) {
        throw new Error(`Path not found: ${path}. Use Write to create a new file.`);
      }
      const updated = await editFile(path, existing.content, instruction);
      // Shrink guard: refuse if new content is <80% of original unless opt-in.
      if (updated.length < 0.8 * existing.content.length) {
        if (!acknowledge_shrink) {
          const pct = Math.round((updated.length / existing.content.length) * 100);
          throw new Error(
            `refused: edited content is ${pct}% of original ` +
              `(${updated.length} vs ${existing.content.length} chars). ` +
              `Before passing acknowledge_shrink: true, verify the instruction was ` +
              `meant to remove that much content. If the file was only partially read ` +
              `before editing, call Read with the correct offset to confirm read_complete: true. ` +
              `Only pass acknowledge_shrink: true if the reduction is intentional ` +
              `(e.g. removing a large section).`,
          );
        }
      }
      const previewText = renderDiffPreview({
        kind: "edit",
        path,
        before: existing.content,
        after: updated,
        ...blobLinkParts(opts.session),
      });
      const ok = await previewAndMaybeConfirm({
        previewText,
        hooks: opts.hooks,
        ctx,
        destructive: false,
      });
      if (!ok) {
        return `User rejected the edit to ${path}. Skipped.`;
      }
      pushToStaging(opts.session, {
        kind: "edit",
        path,
        content: updated,
        prompt: instruction,
        sha: existing.sha,
      });
      await opts.hooks.postCommitResult(`📦 Staged \`${path}\``);
      // Return post-edit content as a paginated JSON object so the model can
      // self-verify the computed edit before committing.
      const slice = updated.slice(0, TOOL_RESULT_PAGE_SIZE);
      const bytesRemaining = Math.max(0, updated.length - slice.length);
      return JSON.stringify({
        result: `Staged ${path} (${updated.length} bytes). Call Commit(message) when ready to push.`,
        post_edit_content: slice,
        _truncated: bytesRemaining > 0,
        bytes_remaining: bytesRemaining,
        read_complete: bytesRemaining === 0,
      });
    },
  };
}

function makeDeleteTool(opts: { session: Session; hooks: WriteToolHooks }): Tool {
  return {
    name: "Delete",
    description:
      "Delete a file at the given repo-relative path. Always requires explicit " +
      "user confirmation via button click, regardless of mode (destructive). " +
      "Posts a content preview with ✅ Confirm Delete / ❌ Cancel buttons.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path to delete." },
        prompt: {
          type: "string",
          description: "Why the file is being removed (one sentence, for the PR body).",
        },
      },
      required: ["path", "prompt"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: true,
    async execute(args, ctx) {
      const path = requireString(args, "path");
      const prompt = requireString(args, "prompt");
      const existing = await getClientForChannel(ctx.channelId ?? "").readFile(
        path,
        ctx.activeBranch,
      );
      if (!existing) {
        throw new Error(`Path not found: ${path}. Nothing to delete.`);
      }
      const previewText = renderDiffPreview({
        kind: "delete",
        path,
        before: existing.content,
        ...blobLinkParts(opts.session),
      });
      const ok = await previewAndMaybeConfirm({
        previewText,
        hooks: opts.hooks,
        ctx,
        destructive: true,
      });
      if (!ok) {
        await opts.hooks.postCancelledDelete?.(path);
        return `Delete of ${path} was cancelled by the user. Do not retry this delete — skip it and continue with remaining tasks.`;
      }
      pushToStaging(opts.session, {
        kind: "delete",
        path,
        content: existing.content,
        prompt,
        sha: existing.sha,
      });
      await opts.hooks.postCommitResult(`📦 Staged deletion of \`${path}\``);
      return `Staged deletion of ${path}. Call Commit(message) when ready to push this phase.`;
    },
  };
}

function makeMultiEditTool(opts: { session: Session; hooks: WriteToolHooks }): Tool {
  return {
    name: "MultiEdit",
    description:
      "Apply multiple precise find/replace edits to a single file in one " +
      "atomic operation. Reads the file, applies all `{find, replace}` pairs " +
      "in order, posts a diff preview, then commits. **Prefer this over Edit " +
      "for localized changes, especially on large files** — it never rewrites " +
      "content you haven't read. Fails atomically if any `find` string is not " +
      "found or appears more than once in the file. Returns a JSON object with " +
      "the post-edit content and truncation metadata (same shape as Edit). " +
      "Returns an error if the path doesn't exist — use Write for new files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path of the file to edit.",
        },
        edits: {
          type: "array",
          description:
            "Ordered list of find/replace pairs. Applied in sequence. " +
            "Each `find` must match exactly once — use when you know the " +
            "exact string to replace rather than rewriting the whole file.",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description: "Exact string to find. Must appear exactly once in the file.",
              },
              replace: {
                type: "string",
                description: "Replacement string.",
              },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
          minItems: 1,
        },
        prompt: {
          type: "string",
          description: "One-sentence intent for the PR body.",
        },
      },
      required: ["path", "edits", "prompt"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    async execute(args, ctx) {
      const path = requireString(args, "path");
      const prompt = requireString(args, "prompt");
      const rawEdits = args.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        throw new Error("`edits` must be a non-empty array.");
      }

      const existing = await getClientForChannel(ctx.channelId ?? "").readFile(
        path,
        ctx.activeBranch,
      );
      if (!existing) throw new Error(`Path not found: ${path}. Use Write to create new files.`);

      let content = existing.content;
      for (const edit of rawEdits as Array<Record<string, unknown>>) {
        if (typeof edit.find !== "string" || typeof edit.replace !== "string") {
          throw new Error("Each edit must have string `find` and `replace` fields.");
        }
        const occurrences = content.split(edit.find).length - 1;
        if (occurrences === 0) {
          throw new Error(`find string not found in ${path}: "${edit.find.slice(0, 60)}"`);
        }
        if (occurrences > 1) {
          throw new Error(
            `find string is non-unique in ${path} (${occurrences} matches): "${edit.find.slice(0, 60)}"`,
          );
        }
        // replace() with a string arg replaces only the first occurrence —
        // safe here because we verified exactly 1 occurrence above.
        content = content.replace(edit.find, edit.replace);
      }

      const previewText = renderDiffPreview({
        kind: "edit",
        path,
        before: existing.content,
        after: content,
        ...blobLinkParts(opts.session),
      });
      const ok = await previewAndMaybeConfirm({
        previewText,
        hooks: opts.hooks,
        ctx,
        destructive: false,
      });
      if (!ok) return `User rejected the MultiEdit to ${path}. Skipped.`;

      pushToStaging(opts.session, { kind: "edit", path, content, prompt, sha: existing.sha });
      await opts.hooks.postCommitResult(`📦 Staged \`${path}\``);
      // Return post-edit content so the model can self-verify the computed edits before committing.
      const slice = content.slice(0, TOOL_RESULT_PAGE_SIZE);
      const bytesRemaining = Math.max(0, content.length - slice.length);
      return JSON.stringify({
        result: `Staged ${path} (${rawEdits.length} edits, ${content.length} bytes). Call Commit(message) when ready to push.`,
        post_edit_content: slice,
        _truncated: bytesRemaining > 0,
        bytes_remaining: bytesRemaining,
        read_complete: bytesRemaining === 0,
      });
    },
  };
}

/**
 * Push a staged entry onto `session.runningAgent.stagingArea`. Throws if there
 * is no active agent loop or the staging area is at the MAX_STAGED_FILES cap.
 */
function pushToStaging(session: Session, entry: StagingEntry): void {
  if (!session.runningAgent) {
    throw new Error("No active agent loop — cannot stage changes outside a feature run.");
  }
  if (!session.runningAgent.stagingArea) {
    session.runningAgent.stagingArea = [];
  }
  if (session.runningAgent.stagingArea.length >= MAX_STAGED_FILES) {
    throw new Error(
      `Staging area full (${MAX_STAGED_FILES} files). Call Commit(message) to flush before staging more.`,
    );
  }
  session.runningAgent.stagingArea.push(entry);
}

function makeCommitTool(opts: { session: Session; hooks: WriteToolHooks }): Tool {
  return {
    name: "Commit",
    description:
      "Flush all staged file operations as a logical Git commit on the active feature branch. " +
      "Call this after completing each logical phase of the plan (e.g. 'after writing all " +
      "model files', 'after writing all test files'). One Commit per phase — not one per file. " +
      "Returns an error if nothing is staged — you must call Write/Edit/Delete first. " +
      "If a commit fails mid-batch, already-committed files are removed from staging and " +
      "the remaining entries stay staged so you can fix the issue and call Commit again.\n\n" +
      "IMPORTANT: Always call Commit before finishing or before reading files you just staged " +
      "— staged files are not on the branch yet.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Commit message describing this phase (e.g. 'feat: add User model and repository'). " +
            "Used as the Git commit message for every file in this batch.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isDestructive: false,
    async execute(args, _ctx) {
      const message = requireString(args, "message");
      const staging = opts.session.runningAgent?.stagingArea;
      if (!staging || staging.length === 0) {
        return JSON.stringify({
          is_error: true,
          error:
            "Nothing staged. Call Write/Edit/Delete first to stage file operations, then call Commit.",
        });
      }
      const committed: string[] = [];
      while (staging.length > 0) {
        const entry = staging[0];
        try {
          const outcome = await commitChange({ ...entry, commitMessage: message }, opts.session);
          recordTurn(opts.session, {
            kind: entry.kind,
            paths: [entry.path],
            prompt: entry.prompt,
            summary: outcome.mode === "pr" ? outcome.summary : null,
            timestamp: Date.now(),
          });
          staging.shift(); // remove after successful commit — never re-attempted
          const verb =
            entry.kind === "create" ? "Created" : entry.kind === "edit" ? "Edited" : "Deleted";
          committed.push(`${verb} \`${entry.path}\``);
          if (outcome.mode === "pr") {
            await opts.hooks.postPullRequestLink(outcome.pr.url, outcome.pr.number);
          }
        } catch (err) {
          const partial =
            committed.length > 0
              ? `Committed ${committed.length} file(s): ${committed.join(", ")}. `
              : "";
          return (
            `${partial}Failed on \`${entry.path}\`: ${String(err)}. ` +
            `${staging.length} entries remain staged — fix the issue and call Commit again.`
          );
        }
      }
      const summary = committed.join(", ");
      await opts.hooks.postCommitResult(`✅ Committed: ${summary}`);
      return `Committed ${committed.length} file(s): ${summary}`;
    },
  };
}

/**
 * Pull `branch` + repo coords for the diff-preview blob link footer. Returns
 * an empty object when no active branch exists yet (the first write of a
 * fresh feature) — `renderDiffPreview` then skips the footer.
 */
function blobLinkParts(session: Session): { branch?: string; owner?: string; repo?: string } {
  if (!session.active?.branch) return {};
  const { owner, repo } = getClientForChannel(session.channelId).repoCoordinates();
  return { branch: session.active.branch, owner, repo };
}

/**
 * Post the diff preview, then either auto-confirm (pr mode + non-destructive)
 * or wait for the user's button click (destructive or direct mode).
 */
async function previewAndMaybeConfirm(opts: {
  previewText: string;
  hooks: WriteToolHooks;
  ctx: ToolContext;
  destructive: boolean;
}): Promise<boolean> {
  const messageId = await opts.hooks.postPreview(opts.previewText);
  const needsConfirm = opts.destructive || opts.ctx.mode === "direct";
  if (!needsConfirm) return true;
  return opts.hooks.awaitConfirmation(messageId);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`Argument \`${key}\` is required and must be a string.`);
  }
  return v;
}
