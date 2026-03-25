export type ClientToHubMessage =
  | HelloMessage
  | AudioMessage
  | TextSignalMessage
  | PingMessage
  | InterruptMessage
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
  | PongMessage
  | AssistantInterruptedCompatMessage;

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  deviceName: string;
  sessionId?: string;
}

export interface AudioMessage {
  type: "audio";
  audio: string;
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
  deviceId: string;
  deviceName: string;
  audioFormat: string;
}

export interface HelloAckMessage {
  type: "hello.ack";
  sessionId: string;
  deviceId: string;
  deviceName: string;
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

export interface AssistantInterruptedCompatMessage {
  type: "assistant.interrupted";
  sessionId: string;
}

export interface PongMessage {
  type: "pong";
  sentAt: number;
}

export function encodeAudioChunk(chunk: Buffer): string {
  return chunk.toString("base64");
}

export function decodeAudioChunk(encoded: string): Buffer {
  return Buffer.from(encoded, "base64");
}
