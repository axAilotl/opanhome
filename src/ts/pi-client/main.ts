import { loadPiClientConfig, resolveProjectRoot } from "../shared/env.js";
import { PiRealtimeClient } from "./client.js";
import { MicControlServer } from "./mic-control-server.js";

async function main(): Promise<void> {
  const config = loadPiClientConfig(resolveProjectRoot());
  const client = new PiRealtimeClient(config);
  if (config.control) {
    const controlServer = new MicControlServer(config.control, client);
    await controlServer.start();
    console.log(
      `TS Pi client mic control listening on http://${config.control.bindHost}:${String(config.control.port)}/mic`,
    );
  }
  client.start();
  console.log(`TS Pi client connecting to ${config.hubUrl}`);
}

void main().catch((error) => {
  console.error("TS Pi client failed to start:", error);
  process.exit(1);
});
