import assert from "node:assert/strict";
import test from "node:test";

import { HermesApiModelAdapter } from "./hermes-api-model.js";

test("hermes API adapter streams chat completion deltas with stable session header", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
        + 'event: hermes.tool.progress\ndata: {"tool":"terminal"}\n\n'
        + 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
        + "data: [DONE]\n\n",
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };

  const adapter = new HermesApiModelAdapter({
    hermesHome: "/tmp/hermes",
    baseUrl: "http://127.0.0.1:8642/v1",
    model: "hermes-agent",
    apiKey: "secret",
    provider: "",
    channelType: "hermes-agent",
  });

  try {
    const chunks = [];
    for await (const chunk of adapter.streamReply({
      userText: "hello",
      conversationId: "embodied:demo",
      history: [{ role: "assistant", content: "previous" }],
    })) {
      chunks.push(chunk);
    }

    assert.equal(capturedUrl, "http://127.0.0.1:8642/v1/chat/completions");
    assert.equal(capturedHeaders.Authorization, "Bearer secret");
    assert.equal(capturedHeaders["X-Hermes-Session-Id"], "embodied:demo");
    assert.equal(capturedBody.model, "hermes-agent");
    assert.equal(capturedBody.stream, true);
    assert.deepEqual(capturedBody.messages, [
      {
        role: "system",
        content: "You are speaking through an embodied satellite hub. Reply as plain spoken dialogue unless the user explicitly asks for more. Do not add preambles, summaries, or extra reassurance.",
      },
      { role: "assistant", content: "previous" },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(chunks, ["Hi", " there"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hermes API adapter omits session continuation header without API key", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const adapter = new HermesApiModelAdapter({
    hermesHome: "/tmp/hermes",
    baseUrl: "http://127.0.0.1:8642",
    model: "hermes-agent",
    provider: "",
    channelType: "hermes-agent",
  });

  try {
    for await (const _chunk of adapter.streamReply({
      userText: "hello",
      conversationId: "embodied:demo",
      history: [],
    })) {
      // Drain stream.
    }

    assert.equal(capturedHeaders.Authorization, undefined);
    assert.equal(capturedHeaders["X-Hermes-Session-Id"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
