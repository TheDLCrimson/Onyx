import "dotenv/config";

/**
 * Remap GITHUB_TEST_* → GITHUB_* before any service module loads, so the
 * github service (which reads env at module-init time) targets the sandbox
 * repo rather than the production one configured in .env.
 */
if (process.env.GITHUB_TEST_OWNER?.trim()) {
  process.env.GITHUB_OWNER = process.env.GITHUB_TEST_OWNER;
}
if (process.env.GITHUB_TEST_REPO?.trim()) {
  process.env.GITHUB_REPO = process.env.GITHUB_TEST_REPO;
}
