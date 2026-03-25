import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export interface PlayerClosedEvent {
  graceful: boolean;
}

export class StreamingAudioPlayer extends EventEmitter<{
  closed: [PlayerClosedEvent];
}> {
  private process: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private finishing = false;

  constructor(private readonly command: string[]) {
    super();
  }

  start(): void {
    this.stop();
    this.finishing = false;
    const [bin, ...args] = this.command;
    this.process = spawn(bin as string, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.process.stderr.on("data", (raw: Buffer) => {
      const message = raw.toString("utf8").trim();
      if (message) {
        console.error(`[player] ${message}`);
      }
    });
    this.process.on("close", () => {
      const graceful = this.finishing;
      this.process = null;
      this.finishing = false;
      this.emit("closed", { graceful });
    });
  }

  write(chunk: Buffer): void {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }
    this.process.stdin.write(chunk);
  }

  finish(): void {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }
    this.finishing = true;
    this.process.stdin.end();
  }

  stop(): void {
    if (!this.process) {
      return;
    }
    this.finishing = false;
    this.process.kill("SIGKILL");
  }
}
