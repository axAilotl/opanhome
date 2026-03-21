# Opanhome

ESPHome voice bridge for Hermes.

This repo is the middleware layer between an ESPHome-compatible voice endpoint and Hermes. Right now the main endpoint is a Pi running `linux-voice-assistant`, but the hub is built around the ESPHome Native API so the same path should work for ESP32-class voice devices that follow the same contract.

The current testing target is global Hermes deployment first. Treat this repo as a bridge into a normal `~/.hermes` install, not as a scoped Hermes environment.

## What This Repo Does

The hub in this repo does the heavy lifting:

- connects to an ESPHome voice device over the Native API
- streams microphone audio to Deepgram STT
- applies turn endpointing and timeout logic
- sends recognized text into Hermes
- streams Hermes text back into ElevenLabs TTS
- serves live audio back to the device for playback
- stores turn artifacts, transcripts, and reply metadata locally

The endpoint device stays relatively dumb:

- wake word or button start
- mic capture
- speaker playback
- ESPHome voice-assistant transport

No Home Assistant is in the runtime path.

## Current Architecture

```text
ESPHome voice device / linux-voice-assistant on Pi
  <-> aioesphomeapi client in this repo
      -> Deepgram live STT websocket
      -> Hermes conversation runtime
      -> ElevenLabs streaming TTS websocket
      -> local HTTP audio stream server
  <-> streamed announcement playback back to device
```

## Current Status

Implemented:

- `hub probe` for metadata, entities, services, and state subscription
- `hub transport-spike` for raw transport capture and artifact logging
- `hub run` for the end-to-end voice loop
- persistent Deepgram websocket for STT
- persistent ElevenLabs websocket for streamed TTS
- persistent Hermes worker process with gateway-backed session context
- silence timeout, max-turn timeout, and reply timeout handling
- local artifact capture under `.artifacts/runtime/`

Current intent:

- make the voice loop feel fast and smooth enough for daily use
- target the global Hermes deployment first so the end-to-end path is real
- keep Hermes integration minimal so this can stay a sidecar first
- upstream only the smallest useful Hermes seam later if it proves out

## Why The Hub Exists

Hermes is not talking directly to the satellite.

This repo is the orchestration layer that translates:

- ESPHome voice transport
- realtime STT/TTS provider streams
- Hermes conversation execution

That split is deliberate. It keeps ESPHome transport concerns out of Hermes core until the interface is proven stable, while still letting the bridge use the same global Hermes gateway/runtime configuration as a real deployment.

## Commands

Install dependencies:

```bash
uv sync --dev
```

Show CLI help:

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

Bootstrap against the global Hermes install and run the live bridge:

```bash
./scripts/use-global-hermes.sh
uv run hub run
```

## Configuration

Runtime config comes from:

- project-local `.env`
- global Hermes config under `~/.hermes`

Load order is:

- project `.env` is read first only for `HERMES_HOME` and `HERMES_GATEWAY_HOME` hints
- `~/.hermes/.env` is then loaded as the shared Hermes/provider baseline
- project `.env` is applied again last so bridge-specific overrides still win

Important settings:

- `ESPHOME_HOST`, `ESPHOME_PORT`, `ESPHOME_NOISE_PSK`
- `DEEPGRAM_API_KEY`
- `ELEVENLABS_API_KEY`
- `HERMES_AGENT_BACKEND`
- `HERMES_GATEWAY_HOME`
- `HERMES_HOME`
- `HERMES_MODEL`
- `VOICE_REPLY_TIMEOUT_SECONDS`
- `VOICE_ENDPOINTING_GRACE_SECONDS`
- `VOICE_SILENCE_TIMEOUT_SECONDS`
- `VOICE_MAX_TURN_SECONDS`

## Testing With Global Hermes

The bridge currently expects a normal global Hermes install at:

- `~/.hermes`
- `~/.hermes/hermes-agent`
- `~/.hermes/hermes-agent/venv/bin/python`

To prepare this repo for that path, run:

```bash
./scripts/use-global-hermes.sh
```

That script:

- verifies the global Hermes checkout and venv exist
- verifies the gateway/runtime imports the bridge depends on
- creates `.env` from `.env.example` if needed
- rewrites the local project env to point at `~/.hermes`
- leaves Hermes source untouched; there is no required Hermes patch in this repo right now

After that, fill in the remaining project-specific values in `.env`:

- ESPHome endpoint settings
- bridge-specific overrides if you do not want to inherit provider keys from `~/.hermes/.env`

At the moment there are no required Hermes source patches in this repo. The bridge is importing and using the existing global Hermes checkout in place.

## Repository Layout

```text
hub/
  cli/
    probe.py
    run.py
  devices/
    esphome_session.py
    voice_runtime_streaming.py
  adapters/
    interfaces.py
  media/
    http_audio.py
  runtime.py
  storage/
    session_cache.py
tests/
```

## Notes

- The current runtime path is global-Hermes-first, using gateway-backed session context rather than a project-scoped Hermes install.
- Historical `.agent/` scaffolding exists in this repo, but it is not the main deployment target right now.
- The bridge serves streamed audio on `AUDIO_SERVER_PORT` for announcement playback back to the device.
- Turn artifacts are intentionally kept for debugging transport, latency, and failure recovery.

## Upstream Plan

The likely upstream path is:

1. keep ESPHome support as a sidecar first
2. identify the smallest Hermes streaming seam worth upstreaming
3. only move toward core gateway integration after the transport feels solid

That keeps the current experiment useful without forcing a large Hermes core change too early.

## Future Plans

- smooth streaming TTS by buffering Hermes deltas into short phrase-sized chunks before each ElevenLabs flush
- add better latency instrumentation around STT finalize, first Hermes token, first TTS audio, and playback start
- support fully local STT providers behind the same adapter interface
- support fully local TTS providers behind the same adapter interface
- make the hub usable with a fully local speech stack before worrying about a polished upstream story
- upstream the smallest Hermes-side streaming interface only after the bridge feels stable against the global deployment
