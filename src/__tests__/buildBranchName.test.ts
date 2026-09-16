import { describe, expect, it } from "vitest";
import { buildBranchName, slugify } from "../services/github";

describe("slugify()", () => {
  it("lower-cases and replaces non-alphanum with hyphens", () => {
    expect(slugify("src/util/Log.TS")).toBe("src-util-log-ts");
  });

  it("collapses runs of separators", () => {
    expect(slugify("a//b   c")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("///foo///")).toBe("foo");
  });

  it("caps length at 60 chars and trims trailing hyphen after the cut", () => {
    const long = "a".repeat(80);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
    const withSeps = "a".repeat(58) + "-bb"; // hyphen lands at position 58
    expect(slugify(withSeps).endsWith("-")).toBe(false);
  });

  it("falls back to `file` for inputs that slug to empty", () => {
    expect(slugify("///")).toBe("file");
    expect(slugify("")).toBe("file");
  });
});

describe("buildBranchName()", () => {
  it("uses the kind, slugified path, and timestamp", () => {
    expect(buildBranchName("create", "src/util/log.ts", 1234)).toBe(
      "onyx/create-src-util-log-ts-1234",
    );
  });

  it("differentiates create vs edit", () => {
    expect(buildBranchName("edit", "a.ts", 1)).toBe("onyx/edit-a-ts-1");
  });

  it("uses Date.now() when timestamp is omitted", () => {
    const before = Date.now();
    const name = buildBranchName("create", "x.ts");
    const after = Date.now();
    const ts = Number(name.split("-").pop());
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
