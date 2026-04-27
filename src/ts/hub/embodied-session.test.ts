import assert from "node:assert/strict";
import test from "node:test";

import {
  canReceiveStreamingAudio,
  EmbodiedSessionRegistry,
  THIN_SHELL_CAPABILITIES,
} from "./embodied-session.js";

test("embodied session registry derives one stable PSFN hub channel", () => {
  const registry = new EmbodiedSessionRegistry("psfn-satellite-hub");

  const first = registry.attachSatellite({
    sessionId: "thin-shell:demo",
    satelliteId: "thin-shell",
    satelliteName: "Thin Shell",
    capabilities: THIN_SHELL_CAPABILITIES,
  });
  const second = registry.attachSatellite({
    sessionId: "thin-shell:demo",
    satelliteId: "pi-mic",
    satelliteName: "Pi Mic",
  });

  assert.equal(first.session.channelId, "psfn-satellite-hub:thin-shell:demo");
  assert.equal(second.session.channelId, first.session.channelId);
  assert.deepEqual(
    registry.getContext("thin-shell:demo", "thin-shell").activeSatellites.map((satellite) => satellite.id),
    ["thin-shell", "pi-mic"],
  );
});

test("thin shell capabilities are text-only for assistant output", () => {
  assert.equal(canReceiveStreamingAudio(THIN_SHELL_CAPABILITIES), false);
});
