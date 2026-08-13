// scripts/teardown.ts — the kill switch.
//
// Deletes the webhook, which instantly stops AgentMail from delivering any
// mail to the Worker. The inbox and its mail survive; the agent just goes
// deaf. Re-run `npm run setup` to turn it back on.
//
// Run it with:   npm run teardown
//
// It finds the webhook by its clientId, so it works even on a fresh clone
// with no local state.

import { readFileSync } from "node:fs";
import { AgentMailClient, AgentMailError } from "agentmail";

const WEBHOOK_CLIENT_ID = "buildsprint-webhook-v1";

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

const apiKey = process.env.AGENTMAIL_API_KEY || readDevVars().AGENTMAIL_API_KEY;
if (!apiKey) {
  console.error("Missing AGENTMAIL_API_KEY (set it in .dev.vars or the environment).");
  process.exit(1);
}

const client = new AgentMailClient({ apiKey });

try {
  const { webhooks } = await client.webhooks.list();
  const ours = webhooks.filter((w) => w.clientId === WEBHOOK_CLIENT_ID);

  if (ours.length === 0) {
    console.log("No webhook found — the agent is already disconnected.");
    process.exit(0);
  }

  for (const w of ours) {
    await client.webhooks.delete(w.webhookId);
    console.log(`Deleted webhook ${w.webhookId} (${w.url})`);
  }
  console.log("");
  console.log("The agent can no longer receive mail. Run `npm run setup` to reconnect it.");
} catch (err) {
  if (err instanceof AgentMailError) {
    console.error(`AgentMail API error (HTTP ${err.statusCode}):`);
    console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
}
