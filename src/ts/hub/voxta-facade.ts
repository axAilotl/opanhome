import crypto from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { VoxtaFacadeConfig } from "../shared/env.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import {
  EmbodiedSessionRegistry,
  VOXTA_VAM_CAPABILITIES,
} from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";
import { SessionStore } from "./session-store.js";

const SIGNALR_RECORD_SEPARATOR = "\x1e";

interface VoxtaFacadeDependencies {
  config: VoxtaFacadeConfig;
  sessions: SessionStore;
  embodiedSessions: EmbodiedSessionRegistry;
  agent: AgentRuntimeAdapter;
}

interface PendingConnection {
  connectionId: string;
  connectionToken: string;
  createdAt: number;
}

interface SignalRInvocation {
  type: number;
  target?: string;
  invocationId?: string;
  arguments?: unknown[];
}

type VoxtaClientPayload = Record<string, unknown> & {
  $type?: string;
  sessionId?: string;
  chatId?: string;
  characterId?: string;
  text?: string;
  value?: string;
};

type VoxtaServerPayload = Record<string, unknown> & {
  $type: string;
};

interface VoxtaParticipant {
  id: string;
  name: string;
  role: "Assistant" | "User";
}

export class VoxtaFacade {
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly pendingConnections = new Map<string, PendingConnection>();

  constructor(private readonly deps: VoxtaFacadeDependencies) {
    this.wsServer.on("connection", (socket, request) => {
      const url = new URL(request.url || "/hub", "http://localhost");
      const connectionToken = url.searchParams.get("id") || crypto.randomUUID();
      const pending = this.pendingConnections.get(connectionToken);
      this.pendingConnections.delete(connectionToken);
      const connection = new VoxtaConnection(
        socket,
        this.deps,
        pending?.connectionId ?? crypto.randomUUID(),
      );
      connection.run();
    });
  }

  handleHttp(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const url = new URL(request.url || "/", "http://localhost");
    if (isCorsPreflight(request, url.pathname)) {
      writeCorsHeaders(response);
      response.statusCode = 204;
      response.end();
      return true;
    }
    if (!isNegotiatePath(url.pathname)) {
      return false;
    }
    writeCorsHeaders(response);
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      writeJson(response, 405, { error: "Voxta negotiation requires POST" });
      return true;
    }

    const connectionId = crypto.randomUUID();
    const connectionToken = crypto.randomUUID();
    this.pendingConnections.set(connectionToken, {
      connectionId,
      connectionToken,
      createdAt: Date.now(),
    });
    this.prunePendingConnections();
    writeJson(response, 200, {
      negotiateVersion: 1,
      connectionId,
      connectionToken,
      availableTransports: [
        {
          transport: "WebSockets",
          transferFormats: ["Text"],
        },
      ],
    });
    return true;
  }

  shouldHandleUpgrade(request: http.IncomingMessage): boolean {
    if (!this.deps.config.enabled) {
      return false;
    }
    const url = new URL(request.url || "/", "http://localhost");
    return isHubPath(url.pathname);
  }

  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
      this.wsServer.emit("connection", websocket, request);
    });
  }

  async close(): Promise<void> {
    for (const client of this.wsServer.clients) {
      client.close();
    }
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private prunePendingConnections(): void {
    const expiresBefore = Date.now() - 60_000;
    for (const [token, pending] of this.pendingConnections) {
      if (pending.createdAt < expiresBefore) {
        this.pendingConnections.delete(token);
      }
    }
  }
}

class VoxtaConnection {
  private readonly assistant: VoxtaParticipant;
  private readonly user: VoxtaParticipant;
  private readonly actionAllowlist: Set<string>;
  private messageChain: Promise<void> = Promise.resolve();
  private sessionId: string;
  private chatId: string;
  private replyAbort = false;
  private replySequence = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: VoxtaFacadeDependencies,
    connectionId: string,
  ) {
    this.sessionId = `voxta:${connectionId}`;
    this.chatId = `chat:${connectionId}`;
    this.assistant = {
      id: deps.config.assistantId,
      name: deps.config.assistantName,
      role: "Assistant",
    };
    this.user = {
      id: deps.config.userId,
      name: deps.config.userName,
      role: "User",
    };
    this.actionAllowlist = new Set(deps.config.actionAllowlist);
    this.attachSatellite();
  }

  run(): void {
    this.socket.on("message", (raw) => {
      for (const frame of decodeSignalRFrames(raw)) {
        this.messageChain = this.messageChain
          .then(() => this.handleFrame(frame))
          .catch((error) => {
            console.error("Voxta message handling failed:", error);
            void this.sendReceive({
              $type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }
    });
    this.socket.on("close", () => {
      this.cancelReply();
    });
  }

  private async handleFrame(frame: unknown): Promise<void> {
    if (!isRecord(frame)) {
      return;
    }
    if (isSignalRHandshake(frame)) {
      await this.sendFrame({});
      return;
    }
    if (frame.type === 6) {
      return;
    }
    if (frame.type !== 1) {
      return;
    }

    const invocation = frame as unknown as SignalRInvocation;
    if (invocation.target !== "SendMessage") {
      await this.sendCompletion(invocation.invocationId, `Unsupported SignalR target: ${invocation.target || ""}`);
      return;
    }

    const payload = invocation.arguments?.[0];
    if (!isRecord(payload)) {
      await this.sendCompletion(invocation.invocationId, "SendMessage requires a payload argument");
      return;
    }

    const clientPayload = payload as VoxtaClientPayload;
    const type = typeof clientPayload.$type === "string" ? clientPayload.$type : "";
    switch (type) {
      case "authenticate":
        await this.handleAuthenticate(invocation.invocationId);
        return;
      case "registerApp":
        await this.handleRegisterApp(invocation.invocationId, clientPayload);
        return;
      case "loadCharactersList":
        await this.sendReceive({
          $type: "charactersListLoaded",
          characters: [this.characterSummary()],
        });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "loadScenariosList":
        await this.sendReceive({ $type: "scenariosListLoaded", scenarios: [] });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "loadChatsList":
        await this.sendReceive({
          $type: "chatsListLoaded",
          chats: [this.chatSummary()],
        });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "startChat":
        await this.handleStartChat(invocation.invocationId, clientPayload);
        return;
      case "resumeChat":
        await this.handleResumeChat(invocation.invocationId, clientPayload);
        return;
      case "subscribeToChat":
        await this.sendCompletion(invocation.invocationId);
        return;
      case "send":
        await this.handleSend(invocation.invocationId, clientPayload);
        return;
      case "interrupt":
        await this.handleInterrupt(invocation.invocationId, clientPayload);
        return;
      case "speechPlaybackStart":
      case "speechPlaybackComplete":
      case "typingStart":
      case "typingEnd":
      case "pauseChat":
      case "inspect":
      case "inspectAudioInput":
        await this.sendCompletion(invocation.invocationId);
        return;
      case "updateContext":
        await this.handleUpdateContext(invocation.invocationId, clientPayload);
        return;
      case "triggerAction":
        await this.handleTriggerAction(invocation.invocationId, clientPayload);
        return;
      default:
        await this.sendCompletion(invocation.invocationId, `Unsupported Voxta message type: ${type}`);
    }
  }

  private async handleAuthenticate(invocationId?: string): Promise<void> {
    await this.sendReceive({
      $type: "welcome",
      assistant: this.characterSummary(),
      user: this.userSummary(),
      capabilities: {
        audioInput: "None",
        audioOutput: "Url",
        visionCapture: "PostImage",
        visionSources: ["Screen", "Eyes", "Attachment"],
      },
    });
    await this.sendReceive({
      $type: "configuration",
      configurations: [
        {
          serviceName: "PSFN Satellite Hub",
          serviceType: "TextGen",
          ready: true,
        },
      ],
    });
    await this.sendCompletion(invocationId);
  }

  private async handleRegisterApp(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const label = typeof payload.label === "string" ? payload.label : this.deps.config.appLabel;
    await this.sendReceive({
      $type: "moduleRuntimeInstances",
      instances: [
        {
          id: this.deps.config.satelliteId,
          label,
          clientVersion: this.deps.config.clientVersion,
          capabilities: VOXTA_VAM_CAPABILITIES,
        },
      ],
    });
    await this.sendCompletion(invocationId);
  }

  private async handleStartChat(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    this.sessionId = `voxta:${crypto.randomUUID()}`;
    this.chatId = `chat:${crypto.randomUUID()}`;
    this.attachSatellite();
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private async handleResumeChat(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const chatId = normalizedString(payload.chatId);
    if (chatId) {
      this.chatId = chatId;
      this.sessionId = `voxta:${chatId}`;
      this.attachSatellite();
    }
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private async handleSend(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const text = normalizedString(payload.text);
    if (!text) {
      await this.sendCompletion(invocationId, "Voxta send text is empty");
      return;
    }
    const sessionId = normalizedString(payload.sessionId) ?? this.sessionId;
    this.sessionId = sessionId;
    this.attachSatellite();

    await this.sendReceive({
      $type: "message",
      messageId: crypto.randomUUID(),
      senderId: this.user.id,
      senderName: this.user.name,
      senderType: "User",
      role: this.user.role,
      text,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    });

    this.deps.sessions.append(this.sessionId, { role: "user", content: text });
    const replyTask = this.streamAssistantReply(text);
    await replyTask;
    await this.sendCompletion(invocationId);
  }

  private async handleInterrupt(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const sessionId = normalizedString(payload.sessionId) ?? this.sessionId;
    this.cancelReply();
    await this.sendReceive({
      $type: "interruptSpeech",
      sessionId,
    });
    await this.sendReceive({
      $type: "replyCancelled",
      sessionId,
      messageId: crypto.randomUUID(),
    });
    await this.sendCompletion(invocationId);
  }

  private async handleUpdateContext(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    await this.sendReceive({
      $type: "contextUpdated",
      sessionId: normalizedString(payload.sessionId) ?? this.sessionId,
      contextKey: normalizedString(payload.contextKey) ?? "voxta-context",
    });
    await this.sendCompletion(invocationId);
  }

  private async handleTriggerAction(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const action = normalizedString(payload.value);
    if (!action) {
      await this.sendCompletion(invocationId, "triggerAction value is required");
      return;
    }
    if (!this.actionAllowlist.has(action)) {
      await this.sendCompletion(invocationId, `Voxta appTrigger is not allowlisted: ${action}`);
      return;
    }
    await this.sendReceive({
      $type: "appTrigger",
      value: action,
      arguments: payload.arguments ?? {},
      role: this.assistant.role,
      senderId: this.assistant.id,
      sessionId: normalizedString(payload.sessionId) ?? this.sessionId,
    });
    await this.sendCompletion(invocationId);
  }

  private async streamAssistantReply(userText: string): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    const messageId = crypto.randomUUID();
    let responseText = "";

    await this.sendReceive({
      $type: "chatFlow",
      state: "Thinking",
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "replyGenerating",
      sessionId: this.sessionId,
      messageId,
    });
    await this.sendReceive({
      $type: "replyStart",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
      senderName: this.assistant.name,
      role: this.assistant.role,
      timestamp: new Date().toISOString(),
    });

    const stream = this.deps.agent.streamReply({
      userText,
      conversationId: this.sessionId,
      history: this.deps.sessions.getHistory(this.sessionId) as ConversationMessage[],
      channel: this.deps.embodiedSessions.getContext(this.sessionId, this.deps.config.satelliteId),
    });
    for await (const delta of stream) {
      if (this.replyAbort || replyId !== this.replySequence) {
        await this.sendReceive({
          $type: "replyCancelled",
          sessionId: this.sessionId,
          messageId,
        });
        return;
      }
      responseText += delta;
      await this.sendReceive({
        $type: "replyChunk",
        sessionId: this.sessionId,
        messageId,
        senderId: this.assistant.id,
        role: this.assistant.role,
        text: delta,
        timestamp: new Date().toISOString(),
      });
    }

    responseText = responseText.trim();
    this.deps.sessions.append(this.sessionId, { role: "assistant", content: responseText });
    await this.sendReceive({
      $type: "message",
      messageId,
      senderId: this.assistant.id,
      senderName: this.assistant.name,
      senderType: "Assistant",
      role: this.assistant.role,
      text: responseText,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "replyEnd",
      sessionId: this.sessionId,
      messageId,
    });
    await this.sendReceive({
      $type: "chatFlow",
      state: "WaitingForUser",
      sessionId: this.sessionId,
    });
  }

  private async emitChatStarted(characterId?: string): Promise<void> {
    await this.sendReceive({
      $type: "chatStarting",
      chatId: this.chatId,
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "chatStarted",
      chatId: this.chatId,
      sessionId: this.sessionId,
      characterId: normalizedString(characterId) ?? this.assistant.id,
      participants: [this.characterSummary(), this.userSummary()],
    });
    await this.sendReceive({
      $type: "chatsSessionsUpdated",
      sessions: [this.chatSummary()],
    });
    await this.sendReceive({
      $type: "chatParticipantsUpdated",
      sessionId: this.sessionId,
      participants: [this.characterSummary(), this.userSummary()],
    });
    await this.sendReceive({
      $type: "chatFlow",
      state: "WaitingForUser",
      sessionId: this.sessionId,
    });
  }

  private async sendReceive(payload: VoxtaServerPayload): Promise<void> {
    await this.sendFrame({
      type: 1,
      target: "ReceiveMessage",
      arguments: [payload],
    });
  }

  private async sendCompletion(invocationId?: string, error?: string): Promise<void> {
    if (!invocationId) {
      return;
    }
    await this.sendFrame({
      type: 3,
      invocationId,
      ...(error ? { error } : { result: null }),
    });
  }

  private async sendFrame(payload: Record<string, unknown>): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(`${JSON.stringify(payload)}${SIGNALR_RECORD_SEPARATOR}`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private attachSatellite(): void {
    this.deps.embodiedSessions.attachSatellite({
      sessionId: this.sessionId,
      satelliteId: this.deps.config.satelliteId,
      satelliteName: this.deps.config.satelliteName,
      capabilities: VOXTA_VAM_CAPABILITIES,
    });
  }

  private cancelReply(): void {
    this.replyAbort = true;
    this.replySequence += 1;
  }

  private characterSummary(): Record<string, unknown> {
    return {
      id: this.assistant.id,
      name: this.assistant.name,
      role: this.assistant.role,
      isPrimary: true,
    };
  }

  private userSummary(): Record<string, unknown> {
    return {
      id: this.user.id,
      name: this.user.name,
      role: this.user.role,
    };
  }

  private chatSummary(): Record<string, unknown> {
    return {
      chatId: this.chatId,
      sessionId: this.sessionId,
      title: this.assistant.name,
      characterId: this.assistant.id,
      participants: [this.characterSummary(), this.userSummary()],
      updatedAt: new Date().toISOString(),
    };
  }
}

function isNegotiatePath(pathname: string): boolean {
  return pathname === "/hub/negotiate" || pathname === "/voxta/hub/negotiate";
}

function isHubPath(pathname: string): boolean {
  return pathname === "/hub" || pathname === "/voxta/hub";
}

function isCorsPreflight(request: http.IncomingMessage, pathname: string): boolean {
  return request.method === "OPTIONS" && (isNegotiatePath(pathname) || isHubPath(pathname));
}

function writeCorsHeaders(response: http.ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function decodeSignalRFrames(raw: RawData): unknown[] {
  const text = decodeRawData(raw);
  if (!text) {
    return [];
  }
  return text
    .split(SIGNALR_RECORD_SEPARATOR)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as unknown);
}

function decodeRawData(raw: RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((item) => Buffer.isBuffer(item) ? item : Buffer.from(item))).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as Uint8Array;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
  }
  return null;
}

function isSignalRHandshake(frame: Record<string, unknown>): boolean {
  return frame.protocol === "json" && frame.version === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}
