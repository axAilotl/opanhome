import http from "node:http";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { AsyncQueue } from "../shared/async-queue.js";
import type { HubConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type ClientToHubMessage,
  type HubToClientMessage,
} from "../shared/protocol.js";
import {
  appendEvent,
  appendPcm,
  createArtifactTurn,
  finalizeWav,
  writeJson,
  type ArtifactTurn,
} from "./artifacts.js";
import {
  DeepgramRealtimeSession,
  type TranscriptInterim,
  type TranscriptResult,
} from "./deepgram-live.js";
import { ElevenLabsStream } from "./elevenlabs-stream.js";
import { PsfnModelAdapter } from "./psfn-model.js";
import { SessionStore } from "./session-store.js";
import { sanitizeSpokenText, takeFlushChunk } from "../shared/text.js";

export class RealtimeHubServer {
  private readonly httpServer = http.createServer((_, response) => {
    response.statusCode = 200;
    response.end("opanhome-ts-hub\n");
  });

  private readonly wsServer = new WebSocketServer({ server: this.httpServer });
  private readonly sessions: SessionStore;
  private readonly agent: PsfnModelAdapter;
  private readonly tts: ElevenLabsStream;

  constructor(private readonly config: HubConfig) {
    this.sessions = new SessionStore(config.sessionTtlSeconds);
    this.agent = new PsfnModelAdapter(config.psfn);
    this.tts = new ElevenLabsStream(
      config.elevenlabsApiKey,
      config.elevenlabsModelId,
      config.elevenlabsVoiceId,
    );
  }

  async start(): Promise<void> {
    this.wsServer.on("connection", (socket) => {
      const connection = new RealtimeConnection(socket, this.config, this.sessions, this.agent, this.tts);
      connection.run().catch((error) => {
        console.error("Realtime connection failed:", error);
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.bindHost, () => resolve());
    });
  }

  async close(): Promise<void> {
    await this.tts.close();
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

class RealtimeConnection {
  private deviceId = `client-${Math.random().toString(16).slice(2, 10)}`;
  private deviceName = "Opanhome TS Client";
  private sessionId = `realtime:${this.deviceId}`;
  private activeTurn: ArtifactTurn | null = null;
  private sttSession: DeepgramRealtimeSession | null = null;
  private replyAbort = false;
  private replySequence = 0;
  private replyTask: Promise<void> | null = null;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: WebSocket,
    private readonly config: HubConfig,
    private readonly sessions: SessionStore,
    private readonly agent: PsfnModelAdapter,
    private readonly tts: ElevenLabsStream,
  ) {}

  async run(): Promise<void> {
    this.socket.on("message", (raw) => {
      const json = decodeRawData(raw);
      if (!json) {
        return;
      }
      const payload = JSON.parse(json) as ClientToHubMessage;
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(payload))
        .catch((error) => {
          console.error("Realtime message handling failed:", error);
        });
    });
    this.socket.on("close", () => {
      void this.cleanup();
    });

    this.sttSession = new DeepgramRealtimeSession(this.config.deepgramApiKey, 16000, {
      onInterim: (event) => {
        this.messageChain = this.messageChain
          .then(() => this.handleInterim(event))
          .catch((error) => {
            console.error("Realtime interim handling failed:", error);
          });
      },
      onUtterance: (event) => {
        this.messageChain = this.messageChain
          .then(() => this.handleUtterance(event))
          .catch((error) => {
            console.error("Realtime utterance handling failed:", error);
          });
      },
      onError: (error) => {
        console.error("Deepgram realtime session failed:", error);
      },
    });
    await this.sttSession.start();

    console.log("Realtime client connected");
    await this.send({
      type: "session.ready",
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      audioFormat: "pcm_s16le_16000_mono_in/mp3_44100_out",
    });
  }

  private async handleMessage(message: ClientToHubMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        this.deviceId = message.deviceId;
        this.deviceName = message.deviceName;
        this.sessionId = message.sessionId?.trim() || `realtime:${this.deviceId}`;
        this.sessions.touch(this.sessionId);
        console.log(`hello device=${this.deviceId} session=${this.sessionId}`);
        await this.send({
          type: "hello.ack",
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
        });
        await this.send({
          type: "status",
          data: "call_initialized",
        });
        return;
      case "ping":
        await this.send({ type: "pong", sentAt: message.sentAt });
        return;
      case "interrupt":
        await this.cancelReply("client_interrupt");
        await this.send({ type: "assistant.interrupted", sessionId: this.sessionId });
        return;
      case "text":
        await this.handleTextSignal(message.data);
        return;
      case "audio":
        await this.handleAudio(decodeAudioChunk(message.audio));
        return;
      case "turn.start":
      case "turn.end":
        return;
      default:
        await this.send({
          type: "error-event",
          data: { message: `Unsupported message type: ${String((message as { type?: string }).type || "")}` },
        });
    }
  }

  private async handleTextSignal(signal: string): Promise<void> {
    if (signal === "interrupt-event") {
      await this.cancelReply("client_interrupt");
      return;
    }
    if (signal === "bot-speak-end") {
      if (this.activeTurn) {
        appendEvent(this.activeTurn, "client.bot_speak_end", {});
      }
      return;
    }
    if (signal === "bot-speaking") {
      if (this.activeTurn) {
        appendEvent(this.activeTurn, "client.bot_speaking", {});
      }
      return;
    }
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (!this.sttSession || chunk.length === 0) {
      return;
    }
    if (this.replyTask && !this.replyAbort) {
      return;
    }
    const turn = this.ensureActiveTurn();
    appendPcm(turn, chunk);
    this.sttSession.sendAudio(chunk);
  }

  private async handleInterim(event: TranscriptInterim): Promise<void> {
    if (!event.text.trim()) {
      return;
    }
    const turn = this.ensureActiveTurn();
    appendEvent(turn, "transcript.live", event);
    await this.send({
      type: "message",
      data: {
        role: "user",
        content: event.text,
        live: true,
      },
    });
  }

  private async handleUtterance(event: TranscriptResult): Promise<void> {
    const turn = this.activeTurn ?? this.ensureActiveTurn();
    this.activeTurn = null;

    finalizeWav(turn);
    appendEvent(turn, "stop", {
      bytesReceived: turn.bytesReceived,
      chunks: turn.chunks,
    });
    appendEvent(turn, "transcript", event);
    writeJson(turn.transcriptPath, event);
    console.log(`transcript turn=${turn.turnId} latency_ms=${event.latencyMs} text=${JSON.stringify(event.text)}`);

    if (!event.text.trim()) {
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        status: "no_input",
      });
      return;
    }

    await this.send({
      type: "message",
      data: {
        role: "user",
        content: event.text,
        final: true,
      },
    });

    if (this.replyTask && !this.replyAbort) {
      appendEvent(turn, "ignored", { reason: "reply_in_progress" });
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        transcript: event.text,
        status: "ignored_reply_in_progress",
      });
      return;
    }

    this.sessions.append(this.sessionId, { role: "user", content: event.text });
    const task = this.runReply(turn, event.text);
    this.replyTask = task;
    await task.finally(() => {
      if (this.replyTask === task) {
        this.replyTask = null;
      }
    });
  }

  private async runReply(turn: ArtifactTurn, transcript: string): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    let responseText = "";
    const audioSegmentQueue = new AsyncQueue<string>();

    const audioTask = (async () => {
      for await (const segmentText of audioSegmentQueue) {
        if (this.replyAbort || replyId !== this.replySequence) {
          break;
        }
        const spokenSegmentText = sanitizeSpokenText(segmentText);
        if (!spokenSegmentText) {
          continue;
        }
        await this.send({
          type: "text",
          data: "audio-init",
        });
        let emittedAudio = false;
        for await (const audioChunk of this.tts.streamText(singleValueStream(spokenSegmentText))) {
          if (this.replyAbort || replyId !== this.replySequence) {
            break;
          }
          emittedAudio = true;
          await this.send({
            type: "audio",
            data: encodeAudioChunk(audioChunk),
          });
        }
        if (emittedAudio && !this.replyAbort && replyId === this.replySequence) {
          await this.send({
            type: "text",
            data: "audio-end",
          });
        }
      }
    })();

    try {
      let pendingAudioText = "";
      let audioHasStarted = false;
      const stream = this.agent.streamReply({
        userText: transcript,
        conversationId: this.sessionId,
        history: this.sessions.getHistory(this.sessionId),
      });
      for await (const delta of stream) {
        if (this.replyAbort || replyId !== this.replySequence) {
          break;
        }
        responseText += delta;
        pendingAudioText += delta;
        await this.send({
          type: "message",
          data: {
            role: "assistant",
            content: delta,
            live: true,
          },
        });
        while (true) {
          const { flushText, remainder } = takeFlushChunk(pendingAudioText, {
            hasStarted: audioHasStarted,
          });
          pendingAudioText = remainder;
          if (!flushText) {
            break;
          }
          audioSegmentQueue.push(flushText);
          audioHasStarted = true;
        }
      }
      if (pendingAudioText.trim()) {
        audioSegmentQueue.push(pendingAudioText.trim());
      }
      audioSegmentQueue.close();
      await audioTask;

      if (this.replyAbort || replyId !== this.replySequence) {
        appendEvent(turn, "reply.cancel", { reason: "client_interrupt" });
        return;
      }

      responseText = responseText.trim();
      this.sessions.append(this.sessionId, { role: "assistant", content: responseText });
      appendEvent(turn, "reply", { text: responseText });
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        transcript,
        response: responseText,
      });
      console.log(`reply turn=${turn.turnId} text=${JSON.stringify(responseText)}`);
      await this.send({
        type: "message",
        data: {
          role: "assistant",
          content: responseText,
          final: true,
        },
      });
    } catch (error) {
      audioSegmentQueue.close();
      await audioTask.catch(() => undefined);
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        transcript,
        error: String(error),
      });
      await this.send({
        type: "error-event",
        data: {
          message: String(error),
        },
      });
    }
  }

  private async cancelReply(reason: string): Promise<void> {
    this.replyAbort = true;
    this.replySequence += 1;
    if (this.activeTurn) {
      appendEvent(this.activeTurn, "reply.cancel", { reason });
    }
  }

  private ensureActiveTurn(): ArtifactTurn {
    if (this.activeTurn) {
      return this.activeTurn;
    }
    const turn = createArtifactTurn(this.config.artifactsRoot, this.sessionId);
    appendEvent(turn, "start", {
      sessionId: this.sessionId,
      turnId: turn.turnId,
    });
    this.activeTurn = turn;
    return turn;
  }

  private async cleanup(): Promise<void> {
    await this.cancelReply("connection_closed");
    this.activeTurn = null;
    if (this.sttSession) {
      await this.sttSession.close();
      this.sttSession = null;
    }
  }

  private async send(message: HubToClientMessage): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
}

async function* singleValueStream(text: string): AsyncGenerator<string, void, void> {
  yield text;
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
