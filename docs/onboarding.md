# Using Onyx in your server

This page is for people using an Onyx instance someone has already set up.
To run your own instance, see [self-hosting.md](self-hosting.md).

## Step 1 - add the bot to your server

Ask whoever runs the instance for the invite link (Onyx prints it in its logs at startup).
When Onyx joins, it posts a welcome message in the server's system channel.

## Step 2 - give the bot access to your repo

Onyx commits and opens pull requests as one GitHub account, chosen by whoever runs the instance.
Run `/start` in Discord to see which account that is.

If the repo already belongs to that account, skip this step.
Otherwise, for each repo you want Onyx to work on:

1. Open `https://github.com/<owner>/<repo>/settings/access`.
2. Invite the bot's account as a **collaborator** with **Write** (or Admin) access.
3. Onyx accepts invitations when it starts and again whenever someone runs `/repo set`.

## Step 3 - bind a channel to the repo

In the Discord channel where you want to work:

```
/repo set owner:<owner> repo:<repo>
```

Every `/create`, `/edit`, `/feature`, `/refine`, and `/ask` in that channel now targets that repo.
Different channels can target different repos.

## Step 4 - build something

```
/feature add a dark mode toggle to the settings page
```

Onyx explores the repo in read-only plan mode and may ask clarifying questions (reply in the channel).
It then posts a plan with **Run**, **Revise**, and **Cancel** buttons.
After you click **Run**, it writes the code on a new branch and opens a pull request for you to review.

Type `/help` to see every command.

## Troubleshooting

**"Can't access repo" from `/repo set`**
The bot's account can't see the repo.
Check that you invited the right account (see `/start`) and that the invitation was accepted.

**Slash commands don't show up**
Make sure the bot can view the channel and send messages there.
Freshly registered commands can take a minute to appear; restarting your Discord client helps.

**"The model provider is rate-limiting requests"**
The instance is probably running free models, which are rate-limited upstream.
Wait a minute and click **Continue** (your progress is kept), or ask the operator to add fallback models.

**The bot doesn't respond at all**
Check that it's online (green dot).
If it is, ask the operator to look at the bot's logs.
