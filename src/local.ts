// src/local.ts — run the agent on YOUR computer, no deploy needed.
//
// This is the escape hatch for when a Cloudflare deploy is broken: instead
// of AgentMail POSTing webhooks to a public URL, this script opens a
// WebSocket to AgentMail and receives the same events over it. Same brain
// (src/agent.ts), same prompt, no server required.
//
//   Run it:            npm run local
//   Stop it:           Ctrl+C
//
// ⚠ If the deployed Worker is ALSO running, both will answer every email.
//   Run `npm run teardown` first to disconnect the deployed Worker's
//   webhook (and `npm run setup` later to reconnect it).
//
// Keys are read from .dev.vars (same file `wrangler dev` uses).

import { readFileSync } from "node:fs";
import { AgentMailClient } from "agentmail";
import { generateReply } from "./agent";
import { type ChatMessage } from "./anthropic";

const MAX_REPLIES_PER_THREAD = 5;
const HISTORY_MESSAGES = 10;

// --- Read configuration -----------------------------------------------------

function readDevVars(): Record<string, string> {
  try {
    const vars: Record<string, string> = {};
    for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const vars = { ...readDevVars(), ...process.env } as Record<string, string>;

for (const name of ["ANTHROPIC_API_KEY", "AGENTMAIL_API_KEY", "COMPOSIO_API_KEY"]) {
  if (!vars[name]) {
    console.error(`Missing ${name}. Copy .dev.vars.example to .dev.vars and fill it in.`);
    process.exit(1);
  }
}

// Same allowlist idea as the Worker (see wrangler.jsonc). Put a comma-
// separated list in ALLOWED_SENDERS in .dev.vars; empty allows everyone.
const allowedSenders = (vars.ALLOWED_SENDERS ?? "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter((a) => a.length > 0);
if (allowedSenders.length === 0) {
  console.warn("ALLOWED_SENDERS is not set — replying to ANYONE who emails the inbox.");
}

function emailAddressOf(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

// --- Per-thread state, kept in memory (lost on restart — that's fine for
// --- a fallback; the deployed Worker keeps its state in SQLite instead).

const seenEvents = new Set<string>();
const historyByThread = new Map<string, ChatMessage[]>();
const repliesByThread = new Map<string, number>();

// --- Connect and listen -----------------------------------------------------

const client = new AgentMailClient({ apiKey: vars.AGENTMAIL_API_KEY });

// Find our inbox (created by scripts/setup.ts).
const inboxes = await client.inboxes.list();
const inbox = inboxes.inboxes.find((i) => i.clientId === "buildsprint-inbox-v1");
if (!inbox) {
  console.error("No inbox found. Run `npm run setup` first.");
  process.exit(1);
}

console.log(`Listening for mail to ${inbox.inboxId} (Ctrl+C to stop)...`);

// The WebSocket authenticates via an api_key query parameter — it must be
// passed here explicitly (the client's constructor key alone isn't used).
// Note: connect() opens the socket immediately; do NOT also call
// socket.connect() afterwards — that resets the healthy connection.
const socket = await client.websockets.connect({ apiKey: vars.AGENTMAIL_API_KEY });
socket.on("message", (event) => {
  // The socket also delivers subscription confirmations and other event
  // types — we only care about received messages.
  if ("type" in event && event.type === "subscribed") {
    console.log("Subscribed. Waiting for email...");
    return;
  }
  if (!("eventType" in event) || event.eventType !== "message.received") return;
  void handleMessage(event as {
    eventId: string;
    message: {
      inboxId: string;
      threadId: string;
      messageId: string;
      from: string;
      subject?: string | null;
      extractedText?: string | null;
      extractedHtml?: string | null;
    };
  });
});
socket.on("error", (err) => console.error("websocket error:", err.message));
socket.on("close", () => console.log("websocket closed (it reconnects automatically)"));
await socket.waitForOpen();
socket.sendSubscribe({
  type: "subscribe",
  eventTypes: ["message.received"],
  inboxIds: [inbox.inboxId],
});

async function handleMessage(event: {
  eventId: string;
  message: {
    inboxId: string;
    threadId: string;
    messageId: string;
    from: string;
    subject?: string | null;
    extractedText?: string | null;
    extractedHtml?: string | null;
  };
}): Promise<void> {
  const msg = event.message;
  const label = `thread ${msg.threadId}`;

  // Same safety rails as the Worker: dedupe, allowlist, self-guard, cap.
  if (seenEvents.has(event.eventId)) return;
  seenEvents.add(event.eventId);

  const sender = emailAddressOf(msg.from);
  if (allowedSenders.length > 0 && !allowedSenders.includes(sender)) {
    console.log(`${label}: sender not on allowlist, dropping (from: ${msg.from})`);
    return;
  }
  if (sender === msg.inboxId.toLowerCase()) {
    console.log(`${label}: message is from our own inbox, ignoring`);
    return;
  }
  const replies = repliesByThread.get(msg.threadId) ?? 0;
  if (replies >= MAX_REPLIES_PER_THREAD) {
    console.log(`${label}: reply cap reached, staying silent`);
    return;
  }

  const text =
    msg.extractedText ??
    (msg.extractedHtml ? msg.extractedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "") ??
    "";
  if (!text && !msg.subject) return;

  console.log(`${label}: received from ${msg.from}: ${msg.subject ?? "(no subject)"}`);

  const history = historyByThread.get(msg.threadId) ?? [];
  history.push({
    role: "user",
    content: `Subject: ${msg.subject ?? "(none)"}\nFrom: ${msg.from}\n\n${text}`,
  });

  let reply: string | null;
  try {
    reply = await generateReply(
      { anthropicApiKey: vars.ANTHROPIC_API_KEY, composioApiKey: vars.COMPOSIO_API_KEY },
      // Pass a copy: generateReply appends tool turns we don't want to keep.
      [...history.slice(-HISTORY_MESSAGES)],
      label,
    );
  } catch (err) {
    console.error(`${label}: Claude call failed:`, (err as Error).message);
    return;
  }
  if (!reply) return;

  console.log(`${label}: reply preview: ${reply.slice(0, 300).replace(/\n/g, " ")}`);
  try {
    await client.inboxes.messages.reply(msg.inboxId, msg.messageId, { text: reply });
  } catch (err) {
    console.error(`${label}: sending reply failed:`, (err as Error).message);
    return;
  }

  history.push({ role: "assistant", content: reply });
  historyByThread.set(msg.threadId, history.slice(-HISTORY_MESSAGES));
  repliesByThread.set(msg.threadId, replies + 1);
  console.log(`${label}: replied (${replies + 1}/${MAX_REPLIES_PER_THREAD})`);
}
