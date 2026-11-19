import { append, el } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A gear, after Bootstrap Icons' gear-fill (MIT). */
function gearIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.858 2.929 2.929 0 0 1 0 5.858",
  );
  svg.append(path);
  return svg;
}

export interface SettingsMenu {
  /** The gear and its panel, for the page header. Kept for the life of the page, so a redraw leaves an open panel open. */
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** What the panel holds. With nothing, the gear is hidden. Passing the same controls again moves nothing, so focus stays put. */
  setItems(items: readonly (HTMLElement | false | null | undefined)[]): void;
  open(): void;
  close(focusGear?: boolean): void;
}

/**
 * Settings out of the header (DR-40): a gear button that opens a panel under it. Escape, the gear again,
 * or a click or focus outside the panel closes it.
 */
export function createSettingsMenu(): SettingsMenu {
  const body = el("div", { class: "settings-body" });
  const panel = el(
    "div",
    { class: "settings-panel", id: "settings-panel", role: "dialog", "aria-label": "Settings", hidden: true },
    el("h2", {}, "Settings"),
    body,
  );
  const gear = el(
    "button",
    {
      type: "button",
      class: "icon settings-toggle",
      "aria-label": "Settings",
      title: "Settings",
      "aria-haspopup": "dialog",
      "aria-controls": "settings-panel",
      "aria-expanded": "false",
      onclick: () => (menu.isOpen ? menu.close() : menu.open()),
    },
    gearIcon(),
  );
  const element = el("div", { class: "settings" }, gear, panel);
  let items: HTMLElement[] = [];

  const outside = (e: Event) => {
    if (e.target instanceof Node && !element.contains(e.target)) menu.close();
  };

  element.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.isOpen) {
      e.preventDefault();
      menu.close(true);
    }
  });

  const menu: SettingsMenu = {
    element,
    get isOpen() {
      return !panel.hidden;
    },
    setItems(next) {
      const shown = next.filter((n): n is HTMLElement => !!n);
      if (shown.length === items.length && shown.every((n, i) => n === items[i])) return;
      items = shown;
      body.replaceChildren();
      append(body, ...shown);
      element.hidden = shown.length === 0;
      if (element.hidden) menu.close();
    },
    open() {
      if (menu.isOpen || element.hidden) return;
      panel.hidden = false;
      gear.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside);
      document.addEventListener("focusin", outside);
      panel.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)")?.focus();
    },
    close(focusGear = false) {
      if (!menu.isOpen) return;
      panel.hidden = true;
      gear.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      if (focusGear) gear.focus();
    },
  };
  element.hidden = true;
  return menu;
}
