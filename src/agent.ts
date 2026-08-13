// src/agent.ts — the agent's brain, shared by both ways of running it.
//
// Given a conversation history, this produces the reply text: it sets up
// Composio's tools, asks Claude, runs any tools Claude wants (capped), and
// returns the final text. It deliberately knows nothing about email,
// webhooks, or storage — the Worker (src/index.ts) and the local runner
// (src/local.ts) each handle those their own way and call this.

import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";
import { callAnthropic, textOf, type ChatMessage } from "./anthropic";
import { SYSTEM_PROMPT } from "./prompt";

// A confused agent stops after this many tool round-trips, always.
const MAX_TOOL_TURNS = 5;

// Composio groups app connections (like "my Google Calendar") under a user
// id. One user, one inbox — so one fixed id.
const COMPOSIO_USER_ID = "default";

// Which apps the agent can reach. Add more slugs here as you grow the
// agent (e.g. "gmail", "notion", "github") — one word per app.
const TOOLKITS = ["googlecalendar","gmail"];

// The session object composio.create() returns; tools execute through it.
type ComposioSession = Awaited<ReturnType<Composio<AnthropicProvider>["create"]>>;

export async function generateReply(
  keys: { anthropicApiKey: string; composioApiKey: string },
  history: ChatMessage[],
  logLabel: string,
): Promise<string | null> {
  // Set up Composio's tools. If this fails (bad key, Composio outage),
  // the agent still works — it just answers without tools.
  //
  // Note: tools MUST be executed through the session object below —
  // executing them any other way makes Composio reject the call with
  // "can only be called inside a tool-router session".
  let session: ComposioSession | null = null;
  let tools: unknown[] = [];
  try {
    const composio = new Composio({
      apiKey: keys.composioApiKey,
      provider: new AnthropicProvider(),
    });
    session = await composio.create(COMPOSIO_USER_ID, { toolkits: TOOLKITS });
    tools = (await session.tools()) as unknown[];
  } catch (err) {
    console.error(`${logLabel}: Composio setup failed, continuing without tools:`, (err as Error).message);
  }

  // Ask Claude for a reply. If Claude wants to use tools, run them and
  // feed the results back — up to MAX_TOOL_TURNS round trips, so a
  // confused loop can never run forever.
  const today = new Date().toISOString().slice(0, 10);
  const system = `${SYSTEM_PROMPT}\n\nToday's date is ${today}.`;

  let response = await callAnthropic(keys.anthropicApiKey, { system, messages: history, tools });

  let turns = 0;
  while (response.stop_reason === "tool_use" && session && turns++ < MAX_TOOL_TURNS) {
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    console.log(`${logLabel}: tool turn ${turns}: using ${toolUses.map((b) => b.name).join(", ")}`);

    // Run each tool Claude asked for, inside the Composio session, and
    // collect the results in the shape the Messages API expects. A tool
    // failure becomes an error result Claude can read and react to,
    // instead of killing the whole reply.
    const results = [];
    for (const block of toolUses) {
      let content: string;
      let isError = false;
      try {
        const r = await session.execute(block.name!, (block.input ?? {}) as Record<string, unknown>);
        content = JSON.stringify(r.error ? { error: r.error } : r.data);
        isError = r.error !== null;
      } catch (err) {
        content = `Tool execution failed: ${(err as Error).message}`;
        isError = true;
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content,
        ...(isError ? { is_error: true } : {}),
      });
    }

    history.push({ role: "assistant", content: response.content }, { role: "user", content: results });
    response = await callAnthropic(keys.anthropicApiKey, { system, messages: history, tools });
  }

  const reply = textOf(response);
  return reply.length > 0 ? reply : null;
}
