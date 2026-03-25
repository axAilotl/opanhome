import http from "node:http";

import type { PiClientControlConfig } from "../shared/env.js";
import { PiRealtimeClient } from "./client.js";

export class MicControlServer {
  private readonly httpServer = http.createServer((request, response) => {
    void this.handleRequest(request, response);
  });

  constructor(
    private readonly config: PiClientControlConfig,
    private readonly client: PiRealtimeClient,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, this.config.bindHost, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/mic") {
      this.respondJson(response, 404, { error: "Not found." });
      return;
    }

    if (request.method === "GET") {
      this.respondJson(response, 200, { muted: this.client.isMicMuted() });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", ["GET", "POST"]);
      this.respondJson(response, 405, { error: `Method ${request.method} Not Allowed` });
      return;
    }

    try {
      const payload = await readJsonBody(request);
      if (typeof payload?.muted !== "boolean") {
        this.respondJson(response, 400, { error: "Boolean muted value is required." });
        return;
      }

      this.client.setMicMuted(payload.muted);
      this.respondJson(response, 200, { muted: this.client.isMicMuted() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondJson(response, 400, { error: message });
    }
  }

  private respondJson(
    response: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
  ): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const payload = JSON.parse(raw) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Mic control payload must be a JSON object.");
  }
  return payload;
}
