import crypto from "node:crypto";

import WebSocket from "ws";

import { AsyncQueue } from "../shared/async-queue.js";

export class ElevenLabsStream {
  private ws: WebSocket | null = null;
  private readonly contexts = new Map<string, AsyncQueue<Buffer>>();

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly voiceId: string,
  ) {}

  async *streamText(textStream: AsyncIterable<string>): AsyncGenerator<Buffer, void, void> {
    await this.ensureConnected();
    const contextId = `ctx-${crypto.randomUUID()}`;
    const queue = new AsyncQueue<Buffer>();
    this.contexts.set(contextId, queue);

    this.sendJson({
      context_id: contextId,
      text: " ",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.7,
        speed: 1.0,
      },
    });

    const sender = (async () => {
      for await (const delta of textStream) {
        const text = delta.trim();
        if (!text) {
          continue;
        }
        this.sendJson({
          context_id: contextId,
          text,
          flush: true,
        });
      }
      this.sendJson({
        context_id: contextId,
        close_context: true,
      });
    })();

    try {
      for await (const chunk of queue) {
        yield chunk;
      }
    } finally {
      await sender.catch(() => undefined);
      this.contexts.delete(contextId);
    }
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    for (const queue of this.contexts.values()) {
      queue.close();
    }
    this.contexts.clear();
    if (!ws) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    const uri =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input` +
      `?model_id=${encodeURIComponent(this.modelId)}` +
      "&output_format=mp3_44100_128" +
      "&inactivity_timeout=180" +
      "&auto_mode=true";
    this.ws = new WebSocket(uri, {
      headers: {
        "xi-api-key": this.apiKey,
      },
    });
    this.ws.on("message", (data) => this.handleMessage(String(data)));
    await new Promise<void>((resolve, reject) => {
      this.ws?.once("open", () => resolve());
      this.ws?.once("error", (error) => reject(error));
    });
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const contextId = String(payload.contextId || payload.context_id || "");
    if (!contextId) {
      return;
    }
    const queue = this.contexts.get(contextId);
    if (!queue) {
      return;
    }
    const audio = String(payload.audio || "");
    if (audio) {
      queue.push(Buffer.from(audio, "base64"));
    }
    if (payload.isFinal || payload.is_final) {
      queue.close();
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }
}
