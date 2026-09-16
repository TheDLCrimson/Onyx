import path from "path";

/**
 * Directory holding Onyx's runtime state: sessions, channel bindings and the
 * usage log. Defaults to `data/` next to the process's working directory.
 *
 * `ONYX_DATA_DIR` overrides it, which matters for two cases: relocating state
 * onto a mounted volume, and keeping test runs away from a live deployment —
 * the session store rewrites its whole file, so a test run sharing this
 * directory would erase real sessions.
 */
export const DATA_DIR: string =
  (process.env.ONYX_DATA_DIR || "").trim() || path.join(process.cwd(), "data");

/** Absolute path to a file inside {@link DATA_DIR}. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}
