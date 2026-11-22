// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AiState } from "../src/ai/amount-ai";
import { createChatSetting } from "../src/ui/chat-setting";

function ai(kind: AiState["kind"]) {
  let state = { kind } as AiState;
  const listeners: (() => void)[] = [];
  return {
    getState: () => state,
    onChange: (l: () => void) => listeners.push(l),
    set(k: AiState["kind"]) {
      state = { kind: k } as AiState;
      for (const l of listeners) l();
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

const box = (element: HTMLElement) => element.querySelector("input")!;

/** Ticks or unticks the box as a click does: the browser flips it, then says it changed. */
function toggle(element: HTMLElement) {
  const input = box(element);
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change"));
}

describe("chat setting", () => {
  it("is off until the user ticks it, whether or not the AI setting is on", () => {
    const setting = createChatSetting(ai("ready"), memoryStorage());
    expect(setting.isOn()).toBe(false);
    expect(box(setting.element).checked).toBe(false);
  });

  it("remembers the choice on this device, and says when it changes", () => {
    const storage = memoryStorage();
    const setting = createChatSetting(ai("off"), storage);
    const listener = vi.fn();
    setting.onChange(listener);
    toggle(setting.element);
    expect(setting.isOn()).toBe(true);
    expect(storage.data.get("foodDiary.chat")).toBe("on");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createChatSetting(ai("off"), storage).isOn()).toBe(true);
  });

  it("is disabled where the model can't run", () => {
    const state = ai("ready");
    const setting = createChatSetting(state, memoryStorage());
    expect(box(setting.element).disabled).toBe(false);
    state.set("unsupported");
    expect(box(setting.element).disabled).toBe(true);
  });

  it("counts as off where the model can't run, even if it was saved as on", () => {
    const state = ai("ready");
    const setting = createChatSetting(state, memoryStorage({ "foodDiary.chat": "on" }));
    expect(setting.isOn()).toBe(true);
    state.set("unsupported");
    expect(setting.isOn()).toBe(false);
  });

  it("works without storage, for the page's life", () => {
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const setting = createChatSetting(ai("ready"), throwing);
    expect(setting.isOn()).toBe(false);
    toggle(setting.element);
    expect(setting.isOn()).toBe(true);
  });
});
