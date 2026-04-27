import type { PsfnChannelContext } from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";

export interface AgentRuntimeAdapter {
  streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }): AsyncGenerator<string, string, void>;

  close(): Promise<void>;
}
