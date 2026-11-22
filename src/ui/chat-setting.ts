import type { AiState } from "../ai/amount-ai";
import { el } from "./dom";

const STORAGE_KEY = "foodDiary.chat";

const ABOUT = "Shows the chat beside the diary (DR-41). It is experimental and may be removed: the model built into Chrome is too small for it to work well. It also needs “Use AI processing of input”.";

export interface ChatSetting {
  /** The tickbox, for the settings panel. Kept for the life of the page. */
  readonly element: HTMLElement;
  /** Whether the user has asked for the chat, and it can run here. Off until they ask (DR-50). */
  isOn(): boolean;
  /** `listener` runs when the user ticks or unticks it. */
  onChange(listener: () => void): void;
}

function readStored(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * The tickbox that shows the chat (DR-50), kept on each device. Off by default. It is separate from the AI setting
 * (DR-26), which also reads amounts the rules refuse: that use stays whatever this one says. Where the model can't run
 * at all, it is disabled, as the AI setting is.
 */
export function createChatSetting(ai: { getState(): AiState; onChange(listener: () => void): void }, storage: Pick<Storage, "getItem" | "setItem"> | undefined): ChatSetting {
  let on = readStored(storage);
  const listeners: (() => void)[] = [];
  const box = el("input", {
    type: "checkbox",
    onchange: () => {
      on = box.checked;
      try {
        storage?.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        // Storage blocked: the choice lasts until the page is reloaded.
      }
      for (const listener of listeners) listener();
    },
  });
  box.checked = on;
  const label = el("label", { class: "ai-setting chat-setting", title: ABOUT }, box, "Show the chat (experimental)");

  const show = () => {
    const unsupported = ai.getState().kind === "unsupported";
    box.disabled = unsupported;
    label.title = unsupported ? "The chat needs the model built into Chrome, which this browser or computer can't run." : ABOUT;
  };
  ai.onChange(show);
  show();

  return {
    element: el("div", { class: "ai-control" }, label),
    // A choice saved where the model could run means nothing where it can't, as the disabled tickbox shows.
    isOn: () => on && ai.getState().kind !== "unsupported",
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
