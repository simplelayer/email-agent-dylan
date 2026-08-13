// src/verify.ts — webhook signature verification.
//
// Why this exists: anyone on the internet who discovers our webhook URL could
// POST fake "you received an email" events to it. AgentMail prevents this by
// signing every delivery (using the Svix webhook standard). We recompute the
// signature with our shared secret and reject anything that doesn't match.
//
// How Svix signing works:
//   1. AgentMail sends three headers: svix-id, svix-timestamp, svix-signature.
//   2. The signature is HMAC-SHA256 over the string "{id}.{timestamp}.{body}",
//      keyed with the secret (the part after "whsec_", base64-decoded).
//   3. svix-signature can hold several space-separated candidates like
//      "v1,abc= v1,def=" (this happens after a secret rotation) — the
//      delivery is valid if ANY of them matches.

// Reject deliveries whose timestamp is more than 5 minutes off, so a captured
// request can't be replayed later. 5 minutes is Svix's own recommendation.
const TOLERANCE_SECONDS = 5 * 60;

export async function verifyWebhookSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  body: string,
): Promise<boolean> {
  // 1. Timestamp freshness check.
  const timestamp = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > TOLERANCE_SECONDS) return false;

  // 2. Recompute the expected signature with Web Crypto (built into Workers).
  // The secret is "whsec_" + base64. Trim aggressively first — a secret that
  // picked up stray whitespace or invisible characters while being pasted
  // into `wrangler secret put` would otherwise fail to decode.
  let keyBytes: Uint8Array;
  try {
    // Keep only printable ASCII — drops BOMs, newlines, and other invisible
    // characters that sneak in via copy-paste or shell pipes.
    const base64Part = secret.replace(/[^\x21-\x7e]/g, "").replace(/^whsec_/, "");
    keyBytes = Uint8Array.from(atob(base64Part), (c) => c.charCodeAt(0));
  } catch {
    console.error(
      "AGENTMAIL_WEBHOOK_SECRET is not valid — it should look like 'whsec_...'. " +
        "Re-run: npx wrangler secret put AGENTMAIL_WEBHOOK_SECRET",
    );
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // 3. Accept if any candidate signature matches.
  return svixSignature.split(" ").some((candidate) => {
    const [version, signature] = candidate.split(",");
    return version === "v1" && !!signature && timingSafeEqual(signature, expected);
  });
}

// Compare two strings in constant time. A plain === comparison returns
// faster the earlier the strings differ, which in theory lets an attacker
// guess a signature one character at a time by measuring response times.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
