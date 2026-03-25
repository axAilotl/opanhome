import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";

export interface HermesRuntimeConfig {
  hermesHome: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
}

export interface PsfnRuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface HubConfig {
  bindHost: string;
  port: number;
  deepgramApiKey: string;
  elevenlabsApiKey: string;
  elevenlabsVoiceId: string;
  elevenlabsModelId: string;
  artifactsRoot: string;
  psfn: PsfnRuntimeConfig;
  sessionTtlSeconds: number;
}

export interface PiClientConfig {
  hubUrl: string;
  deviceId: string;
  deviceName: string;
  conversationId?: string;
  inputCommand: string[];
  outputCommand: string[];
  sampleRate: number;
  startThreshold: number;
  continueThreshold: number;
  ambientStartRatio: number;
  interruptRatio: number;
  startChunks: number;
  releaseMs: number;
  initialSilenceMs: number;
  endSilenceMs: number;
  maxTurnMs: number;
  prerollChunks: number;
  prerollLeadChunks: number;
  micGain: number;
  ducking: {
    mixerCard: string;
    mixerControl: string;
    duckPercent: number;
  } | null;
}

export function resolveProjectRoot(): string {
  return process.cwd();
}

export function loadProjectEnv(projectRoot: string): void {
  const projectEnv = path.join(projectRoot, ".env");
  if (fs.existsSync(projectEnv)) {
    dotenv.config({ path: projectEnv, override: false });
  }
}

export function loadPsfnRuntime(_projectRoot: string): PsfnRuntimeConfig {
  const baseUrl = required("PSFN_API_BASE_URL");
  const model = process.env.PSFN_MODEL?.trim() || "psfn";
  const apiKey = process.env.PSFN_API_KEY?.trim() || undefined;
  return {
    model,
    baseUrl,
    apiKey,
  };
}

export function loadHubConfig(projectRoot: string): HubConfig {
  loadProjectEnv(projectRoot);
  const psfn = loadPsfnRuntime(projectRoot);

  return {
    bindHost: process.env.REALTIME_VOICE_BIND_HOST || "0.0.0.0",
    port: Number.parseInt(process.env.REALTIME_VOICE_PORT || "8787", 10),
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    elevenlabsApiKey: required("ELEVENLABS_API_KEY"),
    elevenlabsVoiceId: required("ELEVENLABS_VOICE_ID"),
    elevenlabsModelId: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
    artifactsRoot: resolvePath(projectRoot, process.env.ARTIFACT_ROOT || ".artifacts/runtime-ts"),
    psfn,
    sessionTtlSeconds: Number.parseInt(process.env.SESSION_TTL_SECONDS || "300", 10),
  };
}

export function loadPiClientConfig(projectRoot: string): PiClientConfig {
  loadProjectEnv(projectRoot);
  const sampleRate = Number.parseInt(process.env.MIC_SAMPLE_RATE || "16000", 10);
  const audioCard = process.env.AUDIO_DEVICE_CARD?.trim() || "";
  const inputDevice =
    process.env.AUDIO_INPUT_DEVICE?.trim() ||
    (audioCard ? `plughw:CARD=${audioCard},DEV=0` : "default");
  const outputDevice =
    process.env.AUDIO_OUTPUT_DEVICE?.trim() ||
    (audioCard ? `default:CARD=${audioCard}` : "default");
  const duckCard = process.env.ALSA_DUCK_CARD?.trim() || audioCard;
  const duckControl = process.env.ALSA_DUCK_CONTROL?.trim() || "PCM";

  return {
    hubUrl: process.env.HUB_WS_URL || "ws://192.168.1.220:8787/",
    deviceId: process.env.DEVICE_ID || os.hostname(),
    deviceName: process.env.DEVICE_NAME || `Opanhome TS Client (${os.hostname()})`,
    conversationId: optional("CONVERSATION_ID"),
    inputCommand: splitCommand(
      process.env.AUDIO_INPUT_COMMAND ||
        `arecord -q -f S16_LE -r ${sampleRate} -c 1 -D ${inputDevice} -t raw`,
    ),
    outputCommand: splitCommand(
      process.env.AUDIO_OUTPUT_COMMAND ||
        `bash -lc "ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -i pipe:0 -f s16le -acodec pcm_s16le -ar 44100 -ac 2 pipe:1 | aplay -q -D ${outputDevice} -f S16_LE -r 44100 -c 2"`,
    ),
    sampleRate,
    startThreshold: Number.parseFloat(process.env.VOICE_START_THRESHOLD || "0.008"),
    continueThreshold: Number.parseFloat(process.env.VOICE_CONTINUE_THRESHOLD || "0.004"),
    ambientStartRatio: Number.parseFloat(process.env.VOICE_AMBIENT_START_RATIO || "1.5"),
    interruptRatio: Number.parseFloat(process.env.VOICE_INTERRUPT_RATIO || "1.0"),
    startChunks: Number.parseInt(process.env.VOICE_START_CHUNKS || "1", 10),
    releaseMs: Number.parseInt(process.env.VOICE_SPEECH_RELEASE_MS || "180", 10),
    initialSilenceMs: Number.parseInt(process.env.VOICE_INITIAL_SILENCE_MS || "1800", 10),
    endSilenceMs: Number.parseInt(process.env.VOICE_END_SILENCE_MS || "420", 10),
    maxTurnMs: Number.parseInt(process.env.VOICE_MAX_TURN_MS || "20000", 10),
    prerollChunks: Number.parseInt(process.env.VOICE_PREROLL_CHUNKS || "24", 10),
    prerollLeadChunks: Number.parseInt(process.env.VOICE_PREROLL_LEAD_CHUNKS || "4", 10),
    micGain: Number.parseFloat(process.env.MIC_GAIN || "1.0"),
    ducking: duckCard
      ? {
          mixerCard: duckCard,
          mixerControl: duckControl,
          duckPercent: Number.parseInt(process.env.ALSA_DUCK_PERCENT || "8", 10),
        }
      : null,
  };
}

function resolvePath(projectRoot: string, value: string): string {
  const expanded = value.startsWith("~")
    ? path.join(os.homedir(), value.slice(1))
    : value;
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.join(projectRoot, expanded);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"(.*)"$/, "$1"));
}
