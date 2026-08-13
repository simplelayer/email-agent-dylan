// src/anthropic.ts — one function: send a conversation to Claude, get a reply.
//
// We call the Anthropic Messages API with plain fetch instead of the official
// SDK. One HTTPS request is all this needs, and fewer dependencies means less
// to explain and less to break.

// The shape of one conversation turn, as the Messages API expects it.
export interface ChatMessage {
  role: "user" | "assistant";
  content: unknown; // string, or an array of content blocks (used with tools later)
}

// The parts of the API response we care about. `text` is set on text
// blocks; `id`/`name`/`input` are set on tool_use blocks (which tool
// Claude wants to call, and with what arguments).
export interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    [key: string]: unknown;
  }>;
  stop_reason: string;
}

export async function callAnthropic(
  apiKey: string,
  params: {
    system: string;
    messages: ChatMessage[];
    tools?: unknown[];
  },
): Promise<AnthropicResponse> {
  if (!apiKey) {
    // Fail with a message a person can act on, not a cryptic stack trace.
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Run: npx wrangler secret put ANTHROPIC_API_KEY",
    );
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: params.system,
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    }),
  });

  if (!response.ok) {
    // Include the API's actual error body — it says exactly what's wrong
    // (bad key, overloaded, malformed request), which a generic message hides.
    const body = await response.text();
    throw new Error(`Anthropic API error (HTTP ${response.status}): ${body}`);
  }

  return (await response.json()) as AnthropicResponse;
}

// Pull the plain-text parts out of a response (skipping tool-use blocks etc.).
export function textOf(response: AnthropicResponse): string {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
