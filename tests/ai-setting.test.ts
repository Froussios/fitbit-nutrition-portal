// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AiState, AmountAi } from "../src/ai/amount-ai";
import { createAiSetting } from "../src/ui/ai-setting";

function fakeAi(start: AiState) {
  let state = start;
  const listeners: (() => void)[] = [];
  const ai: AmountAi = {
    start: async () => {},
    getState: () => state,
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    onChange: (l) => void listeners.push(l),
    isOn: () => state.kind === "ready",
    interpret: async () => undefined,
  };
  return { ai, set: (next: AiState) => ((state = next), listeners.forEach((l) => l())) };
}

const parts = (element: HTMLElement) => ({ box: element.querySelector("input")!, note: element.querySelector(".ai-note")!, label: element.querySelector("label")! });

describe("the AI tickbox", () => {
  it("is named as agreed, and starts unticked", () => {
    const { box, label } = parts(createAiSetting(fakeAi({ kind: "off" }).ai));
    expect(label.textContent).toBe("Use AI processing of input");
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
  });

  it("starts the download from the click, and shows progress", () => {
    const { ai, set } = fakeAi({ kind: "off" });
    const { box, note } = parts(createAiSetting(ai));
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(ai.turnOn).toHaveBeenCalledTimes(1);
    set({ kind: "downloading", progress: 0.34 });
    expect(note.textContent).toBe("Downloading 34%");
    expect(box.checked).toBe(true);
    set({ kind: "ready" });
    expect(note.textContent).toBe("");
    expect(box.checked).toBe(true);
  });

  it("turns off when unticked", () => {
    const { ai } = fakeAi({ kind: "ready" });
    const { box } = parts(createAiSetting(ai));
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(ai.turnOff).toHaveBeenCalledTimes(1);
  });

  it("is disabled, with the reason, where the model cannot run", () => {
    const { box, note, label } = parts(createAiSetting(fakeAi({ kind: "unsupported" }).ai));
    expect(box.disabled).toBe(true);
    expect(note.textContent).toBe("Not available here");
    expect(label.title).toContain("Chrome 148");
  });

  it("unticks and says so when the model cannot start or has gone", () => {
    const { ai, set } = fakeAi({ kind: "downloading", progress: 0 });
    const { box, note } = parts(createAiSetting(ai));
    set({ kind: "failed" });
    expect(box.checked).toBe(false);
    expect(note.textContent).toBe("Could not start the model");
    set({ kind: "missing" });
    expect(box.checked).toBe(false);
    expect(note.textContent).toBe("Tick to download the model again");
  });
});
