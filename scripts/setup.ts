// scripts/setup.ts — one-time provisioning. Creates the agent's inbox and
// tells AgentMail where to deliver incoming mail (our Worker's webhook URL).
//
// Run it with:   npm run setup
// (or directly:  npx tsx scripts/setup.ts)
//
// It needs two inputs:
//   AGENTMAIL_API_KEY — read from the environment, or from .dev.vars
//   WORKER_URL        — read from the environment, or passed as an argument:
//                       npx tsx scripts/setup.ts https://email-agent.YOUR-SUBDOMAIN.workers.dev
//
// Safe to run twice: every create call carries a clientId, which AgentMail
// uses to recognize "I already made this" — so re-running never produces
// duplicate inboxes or webhooks.

import { readFileSync } from "node:fs";
import { AgentMailClient, AgentMailError } from "agentmail";

// Stable idempotency keys. Change these only if you intentionally want a
// second inbox/webhook to exist side by side with the old one.
const INBOX_CLIENT_ID = "buildsprint-inbox-v1";
const WEBHOOK_CLIENT_ID = "buildsprint-webhook-v1";

// --- Read inputs ------------------------------------------------------------

// Small helper: read KEY=VALUE lines from .dev.vars so people who already
// filled that file in don't have to set environment variables too.
function readDevVars(): Record<string, string> {
  try {
    const vars: Record<string, string> = {};
    for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
    return vars;
  } catch {
    return {}; // no .dev.vars file — that's fine, env vars still work
  }
}

const devVars = readDevVars();
const apiKey = process.env.AGENTMAIL_API_KEY || devVars.AGENTMAIL_API_KEY;
const workerUrl = (process.env.WORKER_URL || process.argv[2] || "").replace(/\/+$/, "");

if (!apiKey) {
  console.error("Missing AGENTMAIL_API_KEY.");
  console.error("Set it in .dev.vars, or as an environment variable, then re-run.");
  process.exit(1);
}
if (!workerUrl.startsWith("https://")) {
  console.error("Missing or invalid WORKER_URL (must start with https://).");
  console.error("Pass your deployed Worker URL, e.g.:");
  console.error("  npx tsx scripts/setup.ts https://email-agent.YOUR-SUBDOMAIN.workers.dev");
  process.exit(1);
}

// --- Provision --------------------------------------------------------------

const client = new AgentMailClient({ apiKey });

try {
  // 1. The inbox — the email address people write to.
  const inbox = await client.inboxes.create({
    displayName: "Email Agent",
    clientId: INBOX_CLIENT_ID,
  });

  // 2. The webhook — "when mail arrives, POST it to our Worker".
  const webhook = await client.webhooks.create({
    url: `${workerUrl}/webhooks/agentmail`,
    eventTypes: ["message.received"],
    clientId: WEBHOOK_CLIENT_ID,
  });

  // 3. Tell the human what happened and what to do next.
  console.log("");
  console.log("========================================================");
  console.log("  Setup complete");
  console.log("========================================================");
  console.log("");
  console.log(`  Your agent's email address:`);
  console.log(`      ${inbox.inboxId}`);
  console.log("");
  console.log(`  Webhook signing secret (needed by the Worker to trust`);
  console.log(`  incoming webhooks — treat it like a password):`);
  console.log(`      ${webhook.secret}`);
  console.log("");
  console.log("  Next step — give the deployed Worker its secrets.");
  console.log("  Run these and paste the value when each one asks:");
  console.log("");
  console.log("      npx wrangler secret put AGENTMAIL_API_KEY");
  console.log("      npx wrangler secret put AGENTMAIL_WEBHOOK_SECRET");
  console.log("      npx wrangler secret put COMPOSIO_API_KEY");
  console.log("      npx wrangler secret put ANTHROPIC_API_KEY");
  console.log("");
  console.log("  Then send an email to the address above.");
  console.log("");
} catch (err) {
  // Print the real error body from AgentMail, not a generic message —
  // "username already taken" and "invalid API key" need different fixes.
  if (err instanceof AgentMailError) {
    console.error(`AgentMail API error (HTTP ${err.statusCode}):`);
    console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
}
