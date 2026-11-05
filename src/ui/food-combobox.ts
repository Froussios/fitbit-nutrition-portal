import { foodLabel, isGenericSource, SOURCE_TAGS } from "../core/food";
import type { FoodSummary } from "../core/food-summary";
import type { TextRun } from "../core/tokens";
import type { FoodCatalog, FoodSearchHit } from "../food/catalog";
import { describeError, logger } from "../debug/log";
import { INITIAL, fieldText, reduce, type ComboEvent, type ComboState } from "./combobox-state";
import { el, replaceChildren } from "./dom";
import { fmtKcal } from "./format";
import { SearchController, type SearchUpdate } from "./search-controller";

const log = logger("search");

export interface FoodComboboxOptions {
  readonly id: string;
  /** A search hit was chosen. */
  onChoose(hit: FoodSearchHit): void;
  /** The "Custom food" row was chosen; `query` is what the user typed. */
  onCustom(query: string): void;
  /** The user changed the text, so any earlier choice no longer applies. */
  onEdit(): void;
}

export interface FoodCombobox {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** Whether a choice (hit or custom) currently stands in the field. */
  readonly hasChoice: boolean;
}

/** Shows a "Searching…" hint only when a search takes longer than this. */
const SLOW_MS = 300;

/** The label written into the field for a hit, e.g. "Weet-Bix (Sanitarium)". */
export function hitLabel(hit: FoodSearchHit): string {
  return foodLabel(hit.summary);
}

function runs(parts: readonly TextRun[]): Node[] {
  return parts.map((r) => (r.match ? el("mark", {}, r.text) : document.createTextNode(r.text)));
}

const unitLabel = (s: FoodSummary) => `100 ${s.basis}`;

/**
 * Search-as-you-type field with a dropdown of matches (docs/FOOD_SEARCH.md
 * section 3): WAI-ARIA editable combobox with list autocomplete.
 */
export function createFoodCombobox(catalog: FoodCatalog, opts: FoodComboboxOptions): FoodCombobox {
  const listId = `${opts.id}-list`;
  const input = el("input", {
    id: opts.id,
    type: "text",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    enterkeyhint: "search",
    placeholder: "Search foods, e.g. weet bix",
  });
  const list = el("ul", { id: listId, role: "listbox", class: "combo-list", hidden: true, "aria-label": "Matching foods" });
  const live = el("p", { class: "visually-hidden", "aria-live": "polite" });
  const element = el("div", { class: "combo" }, input, list, live);

  let state: ComboState = INITIAL;
  let hits: readonly FoodSearchHit[] = [];
  let status: SearchUpdate["status"] = "idle";
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let hasChoice = false;
  let composing = false;

  const optionId = (row: number) => `${opts.id}-opt-${row}`;

  const render = () => {
    // Assign only on change, so the caret stays where the user is typing.
    const text = fieldText(state, (row) => hitLabel(hits[row]!));
    if (input.value !== text) input.value = text;
    const show = state.open && status !== "idle";
    list.hidden = !show;
    input.setAttribute("aria-expanded", String(show));
    if (show && state.active >= 0) input.setAttribute("aria-activedescendant", optionId(state.active));
    else input.removeAttribute("aria-activedescendant");
    if (!show) return;

    const rows: HTMLElement[] = hits.map((hit, i) => {
      const s = hit.summary;
      const maker = s.brand
        ? runs(hit.brand ?? [{ text: s.brand, match: false }])
        : [el("span", { class: "opt-nobrand" }, isGenericSource(s.ref.source) ? "Generic" : "No brand listed")];
      const sub = [
        ...maker,
        ...(s.packSize ? [document.createTextNode(` · ${s.packSize}`)] : []),
        el("span", { class: "opt-source", title: "Where this food's data comes from" }, SOURCE_TAGS[s.ref.source]),
      ];
      return el(
        "li",
        { id: optionId(i), role: "option", class: "opt", "aria-selected": String(i === state.active) },
        el("span", { class: "opt-name" }, ...runs(hit.name)),
        el("span", { class: "opt-kcal" }, el("strong", {}, fmtKcal(s.kcalPer100)), ` kcal / ${unitLabel(s)}`),
        el("span", { class: "opt-sub" }, ...sub),
        s.serving ? el("span", { class: "opt-serving" }, `${fmtKcal(s.serving.kcal)} kcal / ${s.serving.label}`) : null,
      );
    });
    const custom = hits.length;
    const message =
      status === "error"
        ? el("li", { class: "opt-note error", role: "presentation" }, "Food search is unavailable right now.")
        : status === "searching" && hits.length === 0
          ? el("li", { class: "opt-note slow", role: "presentation" }, "Searching…")
          : status === "done" && hits.length === 0
            ? el("li", { class: "opt-note", role: "presentation" }, `No match for "${state.query.trim()}".`)
            : null;
    replaceChildren(
      list,
      message,
      ...rows,
      el(
        "li",
        { id: optionId(custom), role: "option", class: "opt opt-custom", "aria-selected": String(state.active === custom) },
        `+ Custom food "${state.query.trim()}"`,
      ),
      catalog.attributions?.length
        ? el(
            "li",
            { class: "opt-note attribution", role: "presentation" },
            ...catalog.attributions.flatMap((a, i) => [i > 0 ? " · " : null, el("a", { href: a.href, target: "_blank", rel: "noopener" }, a.text)]),
          )
        : null,
    );
    list.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  };

  const dispatch = (e: ComboEvent) => {
    state = reduce(state, e);
    render();
  };

  const controller = new SearchController(catalog, (u) => {
    status = u.status;
    clearTimeout(slowTimer);
    element.classList.remove("searching");
    if (u.status === "searching") slowTimer = setTimeout(() => element.classList.add("searching"), SLOW_MS);
    if (u.status === "done") {
      hits = u.hits;
      live.textContent = hits.length === 0 ? "No results" : `${hits.length} results`;
    } else if (u.status === "idle" || u.status === "error") {
      hits = [];
    }
    if (u.status === "error") log.warn("Food search failed", { query: u.query, error: describeError(u.error) });
    dispatch({ type: "results", hits: hits.length });
  });

  const choose = (row: number) => {
    if (row < hits.length) {
      const hit = hits[row]!;
      hasChoice = true;
      dispatch({ type: "chosen", text: hitLabel(hit) });
      opts.onChoose(hit);
    } else {
      const query = state.query.trim();
      hasChoice = true;
      dispatch({ type: "chosen", text: state.query });
      opts.onCustom(query);
    }
  };

  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => {
    composing = false;
    input.dispatchEvent(new Event("input"));
  });
  input.addEventListener("input", () => {
    if (composing) return;
    if (hasChoice) {
      hasChoice = false;
      opts.onEdit();
    }
    const text = input.value;
    state = reduce(state, { type: "input", text });
    controller.setQuery(text); // reports synchronously (idle, cached or searching), which renders
  });
  input.addEventListener("focus", () => dispatch({ type: "focus" }));
  input.addEventListener("blur", () => dispatch({ type: "close" }));
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing) return;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        if (!state.open && hits.length === 0 && status === "idle") controller.setQuery(state.query);
        dispatch({ type: "down" });
        break;
      case "ArrowUp":
        if (state.open) ev.preventDefault();
        dispatch({ type: "up" });
        break;
      case "Enter":
        if (state.open && state.active >= 0) {
          ev.preventDefault();
          choose(state.active);
        } else if (state.open || !hasChoice) {
          // No row picked: never submit the form with a stale or missing food.
          ev.preventDefault();
        }
        break;
      case "Tab":
        if (state.open && state.active >= 0) choose(state.active);
        break;
      case "Escape":
        if (state.open || input.value) ev.preventDefault();
        if (!state.open && hasChoice) {
          hasChoice = false;
          opts.onEdit();
        }
        dispatch({ type: "escape" });
        if (!state.open && !state.query) controller.setQuery("");
        break;
    }
  });
  // Keep focus in the field while clicking a row, then choose it.
  list.addEventListener("mousedown", (ev) => ev.preventDefault());
  list.addEventListener("click", (ev) => {
    const li = (ev.target as Element).closest<HTMLElement>("li[role=option]");
    if (!li) return;
    const row = [...list.querySelectorAll("li[role=option]")].indexOf(li);
    if (row >= 0) choose(row);
  });

  return {
    element,
    input,
    get hasChoice() {
      return hasChoice;
    },
  };
}
