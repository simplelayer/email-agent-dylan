# Email Agent — an AI assistant you talk to by email

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Modern-Zen/email-agent)

This is a small AI agent with an email address. You email it, it reads the
email, thinks (using Claude), optionally checks your other apps (like Google
Calendar), and replies on the same thread. Forwarding an email to it counts
as a request. That's the whole thing.

```
inbound email
     │
AgentMail ──webhook──▶ Cloudflare Worker  (answers instantly)
     ▲                        │
     │                        ▼
     │                 Durable Object   (remembers each conversation)
     │                        │
     │                        ▼
     │                 Claude (Anthropic)  ←→  Composio tools (Calendar…)
     │                        │
     └──── reply ◀────────────┘
```

## What you need

Four free-tier accounts (each takes ~2 minutes to create):

| Account | What it does | Where the API key lives |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Runs the agent | (no key needed — you'll log in) |
| [Anthropic](https://console.anthropic.com) | The AI brain (Claude) | Console → API keys |
| [AgentMail](https://agentmail.to) | The email inbox | Dashboard → API keys |
| [Composio](https://composio.dev) | Connects Google Calendar etc. | Settings → API keys |

Step 3 needs a terminal with [Node.js](https://nodejs.org). **You don't have
to install anything for that** — step 3 shows a browser-only route
(GitHub Codespaces) alongside the on-your-computer route.

## Step 1 — Deploy

Click the **Deploy to Cloudflare** button at the top. Cloudflare will copy this
project into your account and deploy it. At the end you'll get a URL like:

```
https://email-agent.YOUR-SUBDOMAIN.workers.dev
```

Copy it — you'll need it in step 3. (Visiting it should show `ok`.)

## Step 2 — Add your API keys

In the [Cloudflare dashboard](https://dash.cloudflare.com): **Workers & Pages
→ email-agent → Settings → Variables and Secrets → Add**. Choose type
**Secret** and add these three (paste each key as the value):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key (`sk-ant-...`) |
| `AGENTMAIL_API_KEY` | your AgentMail key (`am_...`) |
| `COMPOSIO_API_KEY` | your Composio key (`ak_...`) |
| `ALLOWED_SENDERS` | **your own email address** |

`ALLOWED_SENDERS` is who the agent will talk to (comma-separate several
addresses). Anyone not on the list is silently ignored. If you skip it, the
agent replies to *anyone* who finds the address — and spends your API
credits doing so.

(A fifth secret, `AGENTMAIL_WEBHOOK_SECRET`, comes out of step 3.)

Not sure what one of these is for, or where to find it? **[SECRETS.md](SECRETS.md)**
explains every secret in plain English — what it unlocks, where to get it, and
what breaks without it.

## Step 3 — Create the inbox

This step runs one small script. Pick whichever route suits you:

**Route A — in your browser, nothing to install (recommended).**
When you clicked the Deploy button, Cloudflare created a copy of this repo
in *your* GitHub account. Open that repo on github.com, click the green
**Code** button → **Codespaces** → **Create codespace**. After a minute you
get an editor with a terminal at the bottom — Node.js preinstalled,
dependencies already installed, already in the right folder.

**Route B — on your own computer.** Install [Node.js](https://nodejs.org)
(LTS), download this project, open a terminal *in the project folder*
(Windows: open the folder in File Explorer, right-click → "Open in
Terminal"), and run `npm install` first.

Then, in either route's terminal:

```bash
npx tsx scripts/setup.ts https://email-agent.YOUR-SUBDOMAIN.workers.dev
```

(Use your real URL from step 1. The script needs your AgentMail key —
either copy `.dev.vars.example` to `.dev.vars` and fill it in, or set the
`AGENTMAIL_API_KEY` environment variable first.)

The script prints two things:

1. **Your agent's email address** — this is the address you'll write to.
2. **A webhook signing secret** (`whsec_...`) — add it in the Cloudflare
   dashboard exactly like step 2, as a secret named `AGENTMAIL_WEBHOOK_SECRET`.

Safe to run twice — it never creates duplicates.

## Step 4 — Say hello

Send an email to your agent's address from the address you allowlisted.
Ask it anything. You should get a reply on the same thread in ~15 seconds.

Then try: *"What's on my calendar tomorrow?"* — the agent will email you a
link to connect Google Calendar (click it within 10 minutes), and once
connected it can actually read your calendar.

To watch the agent think in real time:

```bash
npx wrangler tail
```

## Make it yours

Open **`src/prompt.ts`**. Everything the agent knows about you — its
personality, your name, your timezone, your standing rules — lives in that
one file, in plain English.

**Deployed with the button?** Edit the file in your Codespace (or on
github.com directly), then commit and push — Cloudflare redeploys your
agent automatically on every push. No other tools needed.

**Working from a plain local clone?** Redeploy with:

```bash
npm run deploy
```

To give it more apps, add slugs to the `TOOLKITS` list in `src/agent.ts`
(e.g. `"gmail"`, `"notion"`, `"github"`) and redeploy.

## The kill switch

If the agent ever needs to be stopped immediately:

```bash
npm run teardown
```

That disconnects the inbox from the agent in ~2 seconds. Mail still arrives
in the inbox; the agent just stops seeing it. To reconnect, run setup again —
**note it prints a NEW signing secret**, which you must update in the
Cloudflare dashboard (`AGENTMAIL_WEBHOOK_SECRET`), or every email will be
rejected with "signature verification FAILED".

## Plan B: run it on your laptop

Deploy broken mid-demo? The same agent can run locally with no public URL —
it listens over a WebSocket instead of a webhook:

```bash
npm run teardown   # stop the deployed agent from also replying
npm run local      # run the agent on your machine (Ctrl+C to stop)
```

It reads keys from `.dev.vars` (copy `.dev.vars.example` and fill it in).
Conversation memory lives in RAM, so it forgets threads when you stop it —
fine for a fallback.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No reply at all | Run `npx wrangler tail` and email again — the log says exactly what's wrong. Most common: sender not on `ALLOWED_SENDERS`. |
| Log says `Missing secrets: ...` | Add the named secrets (step 2 / step 3.2). |
| Log says `signature verification FAILED` | The webhook secret is stale — re-run setup, copy the new `whsec_...` into the dashboard. |
| Agent went quiet mid-conversation | Each thread stops after 5 replies (loop protection). Start a new email thread. |
| "Google Calendar isn't connected" every time | The connect link expires after 10 minutes — ask again and click the fresh link promptly. |
| Reply says it can't see your calendar after connecting | Give it ~30 seconds after authorizing, then email again. |
| Windows: `npm` says "running scripts is disabled" | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then retry — or use the browser route (Codespaces) and skip local setup entirely. |
| Windows: `node` or `npm` "is not recognized" after installing | Close the terminal and open a new one — the fresh install isn't visible to already-open windows. |

## How it's built (for the curious)

- `src/index.ts` — receives webhooks, verifies they're really from AgentMail,
  and hands each email to a Durable Object (one per conversation) that
  remembers history in SQLite, drops duplicate deliveries, and enforces the
  5-replies-per-thread cap.
- `src/agent.ts` — the brain: calls Claude, runs tools via Composio (capped
  at 5 tool rounds), returns the reply text.
- `src/prompt.ts` — the agent's instructions. The file you edit.
- `src/anthropic.ts` — one `fetch` call to Claude's API. No SDK.
- `src/local.ts` — the laptop fallback (same brain, WebSocket transport).
- `scripts/setup.ts` / `scripts/teardown.ts` — create/disconnect the inbox.
