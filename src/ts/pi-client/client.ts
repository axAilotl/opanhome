import WebSocket from "ws";

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
  private readonly preroll: AudioChunk[] = [];
  private turnActive = false;
  private assistantActive = false;
  private assistantAudioActive = false;
  private playbackActive = false;
  private speechStarted = false;
  private userSpeaking = false;
  private turnStartedAt = 0;
  private lastSpeechAt = 0;
  private lastVoiceActivityAt = 0;
  private activationChunks = 0;
  private speechChunks = 0;
  private pendingSilence: AudioChunk[] = [];
  private ambientFloor = 0;
  private ambientSamples = 0;
  private playbackFloor = 0;
  private playbackSamples = 0;
  private interruptCandidateAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: PiClientConfig) {
    this.player = new StreamingAudioPlayer(config.outputCommand);
    this.capture = new AudioCapture(config.inputCommand, config.micGain);
    this.ducking = config.ducking ? new AlsaVolumeController(config.ducking) : null;
    this.player.on("closed", ({ graceful }) => {
      this.playbackActive = false;
      if (!this.turnActive) {
        void this.ducking?.restore();
      }
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
      if (!(typeof raw === "string" || raw instanceof Buffer)) {
        return;
      }
      const message = JSON.parse(String(raw)) as HubToClientMessage;
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
      case "turn.started":
      case "transcript.final":
        return;
      case "assistant.start":
        this.assistantActive = true;
        return;
      case "assistant.text":
        process.stdout.write(message.delta);
        return;
      case "assistant.audio.start":
        this.assistantActive = true;
        this.assistantAudioActive = true;
        this.playbackActive = true;
        this.resetPlaybackFloor();
        this.player.start();
        console.log("assistant.audio.start");
        return;
      case "assistant.audio.chunk":
        this.assistantAudioActive = true;
        this.player.write(decodeAudioChunk(message.audio));
        return;
      case "assistant.audio.end":
        this.assistantAudioActive = false;
        this.player.finish();
        console.log("assistant.audio.end");
        process.stdout.write("\n");
        return;
      case "assistant.end":
        this.assistantActive = false;
        console.log(`assistant.end text=${JSON.stringify(message.text)}`);
        return;
      case "assistant.interrupted":
        this.assistantActive = false;
        this.assistantAudioActive = false;
        this.playbackActive = false;
        this.player.stop();
        void this.ducking?.restore();
        return;
      case "turn.no_input":
        console.log(`turn.no_input reason=${message.reason}`);
        return;
      case "error":
        console.error("Hub error:", message.message);
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  private async handleChunk(chunk: AudioChunk): Promise<void> {
    this.preroll.push(chunk);
    if (this.preroll.length > this.config.prerollChunks) {
      this.preroll.shift();
    }

    this.updatePlaybackFloor(chunk.rms);
    this.updateAmbientFloor(chunk.rms);

    const now = Date.now();
    const interrupting = this.playbackActive || this.assistantActive || this.assistantAudioActive;
    const threshold = Math.max(this.config.startThreshold, this.ambientFloor * this.config.ambientStartRatio);
    const voiceHit = chunk.rms >= this.config.continueThreshold;
    const startHit = chunk.rms >= threshold;
    const wasUserSpeaking = this.userSpeaking;

    if (interrupting && !this.turnActive) {
      if (startHit || (this.userSpeaking && voiceHit)) {
        if (this.interruptCandidateAt === 0) {
          this.interruptCandidateAt = now;
          console.log(
            `interrupt.candidate rms=${chunk.rms.toFixed(4)} threshold=${threshold.toFixed(4)} playback=${this.playbackFloor.toFixed(4)}`,
          );
          void this.ducking?.duck();
        }
        this.userSpeaking = true;
        this.lastVoiceActivityAt = now;
      } else if (this.userSpeaking && (now - this.lastVoiceActivityAt) >= this.config.releaseMs) {
        this.userSpeaking = false;
      }

      if (
        this.interruptCandidateAt > 0 &&
        this.userSpeaking &&
        (now - this.interruptCandidateAt) >= Math.max(96, Math.floor(this.config.releaseMs / 2))
      ) {
        console.log(
          `speech.start rms=${chunk.rms.toFixed(4)} threshold=${threshold.toFixed(4)} interrupting=true`,
        );
        this.interruptCandidateAt = 0;
        await this.beginTurn(true);
        return;
      }

      if (
        this.interruptCandidateAt > 0 &&
        !this.userSpeaking &&
        (now - this.interruptCandidateAt) >= this.config.releaseMs
      ) {
        this.interruptCandidateAt = 0;
        void this.ducking?.restore();
      }
      return;
    }

    if (startHit || (this.userSpeaking && voiceHit)) {
      this.userSpeaking = true;
      this.lastVoiceActivityAt = now;
    } else if (this.userSpeaking && (now - this.lastVoiceActivityAt) >= this.config.releaseMs) {
      this.userSpeaking = false;
    }

    if (!this.turnActive) {
      if (startHit) {
        this.activationChunks += 1;
      } else {
        this.activationChunks = 0;
      }
      if (!wasUserSpeaking && this.userSpeaking && (this.activationChunks >= this.config.startChunks || interrupting)) {
        console.log(
          `speech.start rms=${chunk.rms.toFixed(4)} threshold=${threshold.toFixed(4)} interrupting=${String(interrupting)}`,
        );
        await this.beginTurn(interrupting);
        this.activationChunks = 0;
      }
      return;
    }

    if (this.userSpeaking && voiceHit) {
      if (this.pendingSilence.length > 0) {
        for (const pending of this.pendingSilence) {
          this.send({
            type: "audio",
            audio: encodeAudioChunk(pending.pcm),
          });
        }
        this.pendingSilence = [];
      }
      this.send({
        type: "audio",
        audio: encodeAudioChunk(chunk.pcm),
      });
      this.speechStarted = true;
      this.speechChunks += 1;
      this.lastSpeechAt = now;
    } else if (this.speechStarted) {
      this.pendingSilence.push(chunk);
    }

    if (!this.speechStarted) {
      if ((now - this.turnStartedAt) >= this.config.initialSilenceMs) {
        this.endTurn("initial_silence_timeout");
      }
      return;
    }

    if ((now - this.lastSpeechAt) >= this.config.endSilenceMs) {
      this.endTurn("vad_end");
      return;
    }

    if ((now - this.turnStartedAt) >= this.config.maxTurnMs) {
      this.endTurn("max_turn_timeout");
    }
  }

  private async beginTurn(interrupting: boolean): Promise<void> {
    if (this.turnActive) {
      return;
    }
    if (interrupting) {
      void this.ducking?.duck();
      this.player.stop();
      this.assistantActive = false;
      this.assistantAudioActive = false;
      this.playbackActive = false;
      this.resetPlaybackFloor();
      this.send({ type: "interrupt" });
    }

    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.lastSpeechAt = this.turnStartedAt;
    this.lastVoiceActivityAt = this.turnStartedAt;
    this.speechChunks = 0;
    this.speechStarted = false;
    this.pendingSilence = [];
    this.send({ type: "turn.start", interrupt: interrupting });

    const buffered = slicePreroll(this.preroll, this.config.continueThreshold, this.config.prerollLeadChunks);
    this.preroll.length = 0;
    for (const item of buffered) {
      this.send({
        type: "audio",
        audio: encodeAudioChunk(item.pcm),
      });
    }
    console.log(`turn.start buffered=${buffered.length} interrupting=${interrupting}`);
  }

  private endTurn(reason: string): void {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.speechChunks = 0;
    this.speechStarted = false;
    this.pendingSilence = [];
    this.userSpeaking = false;
    this.interruptCandidateAt = 0;
    this.lastVoiceActivityAt = 0;
    this.turnStartedAt = 0;
    this.lastSpeechAt = 0;
    this.send({ type: "turn.end", reason });
    console.log(`turn.end reason=${reason}`);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private updatePlaybackFloor(rms: number): void {
    if (!this.playbackActive || this.turnActive) {
      this.resetPlaybackFloor();
      return;
    }
    if (rms <= 0) {
      return;
    }
    if (this.playbackSamples === 0) {
      this.playbackFloor = rms;
      this.playbackSamples = 1;
      return;
    }
    if (this.playbackSamples < 12) {
      this.playbackFloor = Math.max(this.playbackFloor, rms);
      this.playbackSamples += 1;
      return;
    }
    if (rms < (this.playbackFloor * 0.85)) {
      this.playbackFloor = (this.playbackFloor * 0.98) + (rms * 0.02);
    }
  }

  private updateAmbientFloor(rms: number): void {
    if (this.turnActive || this.assistantAudioActive || this.playbackActive || rms <= 0) {
      return;
    }
    if (this.ambientSamples === 0) {
      this.ambientFloor = rms;
      this.ambientSamples = 1;
      return;
    }
    if (this.ambientSamples < 32) {
      this.ambientFloor =
        ((this.ambientFloor * this.ambientSamples) + rms) / (this.ambientSamples + 1);
      this.ambientSamples += 1;
      return;
    }
    this.ambientFloor = (this.ambientFloor * 0.98) + (rms * 0.02);
  }

  private resetPlaybackFloor(): void {
    this.playbackFloor = 0;
    this.playbackSamples = 0;
  }

  private resetConversationState(): void {
    this.turnActive = false;
    this.assistantActive = false;
    this.assistantAudioActive = false;
    this.playbackActive = false;
    this.speechStarted = false;
    this.userSpeaking = false;
    this.interruptCandidateAt = 0;
    this.turnStartedAt = 0;
    this.lastSpeechAt = 0;
    this.lastVoiceActivityAt = 0;
    this.activationChunks = 0;
    this.speechChunks = 0;
    this.pendingSilence = [];
    this.preroll.length = 0;
    this.ambientFloor = 0;
    this.ambientSamples = 0;
    this.resetPlaybackFloor();
  }
}

function slicePreroll(buffered: AudioChunk[], threshold: number, leadChunks: number): AudioChunk[] {
  const firstVoicedIndex = buffered.findIndex((item) => item.rms >= threshold);
  if (firstVoicedIndex < 0) {
    return [];
  }
  const startIndex = Math.max(0, firstVoicedIndex - leadChunks);
  return buffered.slice(startIndex);
}
