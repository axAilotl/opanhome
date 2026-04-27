# Opanhome

Dual-path voice hub for PSFN.

This repo is the middleware layer between voice endpoints and PSFN. It now has two device paths:

- a custom TypeScript realtime websocket path for Pi-class devices that can do smooth bidirectional conversation
- an ESPHome Native API fallback path for stock ESPHome voice devices and `linux-voice-assistant`

The current testing target is direct PSFN deployment first. Treat this repo as a bridge into the PSFN OpenAI-compatible API, not as a scoped local brain.

## What This Repo Does

The hub in this repo does the heavy lifting:

- accepts either a custom realtime voice client or an ESPHome voice device
- streams microphone audio to Deepgram STT
- applies turn endpointing, interrupt, and timeout logic
- sends the current recognized text plus a stable conversation id into PSFN
- streams PSFN text back into ElevenLabs TTS
- returns assistant audio either as websocket chunks or ESPHome playback media
- stores turn artifacts, transcripts, and reply metadata locally

On the TypeScript realtime path, PSFN owns the actual conversation/session state. The hub keeps satellite/runtime transport state and relays the current turn.

Device behavior depends on the path:

- custom realtime client:
  local mic capture, local playback ownership, explicit interrupt, persistent websocket
- ESPHome fallback:
  wake word or button start, mic capture, speaker playback, ESPHome voice-assistant transport

No Home Assistant is in the runtime path.

## Current Architecture

```text
Pi-class realtime client
  -> continuous pcm audio over one websocket
  -> hub-side persistent Deepgram live session
  -> PSFN conversation runtime
  -> ElevenLabs streaming TTS
  <- audio-init / audio-end / audio chunks
  <- explicit interrupt-event / bot-speak-end handshake

ESPHome device / linux-voice-assistant / ESP32 fallback
  -> ESPHome Native API session in the Python hub
  -> Deepgram live STT websocket
  -> PSFN conversation runtime
  -> ElevenLabs streaming TTS websocket
  <- announcement/media playback over the ESPHome route
```

## Current Status

Implemented:

- TypeScript websocket hub for Pi-class clients
- TypeScript Pi client with continuous mic streaming, local playback ownership, and explicit interrupt
- explicit ALSA device routing and local playback ducking on Pi-class hardware
- persistent Deepgram websocket for STT on both paths
- persistent ElevenLabs websocket for streamed TTS on both paths
- PSFN-compatible conversation runtime driven from PSFN config/env
- reference-style handshake on the TS path:
  `audio-init`, `audio-end`, `bot-speaking`, `bot-speak-end`, `interrupt-event`
- server-side utterance boundaries on the TS path driven by Deepgram live results instead of client-side turn gating
- ESPHome fallback transport kept intact on the Python side
- `hub probe` for metadata, entities, services, and state subscription
- `hub transport-spike` for raw ESPHome transport capture and artifact logging
- local artifact capture under `.artifacts/runtime/` and `.artifacts/runtime-ts/`

Currently working:

- the TypeScript smoke harness succeeds end-to-end against the rebuilt realtime hub
- the Pi 5 client path is the primary path to extend first
- the ESPHome/Python path remains available as the fallback for stock devices

Current intent:

- make the voice loop feel fast and smooth enough for daily use
- target the direct PSFN deployment first so the end-to-end path is real
- keep Hermes available through its OpenAI-compatible API server when `AGENT_RUNTIME=hermes`
- keep the bridge thin so this can stay a sidecar first
- upstream only the smallest useful bridge seam later if it proves out

## Why The Hub Exists

PSFN is not talking directly to the satellite.

This repo is the orchestration layer that translates:

- custom realtime voice transport
- ESPHome voice transport
- realtime STT/TTS provider streams
- PSFN conversation execution

That split is deliberate. It keeps ESPHome transport concerns out of PSFN core until the interface is proven stable, while still letting the bridge use a direct PSFN deployment as the source of truth.

For the TypeScript realtime path, that means the hub should stay a transport/orchestration layer:

- satellite audio in
- turn control and interrupt handling
- current-turn text into PSFN
- streamed text/audio back out

Conversation memory and session continuity belong to PSFN, with the hub only maintaining transport-side continuity.

## Commands

Install Python dependencies for the ESPHome fallback path:

```bash
uv sync --dev
```

Install TypeScript dependencies for the realtime hub/client path:

```bash
npm install
```

Show Python fallback CLI help:

```bash
uv run hub --help
```

Probe a device:

```bash
uv run hub probe --host <device-ip> --noise-psk <base64-psk>
```

Capture raw voice transport artifacts:

```bash
uv run hub transport-spike --host <device-ip> --noise-psk <base64-psk>
```

Bootstrap against the PSFN bridge config and run the Python fallback bridge:

```bash
uv run hub run
```

Run the TypeScript realtime hub:

```bash
npm run hub:ts
```

The same TypeScript hub also exposes the initial Voxta-compatible facade:

- `POST /hub/negotiate?negotiateVersion=1`
- `WS /hub?id=<connectionToken>`
- SignalR JSON framing with `SendMessage` inbound and `ReceiveMessage` outbound

Run the TypeScript Pi client locally:

```bash
npm run pi:ts
```

Run the TypeScript smoke test against the realtime hub:

```bash
npm run smoke:ts
```

Send a typed turn through the PSFN channel seam with the text-only thin shell:

```bash
npm run shell:psfn -- "hello from the thin shell"
```

Apply the current `linux-voice-assistant` fork patch used for ESPHome fallback interrupt/follow-up behavior:

```bash
./scripts/apply-linux-voice-assistant-patch.sh /path/to/linux-voice-assistant
```

Deploy the dedicated TypeScript Pi realtime client and disable `linux-voice-assistant` on that Pi:

```bash
PI_USER=<pi-user> PI_PASSWORD='<pi-password>' HUB_WS_URL=ws://<hub-host>:8787/ DEVICE_ID=<device-id> DEVICE_NAME=<device-name> ./scripts/deploy-ts-pi-client.sh <pi-host>
```

## Configuration

Runtime config comes from the project-local `.env`.

Important settings for the TypeScript realtime path:

- `AGENT_RUNTIME`, either `psfn` or `hermes`; defaults to `psfn`
- `HUB_WS_URL`
- `AUDIO_DEVICE_CARD`
- `AUDIO_INPUT_DEVICE`
- `AUDIO_OUTPUT_DEVICE`
- `ALSA_DUCK_CARD`
- `ALSA_DUCK_CONTROL`
- `ALSA_DUCK_PERCENT`
- `VOICE_START_THRESHOLD`
- `VOICE_CONTINUE_THRESHOLD`
- `VOICE_AMBIENT_START_RATIO`
- `VOICE_INTERRUPT_RATIO`

Important settings for the Python ESPHome fallback path:

- `DEVICE_TRANSPORT`
- `ESPHOME_HOST`, `ESPHOME_PORT`, `ESPHOME_NOISE_PSK`
- `REALTIME_VOICE_BIND_HOST`, `REALTIME_VOICE_PORT`, `REALTIME_VOICE_PUBLIC_HOST`
- `DEEPGRAM_API_KEY`
- `ELEVENLABS_API_KEY`
- `PSFN_API_BASE_URL`
- `PSFN_API_KEY`
- `PSFN_MODEL`
- `PSFN_CHANNEL_TYPE` for the TypeScript hub channel header, defaulting to `psfn-satellite-hub`
- `HERMES_API_BASE_URL` or `HERMES_API_SERVER_URL` for `AGENT_RUNTIME=hermes`, defaulting to `http://127.0.0.1:8642/v1`
- `HERMES_API_KEY` or `API_SERVER_KEY` for Hermes API-server auth and stable `X-Hermes-Session-Id` continuation
- `HERMES_MODEL` for the advertised Hermes API-server model, defaulting to `hermes-agent`
- `HERMES_CHANNEL_TYPE` for the hub channel id prefix, defaulting to `hermes-agent`
- `VOXTA_FACADE_ENABLED` enables the Voxta-compatible SignalR facade on `/hub`, defaulting to `true`
- `VOXTA_SATELLITE_ID` and `VOXTA_SATELLITE_NAME` identify the VaM/Voxta satellite in PSFN channel metadata
- `VOXTA_ASSISTANT_NAME`, `VOXTA_USER_NAME`, and related ID vars shape the Voxta welcome/chat payloads
- `VOXTA_APP_TRIGGER_ALLOWLIST` is a comma-separated allowlist for Voxta `appTrigger` forwarding
- optional `PSFN_AUTHOR_ID` and `PSFN_AUTHOR_NAME` if you need the hub to assert a specific PSFN-side author
- `VOICE_REPLY_TIMEOUT_SECONDS`
- `VOICE_ENDPOINTING_GRACE_SECONDS`
- `VOICE_SILENCE_TIMEOUT_SECONDS`
- `VOICE_MAX_TURN_SECONDS`

Realtime-only mode must set either `AUDIO_PUBLIC_HOST` or `REALTIME_VOICE_PUBLIC_HOST`. The hub no longer probes an outbound address when ESPHome is not in use.

## Testing With PSFN

Set `PSFN_API_BASE_URL` and `PSFN_MODEL` in `.env`, then run:

```bash
uv run hub run
```

After that, fill in the remaining project-specific values in `.env`:

- ESPHome endpoint settings
- bridge-specific overrides if you do not want to inherit provider keys from `~/.hermes/.env`

At the moment there are no required Hermes source patches in this repo. The bridge is importing and using the existing global Hermes checkout in place.

On the TypeScript realtime path, conversation continuity is also stored on the Hermes side under that global install. The hub passes a stable conversation id through to Hermes and does not maintain its own authoritative agent history.

## Transport Paths

Top-tier path:

- custom TypeScript realtime websocket client for Pi-class devices
- one persistent connection
- continuous outbound mic audio instead of client-opened turns
- explicit `interrupt-event` / `bot-speak-end` semantics
- Deepgram-driven utterance boundaries on the hub
- streamed assistant text and audio back to the client
- local device-owned playback and ducking
- current Pi-class deployment uses this path and has `linux-voice-assistant` disabled

Fallback path:

- stock ESPHome voice devices
- `linux-voice-assistant`
- ESP32-class endpoints speaking the ESPHome voice protocol

The custom client protocol is documented in [docs/realtime-client-protocol.md](/mnt/samesung/ai/dev/opanhome/docs/realtime-client-protocol.md).

## ESPHome Fallback Notes

Natural follow-up and interrupt behavior on the ESPHome fallback path still depends on a patched `linux-voice-assistant` endpoint. The stock endpoint is good enough to expose the ESPHome voice transport, but it does not own interruption strongly enough for the behavior this bridge wants.

The current patch in [patches/linux-voice-assistant-followup-interrupt.patch](/mnt/samesung/ai/dev/opanhome/patches/linux-voice-assistant-followup-interrupt.patch) does three important things:

- adds speech-first barge-in detection knobs at the endpoint
- turns wake-word and stop-word interrupts into explicit local `stop output now, then reopen mic` behavior
- preserves follow-up conversation reopening after TTS instead of relying on fragile announce-state side effects

To apply it to a `linux-voice-assistant` checkout:

```bash
./scripts/apply-linux-voice-assistant-patch.sh /path/to/linux-voice-assistant
```

This is intentionally endpoint-local. Hermes itself still does not require a source patch for the current bridge path.

## Pi Realtime Client

The dedicated Pi-class TypeScript client lives under [src/ts/pi-client](/mnt/samesung/ai/dev/opanhome/src/ts/pi-client) with deploy assets under [client/ts_realtime](/mnt/samesung/ai/dev/opanhome/client/ts_realtime).

It is the preferred path for devices that can afford a custom client, because it owns:

- continuous local microphone capture
- immediate local playback stop on interrupt
- local playback state instead of inferred server-side playback state
- explicit ALSA device selection
- local playback ducking before interrupt
- direct websocket streaming back to the hub
- the same interaction pattern the working reference client used:
  stream audio continuously, stop playback locally first, then notify the hub

The hub then relays the finalized user turn into Hermes, keeps the websocket/audio pipeline moving, and leaves the actual conversation/session state inside Hermes.

Deploy with:

```bash
PI_PASSWORD='<pi-password>' ./scripts/deploy-ts-pi-client.sh <pi-host>
```

## Repository Layout

```text
src/ts/
  hub/
    main.ts
    server.ts
    deepgram-live.ts
    hermes-model.ts
    elevenlabs-stream.ts
  pi-client/
    main.ts
    client.ts
    audio-capture.ts
    audio-player.ts
    alsa-volume.ts
  shared/
    env.ts
    protocol.ts
hub/
  cli/
    probe.py
    run.py
  devices/
    esphome_session.py
    voice_runtime_streaming.py
client/ts_realtime/
scripts/
tests/
```

## Notes

- The current runtime path is global-Hermes-first, using Hermes-compatible config/env rather than a project-scoped Hermes install.
- The repo now supports both a custom TypeScript realtime client path and an ESPHome fallback path.
- The checked-in TypeScript path is the primary conversation path now.
- Historical `.agent/` scaffolding exists in this repo, but it is not the main deployment target right now.
- The Python fallback bridge still serves streamed audio on `AUDIO_SERVER_PORT` for announcement playback back to the device.
- Turn artifacts are intentionally kept for debugging transport, latency, and failure recovery.

## Upstream Plan

The likely upstream path is:

1. keep ESPHome support as a sidecar first
2. identify the smallest Hermes streaming seam worth upstreaming
3. only move toward core gateway integration after the transport feels solid

That keeps the current experiment useful without forcing a large Hermes core change too early.

## Future Plans

- further smooth streaming TTS chunking and playback pacing on the TypeScript path
- add better latency instrumentation around STT finalize, first Hermes token, first TTS audio, and playback start
- support fully local STT providers behind the same adapter interface
- support fully local TTS providers behind the same adapter interface
- keep the dedicated Pi client as the top-tier path while retaining ESPHome fallback compatibility
- harden the TS client interrupt path further with more real-device soak time
- make the hub usable with a fully local speech stack before worrying about a polished upstream story
- upstream the smallest Hermes-side streaming interface only after the bridge feels stable against the global deployment
