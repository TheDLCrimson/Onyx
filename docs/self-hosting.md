# Self-hosting Onyx

This guide takes you from nothing to a working Onyx instance in your own Discord server.
Plan on about 20 minutes, most of it clicking through the Discord developer portal.

You will need:

- **Node.js 22** (20 or newer works) with **pnpm 10**, or **Docker**.
- A **Discord** account that can add bots to a server.
- An **OpenRouter** account and API key.
- A **GitHub** account for Onyx to commit as.

## 1. Create the Discord application

1. Open the [Discord developer portal](https://discord.com/developers/applications) and click **New Application**.
2. On **General Information**, copy the **Application ID**.
   This is `DISCORD_CLIENT_ID`.
3. Open the **Bot** page:
   - Click **Reset Token** and copy the token.
     This is `DISCORD_TOKEN`; treat it like a password.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent**.
     Onyx reads replies in the channel while it is planning, and Discord refuses the connection ("Used disallowed intents") if this is off.
   - Turn **Public Bot** off, so only you can add the bot to servers.

You don't need to build an invite URL by hand: Onyx logs one at startup with the right permissions.

## 2. Choose the GitHub identity

Onyx makes every commit and pull request as the account that owns `GITHUB_TOKEN`.
Pick one of two setups.

**Solo: your own account.**
Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to the repos Onyx should work on, with these repository permissions:

- Contents: read and write
- Pull requests: read and write
- Metadata: read

Pull requests will appear as opened by you.

**Shared: a dedicated bot account.**
Create a separate GitHub account for the bot and give it a [classic token](https://github.com/settings/tokens) with the `repo` scope.
Anyone who wants to use Onyx invites that account as a collaborator with Write access on their repo.
Onyx accepts pending invitations when it starts and whenever someone runs `/repo set`.
This is how the original instance was run for a group of friends.

Either way, Onyx works out the account's login from the token; set `GITHUB_BOT_USERNAME` only to override it.

## 3. Get an OpenRouter key and pick models

Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
This is `OPENROUTER_API_KEY`.
Giving the key a credit limit is a cheap safety net.

Onyx uses two model tiers:

- `ONYX_MODEL` (heavy) runs the agent loop and writes code.
  Every model listed here must support tool calling.
  Default: `anthropic/claude-sonnet-4.6`.
- `ONYX_MODEL_LIGHT` (light) writes PR summaries, verifies plans, and answers single-file questions.
  Default: `anthropic/claude-haiku-4.5`.

Either variable can hold a comma-separated list of up to three model ids.
The first model is used normally, and OpenRouter falls through the rest in order when one is rate-limited or unavailable.
Longer lists are rejected by OpenRouter, so Onyx sends only the first three and logs the ones it dropped at startup.

To run at zero cost, use free models, for example:

```bash
ONYX_MODEL=nex-agi/nex-n2.5-pro:free,poolside/laguna-s-2.1:free,dots-studio/dots-3-note-preview:free
ONYX_MODEL_LIGHT=nvidia/nemotron-3-super-120b-a12b:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free
```

Things to know about free models:

- Give the light tier a fallback list too, not just the heavy one.
  It writes PR summaries and plan verdicts, and a single overloaded free model there means every
  PR says "summary unavailable" and "not checked" while the feature itself works fine.

- They are rate-limited upstream, and OpenRouter caps how many free requests an account can make per day (the cap is higher once you have bought credits).
  A single `/feature` run can take dozens of requests, so a fallback list helps a lot.
- They plan less reliably than frontier models, and plan quality drives everything downstream.
- The lineup changes often.
  Browse [openrouter.ai/models?q=free](https://openrouter.ai/models?q=free), filter for tool support, and check that a model still exists before relying on it.

Prompt caching is only used with Anthropic models, where it cuts the cost of the long system prompt; other models simply ignore it.

## 4. Configure

```bash
git clone https://github.com/TheDLCrimson/Onyx.git
cd Onyx
cp .env.example .env
```

Fill in the four required values: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `OPENROUTER_API_KEY`, and `GITHUB_TOKEN`.
Everything else is optional and documented in [`.env.example`](../.env.example).
The most useful optional settings:

| Variable | Purpose |
| --- | --- |
| `ONYX_MODEL`, `ONYX_MODEL_LIGHT` | Models per tier, optionally with fallbacks |
| `GITHUB_OWNER`, `GITHUB_REPO` | Default repo for channels without a `/repo set` binding |
| `ONYX_CHANNEL_BUDGET_USD` | Daily spend cap per channel |
| `DISCORD_GUILD_ID` | Register commands in one server only (instant; handy while developing) |

## 5. Run it

**Docker Compose (recommended).**

```bash
docker compose up -d --build
docker compose logs -f
```

The image includes the build-gate toolchains (git, pyright, and, where available, the .NET SDK).
`./data` is mounted into the container, so sessions and repo bindings survive restarts and rebuilds.

**Node directly.**

```bash
pnpm install
pnpm build
pnpm start
```

The build gate needs `git` on the `PATH`, plus `pyright` for Python repos and the .NET SDK for C#/Unity repos.
If a toolchain is missing, that check is skipped rather than failing the run.

**A hosting platform** (Railway, Fly.io, Render, and similar).
Deploy from the `Dockerfile`, set the environment variables in the platform's dashboard, and attach a persistent volume at `/app/data`.
Run a single instance: two processes with the same bot token will both answer every command.

## 6. Add the bot to your server

When Onyx starts, the log shows something like:

```
[models] heavy: anthropic/claude-sonnet-4.6 | light: anthropic/claude-haiku-4.5 (Anthropic prompt caching enabled for stable system prefixes)
Logged in as Onyx#1234
Invite URL: https://discord.com/oauth2/authorize?client_id=...
GitHub identity: your-bot-account (commits and PRs are made as this account)
```

Open the invite URL and pick your server.
Slash commands are registered as soon as the bot joins.
Then, in the channel you want to work in:

```
/start
/repo set owner:<owner> repo:<repo>
/feature add a health-check endpoint
```

Share [onboarding.md](onboarding.md) with anyone else who will use your instance.

## Data and persistence

Onyx keeps its state in `data/`:

| File | Contents |
| --- | --- |
| `sessions.json` | Per-channel sessions: active feature, mode, and any in-flight run |
| `channel-repos.json` | Channel-to-repo bindings from `/repo set` |
| `usage.json` | Token counts and cost for every model call (pruned after `ONYX_USAGE_RETENTION_DAYS`) |

All three are written atomically (temp file, then rename).
Set `ONYX_DATA_DIR` to keep them somewhere else, for example on a mounted volume.
Do not point it at a directory a test run shares: the session store rewrites its whole
file, so `pnpm test` against a live `data/` would erase active features.
An interrupted run can be resumed after a restart for `ONYX_RESUME_WINDOW_MINUTES` (default 60); Onyx posts a message with **Continue** and **Cancel** buttons in the channel.

## Security checklist

Onyx acts with your GitHub token and spends your OpenRouter credits on behalf of whoever can run its commands.

- Keep **Public Bot** off in the developer portal.
- Limit who can use the commands: **Server Settings → Integrations → Onyx** lets you restrict commands to roles or channels.
- Scope `GITHUB_TOKEN` to the repos Onyx should touch.
- The build gate runs the repo's own build tooling (`tsc`, `pyright`, `dotnet build`) on the machine Onyx runs on.
  Package installs use `--ignore-scripts`, but project build files can still run code, so only bind repos you trust, and run Onyx in its container.
- Set `ONYX_CHANNEL_BUDGET_USD` and a credit limit on the OpenRouter key.
- Onyx never merges pull requests; reviewing them is the human's job.

## Troubleshooting

**The bot exits with "Used disallowed intents".**
Enable **Message Content Intent** on the Bot page of the developer portal (step 1).

**Slash commands don't appear.**
Check that `DISCORD_CLIENT_ID` is set; Onyx warns at startup when it isn't.
Registration is logged as "Registered commands …"; restarting your Discord client can help.

**"The model provider is rate-limiting requests (429)".**
Common with free models.
Wait a minute and press **Continue** (progress is kept), or add more fallback models to `ONYX_MODEL`.

**"OpenRouter reports insufficient credits (402)".**
Add credits, raise the key's credit limit, or switch to `:free` models.

**"Model request failed (400): … is not a valid model ID".**
A model id in `ONYX_MODEL` or `ONYX_MODEL_LIGHT` is misspelled or has been retired on OpenRouter.

**`/repo set` says it can't access the repo.**
The account behind `GITHUB_TOKEN` can't see it.
For a fine-grained token, add the repo to the token; for a bot account, invite it as a collaborator and run `/repo set` again.

**Onyx says code is missing when it is not there.**
GitHub code search (`Grep`) lags pushes by minutes and allows only about 10 searches per minute,
so it can come back empty for code that exists.
Onyx tells the model this, but weaker models still misread it.
Run with `DEBUG=tools` to log every tool call and the head of its result, which shows whether the
tool returned the wrong thing or the model misread it.
`DEBUG=cache` does the same for prompt-cache metrics.

**TLS errors behind a corporate proxy or antivirus (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).**
Set `NODE_OPTIONS=--use-system-ca` so Node trusts the operating system's certificate store.

## Updating

```bash
git pull
docker compose up -d --build   # or: pnpm install && pnpm build && pnpm start
```

`data/` is untouched by updates.
