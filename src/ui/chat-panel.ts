/**
 * The chat on the right of the page (DR-40). It talks to Chrome's on-device model, which reads the diary and searches
 * foods through the app, and proposes logs, changes and deletes that wait for the user to accept them.
 *
 * Opened from the header, it is a plain chat. Opened from a diary row, it starts a new chat about that entry.
 */

import type { AiState } from "../ai/amount-ai";
import { ChatAgent, type ChatEvent, type TurnEnd } from "../ai/chat-agent";
import type { ChatModel, ChatSession } from "../ai/chat-model";
import { chatInstructions, clockTime } from "../ai/chat-protocol";
import { createChatTools, outcomeText, type ChatHost, type ChatTools, type Proposal } from "../ai/chat-tools";
import { dayLabel } from "../core/time";
import { describeError, logger } from "../debug/log";
import { entryDay, mealLabel, type DiaryEntry } from "../health/mapping";
import { createProposalCard, type ProposalCard } from "./chat-proposal";
import { el } from "./dom";

const log = logger("chat");

export interface ApplyResult {
  readonly ok: boolean;
  /** What was done, or why it failed, in words for the user and the model. */
  readonly message: string;
}

export interface ChatPanelHost extends ChatHost {
  /** Writes an accepted proposal to the diary. Never rejects. */
  apply(proposal: Proposal): Promise<ApplyResult>;
}

/** Whether the AI setting allows the model, and the way to hear when that changes (amountAi). */
export interface AiSwitch {
  getState(): AiState;
  onChange(listener: () => void): void;
}

export interface ChatPanel {
  /** The panel, for the page body. Hidden while closed. */
  readonly element: HTMLElement;
  /** Opens and closes the panel, for the page header. Hidden where the model can't run. */
  readonly toggle: HTMLElement;
  readonly isOpen: boolean;
  /** Whether the chat can be used now: the AI setting is on and the model ready. */
  readonly available: boolean;
  /** Opens the panel. With an entry, starts a new chat about it. */
  open(focus?: DiaryEntry): void;
  close(): void;
  /** Ends the chat and forgets it, as on signing out. */
  reset(): void;
}

interface Conversation {
  readonly focus?: DiaryEntry;
  readonly tools: ChatTools;
  /** Ends everything this chat started. */
  readonly controller: AbortController;
  session?: Promise<ChatSession>;
  agent?: ChatAgent;
}

const INTRO = "Ask about your diary, or ask to log, change or delete an entry. Changes wait for you to accept them. The model runs on this computer.";
const FOCUS_INTRO = "Ask about this entry, or ask to change or delete it.";

function unavailableText(state: AiState): string {
  switch (state.kind) {
    case "unsupported":
      return "The chat needs the model built into Chrome, which this browser or computer can't run.";
    case "downloading":
      return `The model is downloading (${Math.round(state.progress * 100)}%). The chat starts when it is ready.`;
    case "failed":
      return "The model could not start. Tick “Use AI processing of input” at the top of the page to try again.";
    default:
      return "Tick “Use AI processing of input” at the top of the page to use the chat.";
  }
}

/** One line naming an entry the way the diary shows it. */
export function entryLine(e: DiaryEntry, today: string): string {
  const meal = e.mealType === "MEAL_TYPE_UNSPECIFIED" ? "no meal" : mealLabel(e.mealType);
  return [e.displayName, e.amount, meal, `${dayLabel(entryDay(e), today)}, ${clockTime(e.start)}`].filter(Boolean).join(" · ");
}

export function createChatPanel(model: ChatModel, ai: AiSwitch, host: ChatPanelHost): ChatPanel {
  let conversation: Conversation | undefined;
  /** The model call under way, which Stop ends. */
  let running: AbortController | undefined;
  let open = false;

  const messages = el("div", { class: "chat-log", role: "log", "aria-live": "polite" });
  const about = el("p", { class: "chat-about", hidden: true });
  const notice = el("p", { class: "chat-unavailable", hidden: true });
  const input = el("textarea", { class: "chat-input", rows: 3, placeholder: "Message", "aria-label": "Message to the assistant" });
  const send = el("button", { type: "submit", class: "primary" }, "Send");
  const stop = el("button", { type: "button", hidden: true, onclick: () => running?.abort() }, "Stop");
  const status = el("p", { class: "chat-status", role: "status" });
  const form = el("form", { class: "chat-form" }, input, el("div", { class: "actions" }, send, stop), status);
  const newChat = el("button", { type: "button", class: "link", onclick: () => startOver() }, "New chat");
  const closeButton = el("button", { type: "button", class: "icon", "aria-label": "Close the chat", title: "Close the chat", onclick: () => close() }, "✕");
  const element = el(
    "aside",
    { class: "chat-panel", "aria-label": "Chat", hidden: true },
    el("div", { class: "chat-head" }, el("h2", {}, "Chat"), newChat, closeButton),
    about,
    notice,
    messages,
    form,
  );
  const toggle = el("button", { type: "button", class: "chat-toggle", "aria-expanded": "false", onclick: () => (open ? close() : show()) }, "Chat");

  const available = () => ai.getState().kind === "ready";

  const scroll = () => {
    messages.scrollTop = messages.scrollHeight;
  };

  const add = (node: HTMLElement) => {
    messages.append(node);
    scroll();
  };

  /** Shows what the chat can do, and whether it can be used. */
  const refresh = () => {
    const state = ai.getState();
    toggle.hidden = state.kind === "unsupported";
    notice.hidden = available();
    notice.textContent = available() ? "" : unavailableText(state);
    const waiting = Boolean(conversation?.agent?.pending);
    input.disabled = !available() || waiting;
    send.disabled = !available() || waiting || Boolean(running);
    send.hidden = Boolean(running);
    stop.hidden = !running;
    if (!running) status.textContent = waiting ? "Accept or reject the change above to carry on." : "";
    newChat.hidden = !conversation;
  };

  const intro = (focus?: DiaryEntry) => {
    messages.replaceChildren(el("p", { class: "msg-note" }, focus ? FOCUS_INTRO : INTRO));
    about.hidden = !focus;
    about.textContent = focus ? `About: ${entryLine(focus, host.today())}` : "";
  };

  const end = (c: Conversation | undefined) => {
    if (!c) return;
    c.controller.abort();
    c.session?.then(
      (s) => s.destroy(),
      () => {},
    );
  };

  const begin = (focus?: DiaryEntry): Conversation => {
    end(conversation);
    running = undefined;
    const tools = createChatTools(host);
    // The entry the chat is about is E1, and the model is told about it before anything else.
    if (focus) tools.handles.entryHandle(focus);
    conversation = { ...(focus ? { focus } : {}), tools, controller: new AbortController() };
    intro(focus);
    refresh();
    return conversation;
  };

  /** The model session, started on the first message of a chat. */
  const agentFor = async (c: Conversation, signal: AbortSignal): Promise<ChatAgent> => {
    if (c.agent) return c.agent;
    if (!c.session) {
      const focusHandle = c.focus ? c.tools.handles.entryHandle(c.focus) : undefined;
      const prompts = chatInstructions({
        today: host.today(),
        viewed: host.viewedDay(),
        energyUnit: host.energyUnit(),
        ...(c.focus && focusHandle ? { focus: { handle: focusHandle, entry: c.focus } } : {}),
      });
      c.session = model.open(prompts, c.controller.signal);
      // A failed start must not be kept, or the chat could never start again.
      c.session.catch(() => {
        if (conversation === c) c.session = undefined;
      });
    }
    const session = await until(c.session, signal);
    c.agent ??= new ChatAgent(session, c.tools);
    return c.agent;
  };

  /** Shows what the model did. Events from a chat that has since ended are dropped. */
  const onEvent = (c: Conversation) => (event: ChatEvent) => {
    if (conversation !== c) return;
    switch (event.kind) {
      case "say":
        add(el("div", { class: "msg msg-assistant" }, event.text));
        break;
      case "activity":
        add(el("p", { class: "msg-activity" }, event.text));
        break;
      case "failed":
        add(el("p", { class: "msg-error", role: "alert" }, event.text));
        break;
      case "proposal": {
        if (event.note) add(el("div", { class: "msg msg-assistant" }, event.note));
        const card: ProposalCard = createProposalCard(event.proposal, host.today(), (accept) => void decide(c, card, event.proposal, accept));
        card.set({ kind: "waiting" });
        add(card.element);
        card.element.querySelector<HTMLButtonElement>("button.primary")?.focus();
        break;
      }
    }
  };

  /** Runs one model turn, with Stop and the status line around it. */
  const turn = async (c: Conversation, run: (agent: ChatAgent, signal: AbortSignal) => Promise<TurnEnd>) => {
    const controller = (running = new AbortController());
    const signal = AbortSignal.any([controller.signal, c.controller.signal]);
    refresh();
    status.textContent = c.agent ? "Thinking…" : "Starting the model…";
    let ended: TurnEnd | "no-model" = "no-model";
    try {
      const agent = await agentFor(c, signal);
      status.textContent = "Thinking…";
      ended = await run(agent, signal);
    } catch (e) {
      if (!signal.aborted) {
        log.warn("The chat model could not start", describeError(e));
        onEvent(c)({ kind: "failed", text: "The model could not start. Try again in a moment." });
      }
    }
    if (running === controller) running = undefined;
    if (conversation !== c) return;
    if (ended === "stopped" || (ended === "no-model" && signal.aborted)) add(el("p", { class: "msg-note" }, "Stopped."));
    refresh();
    if (!c.agent?.pending) input.focus();
  };

  const submit = (text: string) => {
    if (!available() || running) return;
    const c = conversation ?? begin();
    if (c.agent?.pending) return;
    add(el("div", { class: "msg msg-user" }, text));
    input.value = "";
    void turn(c, (agent, signal) => agent.send(text, signal, onEvent(c)));
  };

  const decide = async (c: Conversation, card: ProposalCard, proposal: Proposal, accept: boolean) => {
    if (conversation !== c || c.agent?.pending !== proposal) return;
    let outcome: string;
    if (accept) {
      card.set({ kind: "applying" });
      const result = await host.apply(proposal);
      card.set(result.ok ? { kind: "done", text: result.message } : { kind: "failed", text: result.message });
      outcome = outcomeText(proposal, { accepted: true, ...result }, host.today());
    } else {
      card.set({ kind: "rejected" });
      outcome = outcomeText(proposal, { accepted: false }, host.today());
    }
    log.info("Chat change decided", { kind: proposal.kind, accepted: accept });
    // The chat may have been ended while the diary was written: the write stands, but there is no one to tell.
    if (conversation !== c) return;
    void turn(c, (agent, signal) => agent.resume(outcome, signal, onEvent(c)));
  };

  const show = () => {
    open = true;
    element.hidden = false;
    document.body.classList.add("chat-open");
    toggle.setAttribute("aria-expanded", "true");
    if (!conversation) intro();
    refresh();
    input.focus();
  };

  const close = () => {
    open = false;
    element.hidden = true;
    document.body.classList.remove("chat-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  };

  const startOver = () => {
    begin();
    input.focus();
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (text) submit(text);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  element.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && running) running.abort();
  });

  // The model must not be used once the setting is off (DR-26), so turning it off ends the chat.
  let wasAvailable = available();
  ai.onChange(() => {
    const now = available();
    if (wasAvailable && !now && conversation) {
      end(conversation);
      conversation = undefined;
      running = undefined;
      intro();
    }
    wasAvailable = now;
    refresh();
  });
  intro();
  refresh();

  return {
    element,
    toggle,
    get isOpen() {
      return open;
    },
    get available() {
      return available();
    },
    open(focus) {
      if (focus) begin(focus);
      show();
    },
    close,
    reset() {
      end(conversation);
      conversation = undefined;
      running = undefined;
      intro();
      refresh();
      if (open) close();
    },
  };
}

/** Waits for `promise`, but no longer than `signal` allows. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}
