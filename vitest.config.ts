import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Unit-test config. Points ONYX_DATA_DIR at a scratch directory so a test run
 * can never overwrite a live deployment's sessions / bindings / usage log —
 * the session store rewrites its whole file on every mutation.
 * Stubs credentials so module-init code (e.g.
 * `new OpenAI(...)` in services/claude.ts) doesn't throw at import time.
 * Integration tests live in `src/__integration__/` and run via the
 * separate `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    env: {
      DISCORD_TOKEN: "test-stub",
      OPENROUTER_API_KEY: "test-stub",
      GITHUB_TOKEN: "test-stub",
      GITHUB_OWNER: "test-owner",
      GITHUB_REPO: "test-repo",
      ONYX_DATA_DIR: path.join(os.tmpdir(), "onyx-unit-test-data"),
    },
  },
});
