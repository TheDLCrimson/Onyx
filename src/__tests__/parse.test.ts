import { describe, expect, it } from "vitest";
import { parse } from "../events/messageCreate";

describe("parse() prefix-command parser", () => {
  it("parses a valid !create command", () => {
    expect(parse("!create src/foo.ts make a hello world file")).toEqual({
      kind: "create",
      path: "src/foo.ts",
      body: "make a hello world file",
    });
  });

  it("parses !edit and !ask the same way", () => {
    expect(parse("!edit a.ts add a comment")?.kind).toBe("edit");
    expect(parse("!ask a.ts what is this")?.kind).toBe("ask");
  });

  it("returns null for messages without a ! prefix", () => {
    expect(parse("hello world")).toBeNull();
    expect(parse("create foo.ts make it")).toBeNull();
  });

  it("returns null for unknown command kinds", () => {
    expect(parse("!frobnicate foo.ts go")).toBeNull();
    expect(parse("!help foo.ts")).toBeNull();
  });

  it("returns null when path is missing", () => {
    expect(parse("!create")).toBeNull();
    expect(parse("!ask")).toBeNull();
  });

  it("returns null when body is missing", () => {
    expect(parse("!create foo.ts")).toBeNull();
  });

  it("collapses runs of whitespace in the body", () => {
    expect(parse("!ask foo.ts what    is   this")?.body).toBe("what is this");
  });

  it("ignores leading and trailing whitespace", () => {
    expect(parse("  !ask foo.ts hi  ")?.kind).toBe("ask");
  });
});
