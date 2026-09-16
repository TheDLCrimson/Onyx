import { describe, expect, it } from "vitest";
import { VERIFY_UNAVAILABLE_NOTE } from "../services/llm";
import {
  appendBuildErrorsSection,
  appendBuildSkippedNote,
  appendVerificationSection,
  renderVerificationSection,
} from "../utils/prBody";

const FIXED_DATE = new Date("2026-04-29T12:00:00Z");

describe("renderVerificationSection", () => {
  it("renders match verdict with ✅ emoji", () => {
    const out = renderVerificationSection(
      { verdict: "match", notes: "All planned files were created." },
      FIXED_DATE,
    );
    expect(out).toContain("## Verification");
    expect(out).toContain("✅ Match");
    expect(out).toContain("- All planned files were created.");
    expect(out).toContain("_Last verified: 2026-04-29_");
  });

  it("renders partial verdict with ⚠️ emoji", () => {
    const out = renderVerificationSection(
      { verdict: "partial", notes: "Most steps done. One file missing." },
      FIXED_DATE,
    );
    expect(out).toContain("⚠️ Partial");
    // Notes split into bullets on sentence boundary.
    expect(out).toContain("- Most steps done.");
    expect(out).toContain("- One file missing.");
  });

  it("renders mismatch verdict with ❌ emoji", () => {
    const out = renderVerificationSection(
      { verdict: "mismatch", notes: "Wrong file changed." },
      FIXED_DATE,
    );
    expect(out).toContain("❌ Mismatch");
  });

  it("preserves multi-line notes as separate bullets", () => {
    const out = renderVerificationSection(
      { verdict: "match", notes: "line one\nline two\nline three" },
      FIXED_DATE,
    );
    expect(out).toContain("- line one");
    expect(out).toContain("- line two");
    expect(out).toContain("- line three");
  });

  it("emits a placeholder bullet when notes are empty", () => {
    const out = renderVerificationSection({ verdict: "match", notes: "" }, FIXED_DATE);
    expect(out).toContain("- (no notes)");
  });

  it("includes build status line when buildStatus is provided", () => {
    const out = renderVerificationSection({ verdict: "match", notes: "ok" }, FIXED_DATE, {
      outcome: "passed",
      kind: "ts",
    });
    expect(out).toContain("**Build:** ✅ Passed (ts)");
    expect(out).toContain("**Plan match:** ✅ Match");
  });

  it("omits kind suffix for unknown repo type", () => {
    const out = renderVerificationSection(
      { verdict: "partial", notes: "some steps done" },
      FIXED_DATE,
      { outcome: "skipped", kind: "unknown" },
    );
    expect(out).toContain("**Build:** ⏭ Skipped");
    expect(out).not.toContain("(unknown)");
  });

  it("omits build line entirely when buildStatus is not provided", () => {
    const out = renderVerificationSection({ verdict: "match", notes: "ok" }, FIXED_DATE);
    expect(out).not.toContain("**Build:**");
    expect(out).toContain("**Plan match:** ✅ Match");
  });
});

describe("appendVerificationSection", () => {
  it("appends to a clean body", () => {
    const body = "## Summary\n- did stuff";
    const out = appendVerificationSection(body, { verdict: "match", notes: "ok" }, FIXED_DATE);
    expect(out).toContain("## Summary");
    expect(out).toContain("## Verification");
    expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## Verification"));
  });

  it("replaces an existing Verification section idempotently", () => {
    const original = "## Summary\n- old\n\n## Verification\nold stuff\n";
    const once = appendVerificationSection(
      original,
      { verdict: "match", notes: "first" },
      FIXED_DATE,
    );
    const twice = appendVerificationSection(
      once,
      { verdict: "mismatch", notes: "second" },
      FIXED_DATE,
    );
    // Only one Verification header should remain.
    const matches = twice.match(/## Verification/g) ?? [];
    expect(matches.length).toBe(1);
    expect(twice).toContain("❌ Mismatch");
    expect(twice).toContain("- second");
    expect(twice).not.toContain("- first");
    expect(twice).not.toContain("old stuff");
  });

  it("preserves prior body content when replacing", () => {
    const original = "## Summary\n- did stuff\n\n## Verification\nold\n\n## Footer\n- keep me";
    const out = appendVerificationSection(
      original,
      { verdict: "match", notes: "fresh" },
      FIXED_DATE,
    );
    expect(out).toContain("## Summary");
    expect(out).toContain("## Footer");
    expect(out).toContain("- keep me");
  });
});

describe("appendBuildErrorsSection", () => {
  it("appends to a clean body", () => {
    const body = "## Summary\n- did stuff";
    const out = appendBuildErrorsSection(body, ["error CS1234: bad code"], FIXED_DATE);
    expect(out).toContain("## Summary");
    expect(out).toContain("## Build Errors");
    expect(out).toContain("`error CS1234: bad code`");
    expect(out).toContain("_Build failed: 2026-04-29_");
    expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## Build Errors"));
  });

  it("replaces an existing Build Errors section idempotently", () => {
    const original = "## Summary\n- old\n\n## Build Errors\nold errors\n";
    const once = appendBuildErrorsSection(original, ["error CS0001: first"], FIXED_DATE);
    const twice = appendBuildErrorsSection(once, ["error CS0002: second"], FIXED_DATE);
    const matches = twice.match(/## Build Errors/g) ?? [];
    expect(matches.length).toBe(1);
    expect(twice).toContain("error CS0002: second");
    expect(twice).not.toContain("error CS0001: first");
    expect(twice).not.toContain("old errors");
  });

  it("does not disturb a Verification section when replacing Build Errors", () => {
    const body =
      "## Summary\n- x\n\n## Verification\n**Result:** ✅ Match\n\n## Build Errors\nold\n";
    const out = appendBuildErrorsSection(body, ["error CS9999: new"], FIXED_DATE);
    expect(out).toContain("## Verification");
    expect(out).toContain("✅ Match");
    expect(out).toContain("## Build Errors");
    expect(out).toContain("error CS9999: new");
  });

  it("renders placeholder when no errors provided", () => {
    const out = appendBuildErrorsSection("## Summary\n- x", [], FIXED_DATE);
    expect(out).toContain("(no parseable error lines)");
  });
});

describe("appendBuildSkippedNote", () => {
  it("appends the skipped note to a clean body", () => {
    const body = "## Summary\n- x";
    const out = appendBuildSkippedNote(body);
    expect(out).toContain("_Build verification skipped: unsupported repository type._");
  });

  it("is idempotent — second call is a no-op", () => {
    const body = "## Summary\n- x";
    const once = appendBuildSkippedNote(body);
    const twice = appendBuildSkippedNote(once);
    const count = (twice.match(/_Build verification skipped/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe("verification section — verifier unavailable", () => {
  it("says the verdict was not checked instead of showing a fake 'partial'", () => {
    const body = appendVerificationSection(
      "## Summary\n- work",
      { verdict: "partial", notes: VERIFY_UNAVAILABLE_NOTE },
      new Date("2026-09-17T00:00:00Z"),
      { outcome: "passed", kind: "ts" },
    );
    expect(body).toContain("Not checked");
    expect(body).not.toContain("⚠️ Partial");
    expect(body).not.toContain("(verification unavailable)");
    // The build result is still reported.
    expect(body).toContain("**Build:** ✅ Passed (ts)");
  });

  it("still renders a real partial verdict normally", () => {
    const body = appendVerificationSection(
      "## Summary\n- work",
      { verdict: "partial", notes: "One step was skipped." },
      new Date("2026-09-17T00:00:00Z"),
    );
    expect(body).toContain("⚠️ Partial");
    expect(body).toContain("One step was skipped.");
    expect(body).not.toContain("Not checked");
  });
});
