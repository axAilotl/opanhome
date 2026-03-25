import WebSocket, { type RawData } from "ws";

import type { PiClientConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type HubToClientMessage,
} from "../shared/protocol.js";
import { AlsaVolumeController } from "./alsa-volume.js";
import { StreamingAudioPlayer } from "./audio-player.js";
import { AudioCapture, type AudioChunk } from "./audio-capture.js";

export class PiRealtimeClient {
  private ws: WebSocket | null = null;
  private readonly player: StreamingAudioPlayer;
  private readonly capture: AudioCapture;
  private readonly ducking: AlsaVolumeController | null;
  private ready = false;
  private playbackActive = false;
  private sentenceCompleted = false;
  private requireNewAudioInit = true;
  private botSpeakEndSent = false;
  private userSpeaking = false;
  private lastVoiceActivityAt = 0;
  private interruptingUntil = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: PiClientConfig) {
    this.player = new StreamingAudioPlayer(config.outputCommand);
    this.capture = new AudioCapture(config.inputCommand, config.micGain);
    this.ducking = config.ducking ? new AlsaVolumeController(config.ducking) : null;

    this.player.on("closed", ({ graceful }) => {
      this.playbackActive = false;
      void this.ducking?.restore();
      if (graceful && this.sentenceCompleted && !this.botSpeakEndSent) {
        this.botSpeakEndSent = true;
        this.send({
          type: "text",
          data: "bot-speak-end",
        });
      }
      this.requireNewAudioInit = true;
      this.sentenceCompleted = false;
      console.log(`playback.closed graceful=${String(graceful)}`);
    });

    this.capture.on("audio", (chunk) => {
      void this.handleChunk(chunk);
    });
    this.capture.on("close", () => {
      setTimeout(() => this.capture.start(), 1000);
    });
    this.capture.on("error", (error) => {
      console.error("Audio capture failed:", error);
    });
  }

  start(): void {
    this.capture.start();
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(this.config.hubUrl);
    this.ws.on("open", () => {
      this.resetConversationState();
      this.send({
        type: "hello",
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
      });
      console.log("Connected to hub:", this.config.hubUrl);
    });
    this.ws.on("message", (raw) => {
      const json = decodeRawData(raw);
      if (!json) {
        return;
      }
      const message = JSON.parse(json) as HubToClientMessage;
      void this.handleMessage(message);
    });
    this.ws.on("close", () => {
      this.player.stop();
      void this.ducking?.restore();
      this.resetConversationState();
      console.error("Hub connection closed");
      this.scheduleReconnect();
    });
    this.ws.on("error", (error) => {
      console.error("Hub websocket error:", error);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  private async handleMessage(message: HubToClientMessage): Promise<void> {
    switch (message.type) {
      case "session.ready":
      case "hello.ack":
      case "pong":
        return;
      case "status":
        if (message.data === "call_initialized") {
          this.ready = true;
          console.log("call_initialized");
        }
        return;
      case "text":
        await this.handleTextSignal(message.data);
        return;
      case "audio":
        if (this.requireNewAudioInit || !message.data) {
          return;
        }
        this.player.write(decodeAudioChunk(message.data));
        return;
      case "action":
        if (message.data === "interrupt") {
          await this.detectInterrupt();
        }
        return;
      case "message":
        if (message.data.final && message.data.role === "assistant") {
          console.log(`assistant.final ${JSON.stringify(message.data.content)}`);
        }
        return;
      case "assistant.interrupted":
        await this.detectInterrupt();
        return;
      case "error-event":
        console.error("Hub error:", message.data.message);
        return;
      default:
        return;
    }
  }

  private async handleTextSignal(signal: string): Promise<void> {
    if (signal === "audio-init") {
      this.requireNewAudioInit = false;
      this.sentenceCompleted = false;
      this.botSpeakEndSent = false;
      this.playbackActive = true;
      this.player.start();
      await this.ducking?.restore();
      this.send({
        type: "text",
        data: "bot-speaking",
      });
      console.log("audio-init");
      return;
    }
    if (signal === "audio-end") {
      this.sentenceCompleted = true;
      this.player.finish();
      console.log("audio-end");
    }
  }

  private async handleChunk(chunk: AudioChunk): Promise<void> {
    if (!this.ready) {
      return;
    }

    const now = Date.now();
    const speech = chunk.rms > this.config.startThreshold;
    if (speech) {
      this.userSpeaking = true;
      this.lastVoiceActivityAt = now;
    } else if (this.userSpeaking && (now - this.lastVoiceActivityAt) >= this.config.releaseMs) {
      this.userSpeaking = false;
    }

    if (this.playbackActive && speech && now >= this.interruptingUntil) {
      await this.ducking?.duck();
      await this.detectInterrupt();
    }

    this.send({
      type: "audio",
      audio: encodeAudioChunk(chunk.pcm),
    });
  }

  private async detectInterrupt(): Promise<void> {
    if (!this.playbackActive || Date.now() < this.interruptingUntil) {
      return;
    }
    this.interruptingUntil = Date.now() + 500;
    this.requireNewAudioInit = true;
    this.sentenceCompleted = false;
    this.botSpeakEndSent = true;
    this.playbackActive = false;
    this.send({
      type: "text",
      data: "interrupt-event",
    });
    this.player.stop();
    await this.ducking?.restore();
    this.send({
      type: "text",
      data: "bot-speak-end",
    });
    console.log("interrupt-event");
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private resetConversationState(): void {
    this.ready = false;
    this.playbackActive = false;
    this.sentenceCompleted = false;
    this.requireNewAudioInit = true;
    this.botSpeakEndSent = false;
    this.userSpeaking = false;
    this.lastVoiceActivityAt = 0;
    this.interruptingUntil = 0;
  }
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
