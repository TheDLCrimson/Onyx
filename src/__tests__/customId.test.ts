import { describe, expect, it } from "vitest";
import { encodeCustomId, newScopeId, parseCustomId } from "../utils/customId";

describe("encodeCustomId / parseCustomId", () => {
  it("round-trips a valid customId", () => {
    const id = encodeCustomId({
      namespace: "feature",
      action: "approve",
      scopeId: "abc123",
    });
    expect(id).toBe("feature:approve:abc123");
    expect(parseCustomId(id)).toEqual({
      namespace: "feature",
      action: "approve",
      scopeId: "abc123",
    });
  });

  it("throws when any part contains ':'", () => {
    expect(() =>
      encodeCustomId({
        namespace: "feature",
        action: "ap:prove",
        scopeId: "x",
      }),
    ).toThrow(/cannot contain ':'/);
  });

  it("throws when the encoded string exceeds Discord's 100-char cap", () => {
    expect(() =>
      encodeCustomId({
        namespace: "feature",
        action: "approve",
        scopeId: "x".repeat(120),
      }),
    ).toThrow(/100-char limit/);
  });

  it("returns null for malformed inputs", () => {
    expect(parseCustomId("foo:bar")).toBeNull();
    expect(parseCustomId("foo:bar:baz:qux")).toBeNull();
    expect(parseCustomId("notanamespace:bar:baz")).toBeNull();
    expect(parseCustomId("feature::baz")).toBeNull();
  });
});

describe("newScopeId()", () => {
  it("returns distinct ids on consecutive calls", () => {
    const a = newScopeId();
    const b = newScopeId();
    expect(a).not.toBe(b);
  });

  it("fits in a customId under the 100-char limit", () => {
    const id = encodeCustomId({
      namespace: "feature",
      action: "approve",
      scopeId: newScopeId(),
    });
    expect(id.length).toBeLessThanOrEqual(100);
  });
});
