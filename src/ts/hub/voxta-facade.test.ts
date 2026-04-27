import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import WebSocket, { type RawData } from "ws";

import type { HubConfig } from "../shared/env.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import type { PsfnChannelContext } from "./embodied-session.js";
import { RealtimeHubServer } from "./server.js";
import type { ConversationMessage } from "./session-store.js";

const SIGNALR_RECORD_SEPARATOR = "\x1e";

class FakeAgent implements AgentRuntimeAdapter {
  readonly calls: Array<{
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }> = [];

  async *streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Hello";
    yield " from PSFN";
    return "Hello from PSFN";
  }

  async close(): Promise<void> {}
}

test("Voxta facade negotiates SignalR and routes SendMessage into the embodied session", async () => {
  const agent = new FakeAgent();
  const server = new RealtimeHubServer(testHubConfig(), { agent });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const negotiate = await fetch(`${baseUrl}/hub/negotiate?negotiateVersion=1`, {
      method: "POST",
    });
    assert.equal(negotiate.status, 200);
    const negotiation = await negotiate.json() as {
      connectionToken: string;
      availableTransports: Array<{ transport: string }>;
    };
    assert.equal(negotiation.availableTransports[0]?.transport, "WebSockets");

    socket = await openSocket(
      `ws://127.0.0.1:${address.port}/hub?id=${encodeURIComponent(negotiation.connectionToken)}`,
    );
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);

    socket.send(encodeFrame(invocation("auth-1", { $type: "authenticate" })));
    await waitForVoxta(frames, "welcome");
    await waitForCompletion(frames, "auth-1");

    socket.send(encodeFrame(invocation("start-1", {
      $type: "startChat",
      characterId: "psfn-assistant",
    })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    const sessionId = String(chatStarted.sessionId);
    await waitForCompletion(frames, "start-1");

    socket.send(encodeFrame(invocation("trigger-1", {
      $type: "triggerAction",
      sessionId,
      value: "wave",
      arguments: { intensity: 1 },
    })));
    const appTrigger = await waitForVoxta(frames, "appTrigger");
    await waitForCompletion(frames, "trigger-1");
    assert.equal(appTrigger.value, "wave");

    socket.send(encodeFrame(invocation("trigger-2", {
      $type: "triggerAction",
      sessionId,
      value: "unsafeAction",
    })));
    const deniedTrigger = await waitForCompletion(frames, "trigger-2");
    assert.match(String(deniedTrigger.error), /not allowlisted/);

    socket.send(encodeFrame(invocation("send-1", {
      $type: "send",
      sessionId,
      text: "hello there",
    })));
    const finalAssistantMessage = await waitForVoxta(
      frames,
      "message",
      (payload) => payload.role === "Assistant",
    );
    await waitForVoxta(frames, "replyEnd");
    await waitForCompletion(frames, "send-1");

    assert.equal(finalAssistantMessage.text, "Hello from PSFN");
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0]?.userText, "hello there");
    assert.equal(agent.calls[0]?.conversationId, sessionId);
    assert.equal(agent.calls[0]?.channel?.sourceSatelliteId, "voxta-vam");
    assert.ok(
      agent.calls[0]?.channel?.activeSatellites[0]?.capabilities.output.includes("local_file_audio"),
    );
    assert.ok(
      agent.calls[0]?.channel?.activeSatellites[0]?.capabilities.output.includes("action"),
    );
  } finally {
    socket?.close();
    await server.close();
  }
});

function testHubConfig(): HubConfig {
  return {
    agentRuntime: "psfn",
    bindHost: "127.0.0.1",
    port: 0,
    deepgramApiKey: "test-deepgram",
    elevenlabsApiKey: "test-elevenlabs",
    elevenlabsVoiceId: "test-voice",
    elevenlabsModelId: "eleven_flash_v2_5",
    artifactsRoot: ".artifacts/test-voxta",
    psfn: {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "psfn",
      channelType: "psfn-satellite-hub",
    },
    hermes: null,
    voxta: {
      enabled: true,
      satelliteId: "voxta-vam",
      satelliteName: "Voxta VaM",
      assistantId: "psfn-assistant",
      assistantName: "PSFN",
      userId: "voxta-user",
      userName: "User",
      appLabel: "PSFN Satellite Hub",
      clientVersion: "1.2.1",
      actionAllowlist: ["wave"],
    },
    sessionTtlSeconds: 300,
  };
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function invocation(invocationId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 1,
    invocationId,
    target: "SendMessage",
    arguments: [payload],
  };
}

function encodeFrame(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}${SIGNALR_RECORD_SEPARATOR}`;
}

function decodeSignalRFrames(raw: RawData): unknown[] {
  return raw
    .toString("utf8")
    .split(SIGNALR_RECORD_SEPARATOR)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as unknown);
}

async function waitForVoxta(
  frames: unknown[],
  type: string,
  predicate: (payload: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return waitForFrame(frames, (frame) => {
    if (!isRecord(frame) || frame.type !== 1 || frame.target !== "ReceiveMessage") {
      return false;
    }
    const payload = Array.isArray(frame.arguments) ? frame.arguments[0] : undefined;
    return isRecord(payload) && payload.$type === type && predicate(payload);
  }).then((frame) => {
    const payload = (frame as { arguments: unknown[] }).arguments[0];
    assert.ok(isRecord(payload));
    return payload;
  });
}

async function waitForCompletion(frames: unknown[], invocationId: string): Promise<Record<string, unknown>> {
  return waitForFrame(frames, (frame) => (
    isRecord(frame) &&
    frame.type === 3 &&
    frame.invocationId === invocationId
  ));
}

async function waitForFrame(
  frames: unknown[],
  predicate: (frame: unknown) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (isRecord(frame)) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for SignalR frame. Received: ${JSON.stringify(frames)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
