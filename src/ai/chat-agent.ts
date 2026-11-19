/**
 * The chat's turn loop (DR-41): ask the model for one action, run it, tell the model what came of it, and again,
 * until it replies or proposes a change. A proposal pauses the turn until the user accepts or rejects it.
 */

import { describeError, logger } from "../debug/log";
import { parseStep } from "./chat-protocol";
import type { ChatTools, Proposal } from "./chat-tools";

const log = logger("chat");

/** Actions the model may take for one message before it has to reply. Each is a model call. */
export const MAX_STEPS = 8;
/** One model call. The first of a chat can take a while, as the model wakes up. */
export const STEP_TIMEOUT_MS = 60_000;

/** The part of a Prompt API session the chat uses. */
export interface StepSession {
  prompt(text: string, options: { responseConstraint: Record<string, unknown>; signal: AbortSignal }): Promise<string>;
}

export type ChatEvent =
  | { readonly kind: "say"; readonly text: string }
  /** What the model looked at, shown small, so the user can tell where an answer came from. */
  | { readonly kind: "activity"; readonly text: string }
  | { readonly kind: "proposal"; readonly proposal: Proposal; readonly note?: string }
  | { readonly kind: "failed"; readonly text: string };

/** `awaiting`: a proposal is waiting for the user. */
export type TurnEnd = "done" | "awaiting" | "failed" | "stopped";

export const GAVE_UP = "The assistant could not finish this. Try asking in another way.";
export const TOO_LONG = "This chat is too long for the model. Start a new chat.";
export const MODEL_FAILED = "The model stopped working. Try again, or start a new chat.";
export const TIMED_OUT = "The model took too long to answer. Try again, or start a new chat.";

export class ChatAgent {
  private waiting?: Proposal;

  constructor(
    private readonly session: StepSession,
    private readonly tools: ChatTools,
  ) {}

  /** The proposal waiting for the user, if any. */
  get pending(): Proposal | undefined {
    return this.waiting;
  }

  /**
   * A message from the user. Not while a proposal is waiting: the user decides it first. `context` goes just before the
   * user's words, where a small model is most likely to use it, such as the entry the chat is about.
   */
  send(text: string, signal: AbortSignal, onEvent: (event: ChatEvent) => void, context?: string): Promise<TurnEnd> {
    if (this.waiting) throw new Error("Decide the proposed change first.");
    return this.loop(context ? `${context}\nUser: ${text}` : `User: ${text}`, signal, onEvent);
  }

  /** The user decided the waiting proposal. `outcome` is what the model is told, and the turn carries on from there. */
  resume(outcome: string, signal: AbortSignal, onEvent: (event: ChatEvent) => void): Promise<TurnEnd> {
    if (!this.waiting) throw new Error("No change is waiting.");
    this.waiting = undefined;
    return this.loop(outcome, signal, onEvent);
  }

  private async loop(first: string, signal: AbortSignal, onEvent: (event: ChatEvent) => void): Promise<TurnEnd> {
    let prompt = first;
    let timeout: AbortSignal | undefined;
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        timeout = AbortSignal.timeout(STEP_TIMEOUT_MS);
        const raw = await this.session.prompt(prompt, { responseConstraint: this.tools.schema(), signal: AbortSignal.any([signal, timeout]) });
        const parsed = parseStep(raw);
        log.info("Chat model answered", { raw, ...(parsed.ok ? {} : { refused: parsed.reason }) });
        if (!parsed.ok) {
          prompt = `Error: ${parsed.reason} Answer with one action as JSON.`;
          continue;
        }
        const { step } = parsed;
        if (step.action === "reply") {
          onEvent({ kind: "say", text: step.text });
          return "done";
        }
        const outcome = await this.tools.run(step, signal);
        if (outcome.kind === "proposal") {
          this.waiting = outcome.proposal;
          onEvent({ kind: "proposal", proposal: outcome.proposal, ...(step.text ? { note: step.text } : {}) });
          return "awaiting";
        }
        if (outcome.kind === "result") {
          onEvent({ kind: "activity", text: outcome.activity });
          prompt = `Result of ${step.action}:\n${outcome.text}`;
        } else {
          log.info("Chat action refused", { action: step.action, reason: outcome.text });
          prompt = `Error from ${step.action}: ${outcome.text}`;
        }
      }
      onEvent({ kind: "failed", text: GAVE_UP });
      return "failed";
    } catch (e) {
      if (signal.aborted) return "stopped";
      log.warn("The chat model failed", describeError(e));
      const tooLong = e instanceof Error && e.name === "QuotaExceededError";
      onEvent({ kind: "failed", text: timeout?.aborted ? TIMED_OUT : tooLong ? TOO_LONG : errorText(e) });
      return "failed";
    }
  }
}

/** A failure the user can act on: a diary that could not be read says so, a model error says only that. */
function errorText(e: unknown): string {
  if (e instanceof Error && e.name === "DiaryReadError") return e.message;
  return MODEL_FAILED;
}

/** Thrown by a host whose diary could not be read, with the message to show. */
export class DiaryReadError extends Error {
  override name = "DiaryReadError";
}
