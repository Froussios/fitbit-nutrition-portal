import { el } from "./dom";

export type EntryTab = "log" | "prep" | "meals";

const ORDER: readonly EntryTab[] = ["log", "prep", "meals"];

/**
 * The card above the diary: the log form, with the Meal prep (#55) and Saved meals tabs beside it. A site without the
 * meal prep API shows the log form alone, under a plain heading, and one whose API predates saved meals has no
 * Saved meals tab.
 */
export function createEntryCard(logPanel: HTMLElement, prepPanel: HTMLElement, mealsPanel: HTMLElement) {
  const tabs: Record<EntryTab, HTMLButtonElement> = {
    log: el("button", { type: "button", role: "tab", id: "tab-log", "aria-controls": "panel-log" }, "Log food"),
    prep: el("button", { type: "button", role: "tab", id: "tab-prep", "aria-controls": "panel-prep" }),
    meals: el("button", { type: "button", role: "tab", id: "tab-meals", "aria-controls": "panel-meals" }),
  };
  const panels: Record<EntryTab, HTMLElement> = {
    log: el("div", { role: "tabpanel", id: "panel-log", "aria-labelledby": "tab-log" }, logPanel),
    prep: el("div", { role: "tabpanel", id: "panel-prep", "aria-labelledby": "tab-prep" }, prepPanel),
    meals: el("div", { role: "tabpanel", id: "panel-meals", "aria-labelledby": "tab-meals" }, mealsPanel),
  };
  const tabList = el("div", { class: "tabs", role: "tablist", "aria-label": "Add food" }, tabs.log, tabs.prep, tabs.meals);
  const heading = el("h2", {}, "Log food");
  const element = el("section", { class: "card entry-card" }, heading, tabList, panels.log, panels.prep, panels.meals);
  let current: EntryTab = "log";
  let prepAvailable = false;
  let mealsAvailable = false;

  const shown = (): EntryTab[] => ORDER.filter((t) => t === "log" || (t === "prep" && prepAvailable) || (t === "meals" && mealsAvailable));

  function show(tab: EntryTab, focus = false) {
    current = shown().includes(tab) ? tab : "log";
    for (const key of ORDER) {
      const selected = key === current;
      tabs[key].setAttribute("aria-selected", String(selected));
      // One tab stop for the tab list: the arrow keys move between tabs (WAI-ARIA tabs pattern).
      tabs[key].tabIndex = selected ? 0 : -1;
      tabs[key].hidden = !shown().includes(key);
      panels[key].hidden = !selected;
    }
    if (focus) tabs[current].focus();
  }

  for (const key of ORDER) tabs[key].addEventListener("click", () => show(key));
  tabList.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End") return;
    ev.preventDefault();
    const list = shown();
    const at = list.indexOf(current);
    const next = ev.key === "Home" ? 0 : ev.key === "End" ? list.length - 1 : (at + (ev.key === "ArrowRight" ? 1 : list.length - 1)) % list.length;
    show(list[next]!, true);
  });

  function sync() {
    const any = shown().length > 1;
    tabList.hidden = !any;
    heading.hidden = any;
    show(current);
  }

  /** Whether the site has meal prep, and how many batches have some left. */
  function setPrep(isAvailable: boolean, onHand: number) {
    prepAvailable = isAvailable;
    tabs.prep.replaceChildren("Meal prep", onHand > 0 ? el("span", { class: "count" }, String(onHand)) : "");
    sync();
  }

  /** Whether the site has saved meals, and how many there are. */
  function setMeals(isAvailable: boolean, count: number) {
    mealsAvailable = isAvailable;
    tabs.meals.replaceChildren("Saved meals", count > 0 ? el("span", { class: "count" }, String(count)) : "");
    sync();
  }

  setPrep(false, 0);
  setMeals(false, 0);
  return {
    element,
    show,
    setPrep,
    setMeals,
    get tab() {
      return current;
    },
  };
}

export type EntryCard = ReturnType<typeof createEntryCard>;
