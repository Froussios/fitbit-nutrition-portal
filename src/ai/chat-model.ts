/**
 * Sessions of Chrome's built-in model for the chat (DR-40). The chat uses the model only while the AI setting is on
 * and the model is ready (DR-26): the same setting, the same model, its own sessions.
 */

import type { StepSession } from "./chat-agent";

type Role = "system" | "user" | "assistant";

export interface ChatSession extends StepSession {
  destroy(): void;
}

/** The parts of the Prompt API the chat uses. */
export interface ChatModelApi {
  create(options: unknown): Promise<ChatSession>;
}

export interface ChatModel {
  /** Starts a chat with these instructions. Rejects if the model can't start. */
  open(initialPrompts: readonly { readonly role: Role; readonly content: string }[], signal: AbortSignal): Promise<ChatSession>;
}

const ENGLISH = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

export function createChatModel(api: ChatModelApi | undefined): ChatModel {
  return {
    open(initialPrompts, signal) {
      if (!api) return Promise.reject(new Error("This browser has no built-in model."));
      return api.create({ ...ENGLISH, initialPrompts, signal });
    },
  };
}

/** The one model this page uses. */
export const chatModel: ChatModel = createChatModel((globalThis as { LanguageModel?: ChatModelApi }).LanguageModel);
