import type { AiState, AmountAi } from "../ai/amount-ai";
import { el } from "./dom";

const ABOUT = "Reads amounts the app's own rules cannot, such as a mistyped unit, using the model built into Chrome. What you type stays on this computer. You check the result before it is logged.";

function noteFor(state: AiState): string {
  switch (state.kind) {
    case "unsupported":
      return "Not available here";
    case "missing":
      return "Tick to download the model again";
    case "downloading":
      return `Downloading ${Math.round(state.progress * 100)}%`;
    case "failed":
      return "Could not start the model";
    case "off":
    case "ready":
      return "";
  }
}

/** The tickbox in the page header. Kept for the life of the page, because a download can outlast a redraw of the header. */
export function createAiSetting(ai: AmountAi): HTMLElement {
  const box = el("input", {
    type: "checkbox",
    onchange: () => {
      if (box.checked) ai.turnOn();
      else ai.turnOff();
    },
  });
  const note = el("span", { class: "ai-note", role: "status" });
  const label = el("label", { class: "ai-setting", title: ABOUT }, box, "Use AI processing of input");

  const show = () => {
    const state = ai.getState();
    box.checked = state.kind === "ready" || state.kind === "downloading";
    box.disabled = state.kind === "unsupported";
    label.title = state.kind === "unsupported" ? "This needs Chrome 148 or later on a desktop computer with 22 GB of free disk space." : ABOUT;
    note.textContent = noteFor(state);
  };
  ai.onChange(show);
  show();

  return el("div", { class: "ai-control" }, label, note);
}
