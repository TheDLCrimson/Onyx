import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Integration tests hit real OpenRouter / GitHub APIs. They read .env directly
 * (no stub injection) and skip when the relevant credentials are missing.
 */
export default defineConfig({
  test: {
    // Keep real sessions / bindings out of reach: these suites drive the real
    // session store, which rewrites its whole file.
    env: { ONYX_DATA_DIR: path.join(os.tmpdir(), "onyx-integration-test-data") },
    include: ["src/__integration__/**/*.test.ts"],
    setupFiles: ["./src/__integration__/setup.ts"],
    // Real network calls — give them room to breathe.
    testTimeout: 60_000,
  },
});
