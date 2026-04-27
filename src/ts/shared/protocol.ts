export type ClientToHubMessage =
  | HelloMessage
  | AudioMessage
  | UserTextMessage
  | TextSignalMessage
  | PingMessage
  | InterruptMessage
  | RelaySttRequestMessage
  | RelayTtsRequestMessage
  | TurnStartMessage
  | TurnEndMessage;

export type HubToClientMessage =
  | SessionReadyMessage
  | HelloAckMessage
  | StatusMessage
  | TextMessage
  | AudioOutMessage
  | MessageEvent
  | ActionMessage
  | ErrorEventMessage
  | RelaySttResultMessage
  | RelayTtsChunkMessage
  | RelayTtsDoneMessage
  | RelayRequestErrorMessage
  | PongMessage
  | AssistantInterruptedCompatMessage;

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  deviceName: string;
  sessionId?: string;
  channelId?: string;
  satelliteId?: string;
  satelliteName?: string;
  capabilities?: SatelliteCapabilities;
}

export interface AudioMessage {
  type: "audio";
  audio: string;
}

export interface UserTextMessage {
  type: "user.text";
  text: string;
  interrupt?: boolean;
}

export interface TextSignalMessage {
  type: "text";
  data: string;
}

export interface PingMessage {
  type: "ping";
  sentAt: number;
}

export interface InterruptMessage {
  type: "interrupt";
}

export interface RelaySttRequestMessage {
  type: "relay.stt";
  requestId: string;
  audio: string;
  mimeType?: string;
  prompt?: string;
  language?: string;
}

export interface RelayTtsRequestMessage {
  type: "relay.tts";
  requestId: string;
  text: string;
  voice?: string;
  model?: string;
}

export interface TurnStartMessage {
  type: "turn.start";
  interrupt?: boolean;
}

export interface TurnEndMessage {
  type: "turn.end";
  reason: string;
}

export interface SessionReadyMessage {
  type: "session.ready";
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  audioFormat: string;
}

export interface HelloAckMessage {
  type: "hello.ack";
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  satelliteName: string;
  capabilities: SatelliteCapabilities;
}

export interface StatusMessage {
  type: "status";
  data: string;
}

export interface TextMessage {
  type: "text";
  data: string;
}

export interface AudioOutMessage {
  type: "audio";
  data: string;
}

export interface MessageEvent {
  type: "message";
  data: {
    role: "user" | "assistant";
    content: string;
    live?: boolean;
    final?: boolean;
  };
}

export interface ActionMessage {
  type: "action";
  data: "interrupt" | "pause-audio" | "play-audio";
}

export interface ErrorEventMessage {
  type: "error-event";
  data: {
    message: string;
  };
}

export interface RelaySttResultMessage {
  type: "relay.stt.result";
  requestId: string;
  text: string;
  provider: string;
  latencyMs?: number;
}

export interface RelayTtsChunkMessage {
  type: "relay.tts.chunk";
  requestId: string;
  audio: string;
}

export interface RelayTtsDoneMessage {
  type: "relay.tts.done";
  requestId: string;
  mimeType: string;
}

export interface RelayRequestErrorMessage {
  type: "relay.error";
  requestId: string;
  operation: "stt" | "tts";
  message: string;
}

export interface AssistantInterruptedCompatMessage {
  type: "assistant.interrupted";
  sessionId: string;
}

export interface PongMessage {
  type: "pong";
  sentAt: number;
}

export type SatelliteInputCapability =
  | "text"
  | "microphone_pcm"
  | "final_transcript"
  | "vision_upload"
  | "wake_event";

export type SatelliteOutputCapability =
  | "text"
  | "subtitle"
  | "streamed_audio"
  | "local_file_audio"
  | "animation"
  | "action"
  | "expression"
  | "gaze"
  | "servo";

export type SatelliteControlCapability =
  | "interrupt"
  | "mute"
  | "sleep_wake"
  | "presence"
  | "session_attach";

export type SatelliteSafetyCapability =
  | "action_allowlist"
  | "confirmation_required"
  | "local_only";

export interface SatelliteCapabilities {
  input?: SatelliteInputCapability[];
  output?: SatelliteOutputCapability[];
  control?: SatelliteControlCapability[];
  safety?: SatelliteSafetyCapability[];
}

export function encodeAudioChunk(chunk: Buffer): string {
  return chunk.toString("base64");
}

export function decodeAudioChunk(encoded: string): Buffer {
  return Buffer.from(encoded, "base64");
}
