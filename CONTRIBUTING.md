# Contributing to Onyx

Thanks for taking a look.
Issues and pull requests are welcome; for anything larger than a bug fix, open an issue first so we can agree on the approach.

## Setup

```bash
pnpm install
cp .env.example .env    # only needed to run the bot or the integration tests
pnpm test               # unit tests: fast, no network, no credentials
```

To run the bot against your own Discord server, follow [docs/self-hosting.md](docs/self-hosting.md) and use `pnpm dev`.
Setting `DISCORD_GUILD_ID` to your test server makes slash-command changes show up instantly.

## Before opening a pull request

```bash
pnpm format:check
pnpm build
pnpm test
```

CI runs the same three commands.

- **Every behaviour change comes with a test.**
  The bar is "would a regression here be caught by the suite?"
  The suites in `src/__tests__/` show the mocking patterns for Discord, GitHub and OpenRouter; copy the closest one.
- **Integration tests** (`pnpm test:integration`) hit the real OpenRouter and GitHub APIs.
  They need `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, and a throwaway repo in `GITHUB_TEST_OWNER` / `GITHUB_TEST_REPO`, and they create branches and pull requests there.
  Free models are fine for them: set `ONYX_MODEL` as described in the self-hosting guide.

## Code conventions

The layout is handler-per-feature: one file per slash command, Discord event, button and
modal, wired together in the matching `index.ts`. Adding a command means adding a file, not
editing a router. The short version of the conventions:

- TypeScript strict mode, no `any`, async/await throughout.
- One responsibility per file: each slash command, Discord event, and button handler lives in its own file.
- `src/services/` holds the boundaries to external APIs and never imports Discord types; `src/runtime/` is where Discord and the agent loop meet.
- Exported functions get a short JSDoc comment.
- Tool descriptions are prompts: write them for the model, stating what the tool sees, what it doesn't, and when to prefer it over a sibling tool.
- For env-var fallbacks use `(process.env.X || "").trim()`, not `??`; empty values in `.env` are common.

## Documentation

- User-visible changes update [README.md](README.md) or [docs/self-hosting.md](docs/self-hosting.md).
- New env vars go in `.env.example`.
- Design decisions that would surprise a future reader belong in the pull request description, so the reasoning survives next to the change.
