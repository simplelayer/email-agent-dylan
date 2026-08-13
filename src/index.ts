// src/index.ts — the front door of the Worker.
//
// A Cloudflare Worker is a small program that runs on Cloudflare's servers
// whenever someone makes an HTTP request to its URL. There is no machine to
// manage — you deploy the code and Cloudflare runs it.
//
// The flow (Stage 3): AgentMail POSTs a "message.received" event to
// /webhooks/agentmail. We check the delivery is genuinely from AgentMail
// (signature), answer 200 immediately, and hand the event to the Durable
// Object for that email thread, which drops duplicates and logs the message.
// Replying comes in Stage 4.

import { DurableObject } from "cloudflare:workers";
import { AgentMailClient } from "agentmail";
import { verifyWebhookSignature } from "./verify";
import { generateReply } from "./agent";
import { type ChatMessage } from "./anthropic";

// Hard limits that keep 25 live agents from melting down on demo day.
const MAX_REPLIES_PER_THREAD = 5;
const HISTORY_MESSAGES = 10;

// Everything the Worker can reach: secrets (set with `wrangler secret put`)
// and the Durable Object namespace declared in wrangler.jsonc.
export interface Env {
  ANTHROPIC_API_KEY: string;
  AGENTMAIL_API_KEY: string;
  COMPOSIO_API_KEY: string;
  AGENTMAIL_WEBHOOK_SECRET: string;
  // Comma-separated emails allowed to talk to the agent (a secret, like the
  // keys above). Empty or unset = reply to anyone — set it!
  ALLOWED_SENDERS?: string;
  EMAIL_AGENT: DurableObjectNamespace<EmailAgent>;
}

// "Jane Doe <jane@example.com>" -> "jane@example.com"; "jane@example.com"
// stays as is. Lowercased so comparisons are case-insensitive.
function emailAddressOf(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

function isAllowedSender(from: string, allowedSenders: string): boolean {
  const allowed = allowedSenders
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  // An empty allowlist means "no restriction".
  if (allowed.length === 0) return true;
  return allowed.includes(emailAddressOf(from));
}

// The shape of AgentMail's webhook body (the fields we use).
// Note: the JSON on the wire uses snake_case.
interface MessageReceivedEvent {
  event_type: string; // "message.received"
  event_id: string;   // unique per event — our dedupe key
  message: {
    inbox_id: string;     // the agent's own address
    thread_id: string;    // conversation this message belongs to
    message_id: string;   // needed later to reply to this exact message
    from: string;         // 'user@example.com' or 'Name <user@example.com>'
    subject?: string | null;
    // extracted_* are AgentMail's cleaned-up versions: quoted history and
    // signatures stripped. Always prefer these over raw text/html — for a
    // forwarded email the raw body is mostly noise.
    extracted_text?: string | null;
    extracted_html?: string | null;
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check: visiting the Worker's URL in a browser should say "ok".
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/webhooks/agentmail") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fail loud and clear when secrets are missing — a fresh deploy with no
  // secrets should produce this log line, not a cryptic stack trace.
  const missing = (
    ["ANTHROPIC_API_KEY", "AGENTMAIL_API_KEY", "COMPOSIO_API_KEY", "AGENTMAIL_WEBHOOK_SECRET"] as const
  ).filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(
      `Missing secrets: ${missing.join(", ")}. ` +
        `Add them with "npx wrangler secret put <NAME>" or in the Cloudflare dashboard ` +
        `(Workers & Pages -> email-agent -> Settings -> Variables and Secrets).`,
    );
  }

  // Read the raw body — the signature is computed over these exact bytes,
  // so we must verify BEFORE parsing the JSON.
  const body = await request.text();

  const svixId = request.headers.get("svix-id") ?? "";
  const svixTimestamp = request.headers.get("svix-timestamp") ?? "";
  const svixSignature = request.headers.get("svix-signature") ?? "";

  const valid = await verifyWebhookSignature(
    env.AGENTMAIL_WEBHOOK_SECRET,
    svixId,
    svixTimestamp,
    svixSignature,
    body,
  );
  if (!valid) {
    // Either a forgery or a misconfigured secret. Log enough to tell which:
    // if YOUR real emails land here, the secret in the Worker is stale
    // (re-run `wrangler secret put AGENTMAIL_WEBHOOK_SECRET`).
    console.error(`webhook: signature verification FAILED (svix-id: ${svixId || "missing"})`);
    return new Response("invalid signature", { status: 401 });
  }

  let event: MessageReceivedEvent;
  try {
    event = JSON.parse(body);
  } catch {
    console.error("webhook: body is not valid JSON");
    return new Response("bad request", { status: 400 });
  }

  // We only subscribed to message.received, but be explicit: ignore anything
  // else (e.g. the .spam / .blocked variants) rather than reacting to it.
  if (event.event_type !== "message.received" || !event.message?.thread_id) {
    console.log(`webhook: ignoring event_type=${event.event_type}`);
    return new Response("ok", { status: 200 });
  }

  // Only talk to people on the allowlist. Everyone else is logged and
  // dropped — no reply, no processing, no Durable Object work. (A reply
  // would leak that the address is live, and would burn API budget.)
  if (!env.ALLOWED_SENDERS) {
    console.warn(
      "ALLOWED_SENDERS is not set — replying to ANYONE who emails this inbox. " +
        "Set it with: npx wrangler secret put ALLOWED_SENDERS",
    );
  }
  if (!isAllowedSender(event.message.from, env.ALLOWED_SENDERS ?? "")) {
    console.log(`webhook: sender not on allowlist, dropping (from: ${event.message.from})`);
    return new Response("ok", { status: 200 });
  }

  // Hand off to the Durable Object for this email thread. getByName gives
  // the SAME object instance for the same thread_id every time — that's what
  // makes dedupe and (later) conversation history reliable.
  //
  // ctx.waitUntil = "answer the webhook now, keep working in the background".
  // AgentMail gets its 200 in milliseconds and never times out / redelivers
  // just because the agent is slow.
  const agent = env.EMAIL_AGENT.getByName(event.message.thread_id);
  ctx.waitUntil(
    agent.handleEvent(event).catch((err) => {
      // Background work has nowhere to return an error, so log it loudly.
      console.error(`agent failed for thread ${event.message.thread_id}:`, err);
    }),
  );

  return new Response("ok", { status: 200 });
}

// One EmailAgent instance exists per email thread. It owns that thread's
// private SQLite database: which webhook events we've already processed,
// and (from Stage 4) the conversation history and reply count.
export class EmailAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create tables on first use. blockConcurrencyWhile = "finish this
    // before handling any requests", so the tables always exist by the
    // time handleEvent runs.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS seen_events (
          event_id TEXT PRIMARY KEY,
          seen_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          role       TEXT NOT NULL,   -- 'user' or 'assistant'
          content    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });
  }

  async handleEvent(event: MessageReceivedEvent): Promise<void> {
    // Dedupe. AgentMail redelivers events if it thinks a delivery failed,
    // so the same event_id can arrive more than once. INSERT OR IGNORE
    // writes 0 rows when the id is already there — duplicate, stop.
    const inserted = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?)",
      event.event_id,
      new Date().toISOString(),
    );
    if (inserted.rowsWritten === 0) {
      console.log(`thread ${event.message.thread_id}: duplicate event ${event.event_id}, skipping`);
      return;
    }

    const msg = event.message;

    // Loop guard: never react to mail from our own address. Two agents that
    // reply to each other create an infinite loop — with 25 live agents in
    // one room, this WILL happen without this check.
    if (emailAddressOf(msg.from) === msg.inbox_id.toLowerCase()) {
      console.log(`thread ${msg.thread_id}: message is from our own inbox, ignoring`);
      return;
    }

    // Reply cap: at most 5 replies per thread, ever. When it's hit we go
    // silent — sending a "limit reached" email would itself be another
    // email, which is exactly what the cap exists to stop.
    const replyCount = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'")
      .one().n;
    if (replyCount >= MAX_REPLIES_PER_THREAD) {
      console.log(
        `thread ${msg.thread_id}: reply cap reached (${replyCount}/${MAX_REPLIES_PER_THREAD}), staying silent`,
      );
      return;
    }

    // Prefer AgentMail's cleaned-up text; fall back to HTML (some mail
    // clients send HTML only) with tags crudely stripped.
    const text =
      msg.extracted_text ??
      (msg.extracted_html ? msg.extracted_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "") ??
      "";

    if (!text && !msg.subject) {
      console.log(`thread ${msg.thread_id}: message has no readable content, skipping`);
      return;
    }

    console.log(
      `thread ${msg.thread_id}: received message ${msg.message_id}\n` +
        `  from:    ${msg.from}\n` +
        `  subject: ${msg.subject ?? "(none)"}\n` +
        `  text:    ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`,
    );

    // Store the incoming message, then load recent history so Claude sees
    // the whole conversation, not just the latest email.
    const incoming = `Subject: ${msg.subject ?? "(none)"}\nFrom: ${msg.from}\n\n${text}`;
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?)",
      incoming,
      new Date().toISOString(),
    );

    const history = this.loadHistory();

    // The shared agent brain (src/agent.ts): Composio tools + Claude +
    // the capped tool loop. Returns null when there's nothing to send.
    let reply: string | null;
    try {
      reply = await generateReply(
        {
          anthropicApiKey: this.env.ANTHROPIC_API_KEY,
          composioApiKey: this.env.COMPOSIO_API_KEY,
        },
        history,
        `thread ${msg.thread_id}`,
      );
    } catch (err) {
      // No reply goes out on failure — better silent than broken. The log
      // tells the operator exactly what to fix.
      console.error(`thread ${msg.thread_id}: Claude call failed:`, (err as Error).message);
      return;
    }

    if (!reply) {
      console.log(`thread ${msg.thread_id}: Claude returned no text, not replying`);
      return;
    }

    // A one-line preview in the logs, so `wrangler tail` shows what the
    // agent is saying without anyone having to open their inbox.
    console.log(`thread ${msg.thread_id}: reply preview: ${reply.slice(0, 300).replace(/\n/g, " ")}`);

    // Send the reply on the same email thread, then remember what we said.
    try {
      const agentmail = new AgentMailClient({ apiKey: this.env.AGENTMAIL_API_KEY });
      await agentmail.inboxes.messages.reply(msg.inbox_id, msg.message_id, { text: reply });
    } catch (err) {
      console.error(`thread ${msg.thread_id}: sending reply failed:`, (err as Error).message);
      return;
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES ('assistant', ?, ?)",
      reply,
      new Date().toISOString(),
    );
    console.log(
      `thread ${msg.thread_id}: replied (${reply.length} chars, reply ${replyCount + 1}/${MAX_REPLIES_PER_THREAD})`,
    );
  }

  // The last few conversation turns, oldest first, shaped for the Messages
  // API. The API requires the first message to be from the user, so any
  // assistant rows left dangling at the front by the LIMIT are dropped.
  private loadHistory(): ChatMessage[] {
    const rows = this.ctx.storage.sql
      .exec<{ role: string; content: string }>(
        "SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        HISTORY_MESSAGES,
      )
      .toArray();
    while (rows.length > 0 && rows[0].role !== "user") {
      rows.shift();
    }
    return rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  }
}
