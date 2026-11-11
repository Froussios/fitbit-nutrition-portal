import { el } from "./dom";

export type EntryTab = "log" | "prep";

/**
 * The card above the diary: the log form, and the Meal prep tab beside it (#55). A site without the meal prep API
 * shows the log form alone, under a plain heading.
 */
export function createEntryCard(logPanel: HTMLElement, prepPanel: HTMLElement) {
  const tabs: Record<EntryTab, HTMLButtonElement> = {
    log: el("button", { type: "button", role: "tab", id: "tab-log", "aria-controls": "panel-log" }, "Log food"),
    prep: el("button", { type: "button", role: "tab", id: "tab-prep", "aria-controls": "panel-prep" }),
  };
  const panels: Record<EntryTab, HTMLElement> = {
    log: el("div", { role: "tabpanel", id: "panel-log", "aria-labelledby": "tab-log" }, logPanel),
    prep: el("div", { role: "tabpanel", id: "panel-prep", "aria-labelledby": "tab-prep" }, prepPanel),
  };
  const tabList = el("div", { class: "tabs", role: "tablist", "aria-label": "Add food" }, tabs.log, tabs.prep);
  const heading = el("h2", {}, "Log food");
  const element = el("section", { class: "card entry-card" }, heading, tabList, panels.log, panels.prep);
  let current: EntryTab = "log";
  let available = false;

  function show(tab: EntryTab, focus = false) {
    current = available ? tab : "log";
    for (const key of ["log", "prep"] as const) {
      const selected = key === current;
      tabs[key].setAttribute("aria-selected", String(selected));
      // One tab stop for the tab list: the arrow keys move between tabs (WAI-ARIA tabs pattern).
      tabs[key].tabIndex = selected ? 0 : -1;
      panels[key].hidden = !selected;
    }
    if (focus) tabs[current].focus();
  }

  for (const key of ["log", "prep"] as const) tabs[key].addEventListener("click", () => show(key));
  tabList.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End") return;
    ev.preventDefault();
    const next: EntryTab = ev.key === "Home" ? "log" : ev.key === "End" ? "prep" : current === "log" ? "prep" : "log";
    show(next, true);
  });

  /** Whether the site has meal prep, and how many batches have some left. */
  function setPrep(isAvailable: boolean, onHand: number) {
    available = isAvailable;
    tabList.hidden = !available;
    heading.hidden = available;
    tabs.prep.replaceChildren("Meal prep", onHand > 0 ? el("span", { class: "count" }, String(onHand)) : "");
    if (!available) show("log");
  }

  setPrep(false, 0);
  return {
    element,
    show,
    setPrep,
    get tab() {
      return current;
    },
  };
}

export type EntryCard = ReturnType<typeof createEntryCard>;
