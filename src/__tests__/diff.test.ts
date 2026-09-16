import { describe, expect, it } from "vitest";
import { renderDiffPreview } from "../utils/diff";

describe("renderDiffPreview()", () => {
  it("renders a 'create' preview with the new content fenced", () => {
    const out = renderDiffPreview({
      kind: "create",
      path: "src/foo.ts",
      after: "export const x = 1;\n",
    });
    expect(out).toContain("🆕 **Create** `src/foo.ts`");
    expect(out).toContain("```typescript");
    expect(out).toContain("export const x = 1;");
  });

  it("renders an 'edit' preview as a unified diff", () => {
    const out = renderDiffPreview({
      kind: "edit",
      path: "x.ts",
      before: "const a = 1;\n",
      after: "const a = 2;\n",
    });
    expect(out).toContain("✏️ **Edit** `x.ts`");
    expect(out).toContain("```diff");
    expect(out).toContain("-const a = 1;");
    expect(out).toContain("+const a = 2;");
  });

  it("renders a 'delete' preview showing the old content", () => {
    const out = renderDiffPreview({
      kind: "delete",
      path: "old.txt",
      before: "going away\n",
    });
    expect(out).toContain("🗑️ **Delete** `old.txt`");
    expect(out).toContain("going away");
  });

  it("throws when 'edit' is missing before/after", () => {
    expect(() => renderDiffPreview({ kind: "edit", path: "x.ts", before: "" })).toThrow(
      /before.*after/,
    );
  });

  it("truncates very long output with a marker", () => {
    const big = "x".repeat(5000);
    const out = renderDiffPreview({
      kind: "create",
      path: "big.ts",
      after: big,
    });
    expect(out).toContain("…(truncated)");
    expect(out.length).toBeLessThan(big.length);
  });

  it("omits the GitHub blob link when content fits under the cap", () => {
    const out = renderDiffPreview({
      kind: "create",
      path: "small.ts",
      after: "export const x = 1;\n",
      branch: "onyx/feat-1",
      owner: "acme",
      repo: "widgets",
    });
    expect(out).not.toContain("…(truncated)");
    expect(out).not.toContain("View full file on GitHub");
  });

  it("appends a GitHub blob link when truncation fires and a branch is supplied", () => {
    const big = "x".repeat(5000);
    const out = renderDiffPreview({
      kind: "create",
      path: "src/big.ts",
      after: big,
      branch: "onyx/feat-1",
      owner: "acme",
      repo: "widgets",
    });
    expect(out).toContain("…(truncated)");
    expect(out).toContain("https://github.com/acme/widgets/blob/onyx/feat-1/src/big.ts");
    expect(out).toContain("View full file on GitHub");
  });

  it("gracefully skips the blob link when no branch is supplied", () => {
    const big = "x".repeat(5000);
    const out = renderDiffPreview({
      kind: "create",
      path: "src/big.ts",
      after: big,
    });
    expect(out).toContain("…(truncated)");
    expect(out).not.toContain("View full file on GitHub");
  });
});
