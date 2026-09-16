import type { VerifyResult } from "../services/llm";
import { VERIFY_UNAVAILABLE_NOTE } from "../services/llm";

const VERIFICATION_HEADER = "## Verification";
/** Matches the existing Verification section through end-of-body or next `##`. */
const VERIFICATION_SECTION_RE = /\n*## Verification[\s\S]*?(?=\n## |\s*$)/;

const VERDICT_LABEL: Record<VerifyResult["verdict"], string> = {
  match: "✅ Match",
  partial: "⚠️ Partial",
  mismatch: "❌ Mismatch",
};

const BUILD_STATUS_LABEL: Record<"passed" | "failed" | "skipped", string> = {
  passed: "✅ Passed",
  failed: "❌ Failed",
  skipped: "⏭ Skipped",
};

export interface BuildStatus {
  outcome: "passed" | "failed" | "skipped";
  kind: string | null;
}

/**
 * Render a Verification section as markdown — optional build status + verdict +
 * bulleted notes + timestamp.
 */
export function renderVerificationSection(
  result: VerifyResult,
  now: Date = new Date(),
  buildStatus?: BuildStatus,
): string {
  const lines = [VERIFICATION_HEADER, ""];
  if (buildStatus) {
    const kindSuffix =
      buildStatus.kind && buildStatus.kind !== "unknown" ? ` (${buildStatus.kind})` : "";
    lines.push(`**Build:** ${BUILD_STATUS_LABEL[buildStatus.outcome]}${kindSuffix}`, "");
  }
  if (result.notes === VERIFY_UNAVAILABLE_NOTE) {
    // The verifier never returned a verdict — say so rather than presenting
    // the fallback "partial" as if a model had judged the change.
    lines.push(
      "**Plan match:** ℹ️ Not checked — the verifier model returned no verdict.",
      "",
      `_Last verified: ${now.toISOString().slice(0, 10)}_`,
    );
    return lines.join("\n");
  }
  lines.push(
    `**Plan match:** ${VERDICT_LABEL[result.verdict]}`,
    "",
    "**Notes:**",
    ...notesToBullets(result.notes),
    "",
    `_Last verified: ${now.toISOString().slice(0, 10)}_`,
  );
  return lines.join("\n");
}

/**
 * Append the Verification section to a PR body, replacing any existing
 * section idempotently. Always overwrites — last verifier wins. Acceptable
 * for v1 (see decisions log: race acceptance).
 */
export function appendVerificationSection(
  body: string,
  result: VerifyResult,
  now: Date = new Date(),
  buildStatus?: BuildStatus,
): string {
  const section = renderVerificationSection(result, now, buildStatus);
  const trimmed = body.replace(VERIFICATION_SECTION_RE, "").trimEnd();
  return `${trimmed}\n\n${section}\n`;
}

const BUILD_ERRORS_HEADER = "## Build Errors";
/** Matches the existing Build Errors section through end-of-body or next `##`. */
const BUILD_ERRORS_SECTION_RE = /\n*## Build Errors[\s\S]*?(?=\n## |\s*$)/;

/**
 * Append a Build Errors section to a PR body, replacing any existing section
 * idempotently. Last build run wins (same policy as verification).
 */
export function appendBuildErrorsSection(
  body: string,
  errors: string[],
  now: Date = new Date(),
): string {
  const bullets = errors.map((e) => `- \`${e.trim()}\``).join("\n");
  const section = [
    BUILD_ERRORS_HEADER,
    "",
    bullets || "- (no parseable error lines)",
    "",
    `_Build failed: ${now.toISOString().slice(0, 10)}_`,
  ].join("\n");
  const trimmed = body.replace(BUILD_ERRORS_SECTION_RE, "").trimEnd();
  return `${trimmed}\n\n${section}\n`;
}

/**
 * Append a one-line build-skipped note to a PR body when the repo type is
 * unsupported. Idempotent — no-op if the note is already present.
 */
export function appendBuildSkippedNote(body: string): string {
  if (body.includes("_Build verification skipped")) return body;
  return body.trimEnd() + "\n\n_Build verification skipped: unsupported repository type._\n";
}

/** Split notes into bullet lines. Splits on sentence-ending punctuation or newlines. */
function notesToBullets(notes: string): string[] {
  const trimmed = notes.trim();
  if (!trimmed) return ["- (no notes)"];
  const parts = trimmed
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.map((p) => `- ${p}`);
}
