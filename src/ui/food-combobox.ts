import { countryName, flagEmoji, foodCountries, shownCountry } from "../core/countries";
import { foodLabel, isGenericSource, SOURCE_TAGS } from "../core/food";
import type { FoodSummary } from "../core/food-summary";
import type { TextRun } from "../core/tokens";
import { formatMeasurementLabel } from "../core/units";
import type { FoodCatalog, FoodSearchHit } from "../food/catalog";
import { describeError, logger } from "../debug/log";
import { INITIAL, MIN_QUERY, fieldText, reduce, type ComboEvent, type ComboState } from "./combobox-state";
import { el, replaceChildren } from "./dom";
import { energyLabel, fmtEnergy } from "./format";
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
  /** Rows offered above the food search hits for what the user typed, such as meal preps. */
  readonly extras?: (query: string) => readonly ComboExtra[];
  /** Whether to search the food catalogue and offer a custom food. Always, unless this says otherwise. */
  readonly searchFoods?: () => boolean;
}

/** A row that is not a food search hit, such as a meal prep. */
export interface ComboExtra {
  readonly name: string;
  /** On the right, e.g. "60% left". */
  readonly detail: string;
  /** Under the name, after `tag`. */
  readonly sub: string;
  /** What kind of row this is, e.g. "Meal prep". */
  readonly tag: string;
  choose(): void;
}

export interface FoodCombobox {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** Whether a choice (hit or custom) currently stands in the field. */
  readonly hasChoice: boolean;
  /** Empties the field and closes the list, for a fresh start. Doesn't call onEdit: the caller already knows. */
  reset(): void;
  /** Shows `text` in the field as the choice, for a choice made outside the list. Doesn't call any callback. */
  showChoice(text: string): void;
  /** Searches again, after what `extras` or `searchFoods` would answer has changed. */
  refresh(): void;
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

/** A small flag for where the food is sold, with every listed country in its tooltip; null when none is known. */
export function countryFlag(s: FoodSummary): HTMLElement | null {
  const countries = foodCountries(s);
  const shown = shownCountry(countries);
  if (!shown) return null;
  const others = countries.filter((c) => c !== shown);
  const verb = isGenericSource(s.ref.source) ? "From" : "Sold in";
  const label = `${verb} ${[shown, ...others].map(countryName).join(", ")}`;
  return el(
    "span",
    { class: "opt-country", role: "img", title: label, "aria-label": label },
    el("span", { class: "opt-flag" }, flagEmoji(shown)),
    others.length ? ` +${others.length}` : null,
  );
}

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
  let extras: readonly ComboExtra[] = [];
  const foods = () => opts.searchFoods?.() ?? true;
  const searchable = (text: string) => text.trim().length >= MIN_QUERY;
  let status: SearchUpdate["status"] = "idle";
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let hasChoice = false;
  let composing = false;

  const optionId = (row: number) => `${opts.id}-opt-${row}`;

  const render = () => {
    // Assign only on change, so the caret stays where the user is typing.
    const text = fieldText(state, (row) => (row < extras.length ? extras[row]!.name : hitLabel(hits[row - extras.length]!)));
    if (input.value !== text) input.value = text;
    const searchingFoods = foods();
    const show = state.open && (searchingFoods ? status !== "idle" : searchable(state.query));
    list.hidden = !show;
    input.setAttribute("aria-expanded", String(show));
    if (show && state.active >= 0) input.setAttribute("aria-activedescendant", optionId(state.active));
    else input.removeAttribute("aria-activedescendant");
    if (!show) return;

    const extraRows = extras.map((x, i) =>
      el(
        "li",
        { id: optionId(i), role: "option", class: "opt opt-extra", "aria-selected": String(i === state.active) },
        el("span", { class: "opt-name" }, x.name),
        el("span", { class: "opt-energy" }, x.detail),
        el("span", { class: "opt-sub" }, el("span", { class: "opt-kind" }, x.tag), x.sub ? ` · ${x.sub}` : null),
      ),
    );
    const rows: HTMLElement[] = hits.map((hit, j) => {
      const i = j + extras.length;
      const s = hit.summary;
      const maker = s.brand
        ? runs(hit.brand ?? [{ text: s.brand, match: false }])
        : [el("span", { class: "opt-nobrand" }, isGenericSource(s.ref.source) ? "Generic" : "No brand listed")];
      const sub = [
        ...maker,
        ...(s.packSize ? [document.createTextNode(` · ${formatMeasurementLabel(s.packSize)}`)] : []),
        el("span", { class: "opt-source", title: "Where this food's data comes from" }, SOURCE_TAGS[s.ref.source]),
        countryFlag(s),
      ];
      return el(
        "li",
        { id: optionId(i), role: "option", class: "opt", "aria-selected": String(i === state.active) },
        el("span", { class: "opt-name" }, ...runs(hit.name)),
        el("span", { class: "opt-energy" }, el("strong", {}, fmtEnergy(s.kcalPer100)), ` ${energyLabel()} / ${unitLabel(s)}`),
        el("span", { class: "opt-sub" }, ...sub),
        s.serving ? el("span", { class: "opt-serving" }, `${fmtEnergy(s.serving.kcal)} ${energyLabel()} / ${formatMeasurementLabel(s.serving.label)}`) : null,
      );
    });
    const custom = extras.length + hits.length;
    const message = !searchingFoods
      ? extras.length === 0
        ? el("li", { class: "opt-note", role: "presentation" }, `No match for "${state.query.trim()}".`)
        : null
      : status === "error"
        ? el("li", { class: "opt-note error", role: "presentation" }, "Food search is unavailable right now.")
        : status === "searching" && hits.length === 0
          ? el("li", { class: "opt-note slow", role: "presentation" }, "Searching…")
          : status === "done" && hits.length === 0 && extras.length === 0
            ? el("li", { class: "opt-note", role: "presentation" }, `No match for "${state.query.trim()}".`)
            : null;
    replaceChildren(
      list,
      message,
      ...extraRows,
      ...rows,
      searchingFoods &&
        el(
          "li",
          { id: optionId(custom), role: "option", class: "opt opt-custom", "aria-selected": String(state.active === custom) },
          `+ Custom food "${state.query.trim()}"`,
        ),
      searchingFoods &&
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
    dispatch({ type: "results", hits: extras.length + hits.length, custom: foods() });
  });

  /** Finds the extra rows for `text`, then searches the catalogue for it, which reports synchronously and so renders. */
  const search = (text: string) => {
    extras = searchable(text) ? (opts.extras?.(text) ?? []) : [];
    controller.setQuery(foods() ? text : "");
  };
  // Rows must not move under a row the user has already picked with the arrow keys: the next keystroke updates them.
  catalog.onChange?.(() => controller.invalidate(state.open && state.active < 0));

  const choose = (row: number) => {
    if (row < extras.length) {
      const extra = extras[row]!;
      hasChoice = true;
      dispatch({ type: "chosen", text: extra.name });
      extra.choose();
    } else if (row < extras.length + hits.length) {
      const hit = hits[row - extras.length]!;
      hasChoice = true;
      dispatch({ type: "chosen", text: hitLabel(hit) });
      opts.onChoose(hit);
    } else if (foods()) {
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
    search(text);
  });
  input.addEventListener("focus", () => dispatch({ type: "focus" }));
  input.addEventListener("blur", () => dispatch({ type: "close" }));
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing) return;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        if (!state.open && hits.length === 0 && extras.length === 0 && status === "idle") search(state.query);
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
        if (!state.open && !state.query) search("");
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
    reset() {
      hasChoice = false;
      input.value = "";
      state = reduce(state, { type: "input", text: "" });
      search("");
      dispatch({ type: "close" });
    },
    showChoice(text) {
      hasChoice = true;
      dispatch({ type: "chosen", text });
    },
    refresh() {
      if (!hasChoice) search(state.query);
    },
  };
}
