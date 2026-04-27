import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import type { ConversationMessage } from "./session-store.js";
import type { HermesRuntimeConfig } from "../shared/env.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are speaking through an embodied satellite hub. "
  + "Reply as plain spoken dialogue unless the user explicitly asks for more. "
  + "Do not add preambles, summaries, or extra reassurance.";

export class HermesApiModelAdapter implements AgentRuntimeAdapter {
  private readonly apiBaseUrl: string;

  constructor(private readonly runtime: HermesRuntimeConfig) {
    const baseUrl = runtime.baseUrl.replace(/\/$/, "");
    this.apiBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  }

  async *streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
  }): AsyncGenerator<string, string, void> {
    const conversationId = input.conversationId?.trim();
    if (!conversationId) {
      throw new Error("Hermes conversation ID is required for the satellite hub");
    }

    const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(conversationId),
      body: JSON.stringify({
        model: this.runtime.model,
        stream: true,
        messages: this.buildMessages(input.history ?? [], input.userText),
      }),
    });

    if (!response.ok) {
      throw new Error(await formatError(response));
    }
    if (!response.body) {
      throw new Error("Hermes chat completion response did not include a body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const delta = extractDelta(rawEvent);
        if (!delta) continue;
        fullText += delta;
        yield delta;
      }
    }

    return fullText.trim();
  }

  async close(): Promise<void> {}

  private buildHeaders(conversationId: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.runtime.apiKey) {
      headers.Authorization = `Bearer ${this.runtime.apiKey}`;
      headers["X-Hermes-Session-Id"] = conversationId;
    }
    return headers;
  }

  private buildMessages(history: ConversationMessage[], userText: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
    ];
    messages.push(
      ...history
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
          role: message.role,
          content: message.content,
        })),
    );
    if (!messages.length || messages[messages.length - 1]?.content !== userText) {
      messages.push({ role: "user", content: userText });
    }
    return messages;
  }
}

function extractDelta(rawEvent: string): string {
  const lines = rawEvent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const delta = extractDeltaPayload(payload);
    if (delta) return delta;
  }
  return "";
}

function extractDeltaPayload(payload: string): string {
  const parsed = JSON.parse(payload) as {
    choices?: Array<{
      delta?: { content?: string; role?: string };
      message?: { content?: string };
      text?: string;
    }>;
  };
  const firstChoice = parsed.choices?.[0];
  if (!firstChoice) return "";
  if (typeof firstChoice.delta?.content === "string") return firstChoice.delta.content;
  if (typeof firstChoice.message?.content === "string") return firstChoice.message.content;
  if (typeof firstChoice.text === "string") return firstChoice.text;
  return "";
}

async function formatError(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (body) {
    return `Hermes chat completion failed (${response.status}): ${body}`;
  }
  return `Hermes chat completion failed (${response.status})`;
}
