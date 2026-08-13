# Secrets — what each one is and where to get it

The agent needs five secrets. Think of them as the five keys on its keyring:
one to think, one to read and send email, one to use your other apps, one to
know who it's allowed to talk to, and one to know which mail is genuine.

**Where to add them:** [Cloudflare dashboard](https://dash.cloudflare.com) →
**Workers & Pages → email-agent → Settings → Variables and Secrets → Add**.
Choose type **Secret**, enter the name exactly as shown below (uppercase,
underscores), paste the value, save. Repeat for each row.

| Name | What it unlocks | Looks like |
|---|---|---|
| `ANTHROPIC_API_KEY` | The AI brain (Claude) | `sk-ant-api03-...` |
| `AGENTMAIL_API_KEY` | The email inbox | `am_...` |
| `COMPOSIO_API_KEY` | Tools (Google Calendar, …) | `ak_...` |
| `ALLOWED_SENDERS` | Who may talk to the agent | `you@example.com` |
| `AGENTMAIL_WEBHOOK_SECRET` | Proof that mail is genuine | `whsec_...` |

---

## `ANTHROPIC_API_KEY` — the brain

Lets the agent call **Claude**, the AI model that reads each email and writes
the reply. Every reply the agent sends costs a fraction of a cent from the
Anthropic account this key belongs to.

- **Get it:** [console.anthropic.com](https://console.anthropic.com) →
  **API keys** → **Create key**. Copy it immediately — it's shown only once.
- **Format:** starts with `sk-ant-`.
- **If it's missing or wrong:** the agent receives email but never replies.
  The logs (`npx wrangler tail`) say exactly that:
  `ANTHROPIC_API_KEY is not set` or `Anthropic API error (HTTP 401)`.

## `AGENTMAIL_API_KEY` — the inbox

Lets the agent use **AgentMail**, the service that gives it an email address.
This key is how the agent reads incoming mail and sends replies — and how the
setup script creates the inbox in the first place.

- **Get it:** [agentmail.to](https://agentmail.to) → dashboard → **API keys**.
  Create an **organization-scoped** key — a key scoped to a single inbox
  can't create inboxes or webhooks, and setup will fail with a permission
  error naming the missing permission.
- **Format:** starts with `am_`.
- **If it's missing or wrong:** replies fail with `sending reply failed` in
  the logs, and `npm run setup` prints the API's error message.

## `COMPOSIO_API_KEY` — the hands

Lets the agent use **Composio**, which connects it to your other apps
(Google Calendar to start; Gmail, Notion, GitHub and hundreds more can be
added later). When you ask "what's on my calendar tomorrow?", this is the
key doing the work.

- **Get it:** [composio.dev](https://composio.dev) → **Settings → API keys**.
- **Format:** starts with `ak_`.
- **If it's missing or wrong:** the agent still answers emails — it just
  loses its tools. The logs say
  `Composio setup failed, continuing without tools`.

## `ALLOWED_SENDERS` — the guest list

Not a key from any website — **you write this one yourself.** It's the list
of email addresses the agent will talk to. Anyone not on the list is silently
ignored: no reply, no AI call, no cost. This is also the agent's main defense
against runaway loops (two agents replying to each other forever).

- **Value:** your own email address. Several people? Separate with commas:
  `you@example.com, teammate@example.com`. Case doesn't matter.
- **If it's missing or empty:** the agent replies to **anyone** who discovers
  its address — spending your Anthropic credits on every reply. The logs
  warn: `ALLOWED_SENDERS is not set — replying to ANYONE`.

## `AGENTMAIL_WEBHOOK_SECRET` — the wax seal

When email arrives, AgentMail notifies your agent over the internet — and
signs each notification with this shared secret so your agent can tell real
mail from forgeries. Without checking the seal, anyone who found your
agent's URL could feed it fake "emails".

- **Get it:** printed by the setup script (`npx tsx scripts/setup.ts <your
  worker URL>`) when it creates the webhook. You can't look it up later —
  copy it when it appears.
- **Format:** starts with `whsec_`.
- **If it's missing or wrong:** every incoming email is rejected as a
  possible forgery. The logs show `signature verification FAILED`.
- **⚠ It changes when you re-run setup after a teardown.** If you use the
  kill switch (`npm run teardown`) and later reconnect (`npm run setup`),
  a **new** secret is printed — update it here in the dashboard, or every
  email will be rejected.

---

## Good to know

- **Secrets vs. code:** secrets live only in Cloudflare (and in your local
  `.dev.vars` file, which git is configured to never commit). The code in
  this repo contains none of them — that's why it's safe to share.
- **Made a mistake?** Just add the secret again with the same name — the new
  value replaces the old one instantly, no redeploy needed.
- **Prefer the terminal?** Each secret can also be set with
  `npx wrangler secret put NAME` from the project folder — it prompts you
  to paste the value.
