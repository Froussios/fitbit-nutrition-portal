import { isCivilDate } from "../core/day-url";
import { describeError, logger } from "../debug/log";
import { el } from "./dom";

const log = logger("day-picker");

export interface DayPicker {
  /** The calendar button, with the hidden date field the browser's picker opens from. */
  readonly element: HTMLElement;
  /** Updates the day the picker opens on, and the last day it offers (YYYY-MM-DD). */
  update(day: string, today: string): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function calendarIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("d", "M5 0a1 1 0 0 1 1 1v1h4V1a1 1 0 1 1 2 0v1h1.5A1.5 1.5 0 0 1 15 3.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 14.5v-11A1.5 1.5 0 0 1 2.5 2H4V1a1 1 0 0 1 1-1ZM3 6v8h10V6Zm1.5 1.5h2v2h-2Z");
  svg.append(path);
  return svg;
}

/**
 * An icon button that opens the browser's own date picker (#19), to jump to any day up to today.
 * The date field stays out of sight and out of the tab order: the button is the only control.
 */
export function createDayPicker(onPick: (day: string) => void): DayPicker {
  const input = el("input", { type: "date", class: "day-pick-field", tabindex: "-1", "aria-hidden": "true" });
  input.addEventListener("change", () => {
    if (isCivilDate(input.value) && (!input.max || input.value <= input.max)) onPick(input.value);
  });
  const button = el(
    "button",
    {
      type: "button",
      class: "day-pick",
      "aria-label": "Choose a day",
      title: "Choose a day",
      onclick: () => {
        try {
          input.showPicker();
        } catch (e) {
          // Chrome, the browser this desktop app targets, has had showPicker since version 99.
          log.warn("The browser could not open its date picker", describeError(e));
        }
      },
    },
    calendarIcon(),
  );
  return {
    element: el("span", { class: "day-pick-wrap" }, button, input),
    update: (day, today) => {
      input.max = today;
      input.value = day;
    },
  };
}
