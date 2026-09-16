import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

/**
 * Regression: sessions, bindings and the usage log used to resolve to
 * `process.cwd()/data` unconditionally, so running the unit suite inside a
 * deployment's checkout rewrote its live sessions file and dropped active
 * features.
 */

const ORIGINAL = process.env.ONYX_DATA_DIR;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONYX_DATA_DIR;
  else process.env.ONYX_DATA_DIR = ORIGINAL;
  vi.resetModules();
});

describe("DATA_DIR", () => {
  it("honours ONYX_DATA_DIR", async () => {
    process.env.ONYX_DATA_DIR = path.join(os.tmpdir(), "onyx-somewhere-else");
    const { DATA_DIR, dataFile } = await import("../utils/dataDir");
    expect(DATA_DIR).toBe(path.join(os.tmpdir(), "onyx-somewhere-else"));
    expect(dataFile("sessions.json")).toBe(
      path.join(os.tmpdir(), "onyx-somewhere-else", "sessions.json"),
    );
  });

  it("falls back to ./data when the override is blank", async () => {
    process.env.ONYX_DATA_DIR = "   ";
    const { DATA_DIR } = await import("../utils/dataDir");
    expect(DATA_DIR).toBe(path.join(process.cwd(), "data"));
  });

  it("falls back to ./data when the override is unset", async () => {
    delete process.env.ONYX_DATA_DIR;
    const { DATA_DIR } = await import("../utils/dataDir");
    expect(DATA_DIR).toBe(path.join(process.cwd(), "data"));
  });

  it("keeps the unit suite out of the repo's data directory", async () => {
    const { DATA_DIR } = await import("../utils/dataDir");
    expect(DATA_DIR).not.toBe(path.join(process.cwd(), "data"));
  });
});
