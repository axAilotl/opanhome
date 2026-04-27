import assert from "node:assert/strict";
import test from "node:test";

import type { PsfnChannelContext } from "./embodied-session.js";
import { PsfnModelAdapter } from "./psfn-model.js";

test("psfn model adapter sends embodied hub channel headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        + "data: [DONE]\n\n",
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };

  const adapter = new PsfnModelAdapter({
    baseUrl: "http://psfn.test",
    model: "psfn",
    apiKey: "secret",
    channelType: "psfn-satellite-hub",
  });
  const channel: PsfnChannelContext = {
    sessionId: "thin-shell:demo",
    channelType: "psfn-satellite-hub",
    channelId: "psfn-satellite-hub:thin-shell:demo",
    sourceSatelliteId: "thin-shell",
    sourceSatelliteName: "Thin Shell",
    activeSatellites: [
      {
        id: "thin-shell",
        name: "Thin Shell",
        transport: "websocket",
        capabilities: {
          input: ["text"],
          output: ["text", "subtitle"],
          control: ["interrupt"],
          safety: [],
        },
      },
    ],
  };

  try {
    const chunks = [];
    for await (const chunk of adapter.streamReply({
      userText: "hello",
      conversationId: "thin-shell:demo",
      history: [],
      channel,
    })) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, ["Hello"]);
    assert.equal(capturedHeaders.Authorization, "Bearer secret");
    assert.equal(capturedHeaders["X-PSFN-Channel-Type"], "psfn-satellite-hub");
    assert.equal(capturedHeaders["X-PSFN-Channel-ID"], "psfn-satellite-hub:thin-shell:demo");
    assert.equal(capturedHeaders["X-PSFN-Satellite-ID"], "thin-shell");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Name"], "Thin Shell");
    assert.equal(capturedBody.user, "thin-shell:demo");
    assert.deepEqual(capturedBody.messages, [{ role: "user", content: "hello" }]);
    assert.deepEqual(JSON.parse(capturedHeaders["X-PSFN-Channel-Metadata"] || "{}"), {
      sessionId: "thin-shell:demo",
      sourceSatelliteId: "thin-shell",
      sourceSatelliteName: "Thin Shell",
      activeSatellites: channel.activeSatellites,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
