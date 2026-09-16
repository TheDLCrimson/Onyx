import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prMode } from "../utils/env";

describe("prMode()", () => {
  const original = process.env.ONYX_PR_MODE;

  beforeEach(() => {
    delete process.env.ONYX_PR_MODE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ONYX_PR_MODE;
    else process.env.ONYX_PR_MODE = original;
  });

  it("defaults to true when unset", () => {
    expect(prMode()).toBe(true);
  });

  it("treats empty string as default (true)", () => {
    process.env.ONYX_PR_MODE = "";
    expect(prMode()).toBe(true);
  });

  it("treats `false`, `0`, `no` (any case) as off", () => {
    for (const v of ["false", "FALSE", "False", "0", "no", "NO"]) {
      process.env.ONYX_PR_MODE = v;
      expect(prMode()).toBe(false);
    }
  });

  it("treats `true` and other values as on", () => {
    for (const v of ["true", "TRUE", "1", "yes", "anything"]) {
      process.env.ONYX_PR_MODE = v;
      expect(prMode()).toBe(true);
    }
  });

  it("ignores surrounding whitespace", () => {
    process.env.ONYX_PR_MODE = "  false  ";
    expect(prMode()).toBe(false);
  });
});
