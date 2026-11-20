import { defaultAmount, type ShownAmount } from "../core/amount-text";
import { canReload, foodLabel, nutrientsForAmount, type FoodItem } from "../core/food";
import { expandMeal, tooManyIngredients, type SavedMeal } from "../core/meal";
import { scaleProfile } from "../core/nutrients";
import { batchProfile, MAX_INGREDIENTS, type PrepIngredient } from "../core/prep";
import { formatAmount, PORTION_PREFIX, toBaseAmount, unitDef, type Measurable } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { createAmountField, type AmountField } from "./amount-field";
import { el, errorMessage } from "./dom";
import { createFoodCombobox, type ComboExtra, type FoodCombobox } from "./food-combobox";
import { unitOptions } from "./form-fields";
import { energyLabel, fmtEnergy } from "./format";
import { savedMealRows, SERVINGS } from "./ingredient-adder";

const log = logger("ingredients");

export interface IngredientRowsOptions {
  readonly catalog: FoodCatalog;
  /** Prefix for the fields' IDs. */
  readonly id: string;
  /** What an empty search field says. */
  readonly placeholder: string;
  /** Saved meals to offer in each search. One stays a single row, in servings, until it is read: then it is its ingredients. */
  readonly meals?: () => readonly SavedMeal[];
  /** Called after anything that changes what `read` returns. */
  readonly onChange: () => void;
}

export interface IngredientRows {
  readonly element: HTMLElement;
  /** Starts again from these ingredients, one row each, or from one empty row when there are none. */
  set(ingredients: readonly PrepIngredient[]): void;
  /** The ingredients as the rows stand, or why one of them can't be used yet. Empty rows don't count. */
  read(): { readonly ingredients: PrepIngredient[]; readonly problem?: string };
  /** The ingredients with the last good amount of each row: for keeping a draft. */
  snapshot(): PrepIngredient[];
  /** Shows the energy again, after the energy unit changes. */
  refresh(): void;
}

/** What a row stands for, once something is chosen in its search. */
type Choice =
  /** An ingredient as saved, or restored from a draft. Its own nutrients scale with the amount, so the food need not load. */
  | { readonly kind: "saved"; readonly base: PrepIngredient; food?: FoodItem }
  | { readonly kind: "food"; readonly food: FoodItem }
  | { readonly kind: "meal"; readonly meal: SavedMeal };

interface Row {
  readonly n: number;
  choice?: Choice;
  /** The food being loaded, by name. */
  loading?: string;
  /** Why the row can't be used, from loading its food. */
  error?: string;
  /** Counts choices, so that a slow load for an earlier one is ignored. */
  version: number;
  /** The food of an ingredient as saved has been asked for. */
  asked: boolean;
  /** What the row gave when it last read well: kept in a draft while the amount is being changed. */
  last: PrepIngredient[];
  readonly combobox: FoodCombobox;
  readonly amount: AmountField;
  readonly energy: HTMLElement;
  readonly status: HTMLElement;
  readonly element: HTMLElement;
}

/**
 * The units an ingredient as saved can change to without its food: others of the same kind, which its nutrients scale
 * to. A portion is its only unit, as for a saved meal's servings.
 */
export function savedUnits(unit: string): Measurable {
  if (unit.startsWith(PORTION_PREFIX)) return { basis: "g", portions: [{ name: unit.slice(PORTION_PREFIX.length), amount: 1, unit: "g" }], portionsOnly: true };
  return { basis: unitDef(unit)?.dimension === "volume" ? "ml" : "g", portions: [] };
}

/**
 * An ingredient as saved, at another amount or unit. Its own nutrients scale whenever the unit is of the same kind (or
 * the same portion), which keeps the values it was saved with (DR-29). Only another kind of unit, or another portion,
 * takes the food's nutrients as the catalogue has them now. Undefined when neither can say.
 */
export function rescaleSaved(base: PrepIngredient, quantity: number, unit: string, food?: FoodItem): PrepIngredient | undefined {
  const units = savedUnits(base.unit);
  try {
    const ratio = toBaseAmount(units, quantity, unit) / toBaseAmount(units, base.quantity, base.unit);
    return { ...base, quantity, unit, profile: ratio === 1 ? base.profile : scaleProfile(base.profile, ratio) };
  } catch {
    if (!food) return undefined;
    try {
      return { ...base, quantity, unit, profile: nutrientsForAmount(food, quantity, unit) };
    } catch {
      return undefined;
    }
  }
}

/**
 * The ingredients of a recipe as rows that all stay open until it is saved: each has its own search, amount and unit,
 * and any of them can be changed or removed. Add ingredient adds an empty row. Custom foods can't be ingredients yet:
 * they can't be loaded again.
 */
export function createIngredientRows(opts: IngredientRowsOptions): IngredientRows {
  let rows: Row[] = [];
  let next = 0;
  const list = el("ul", { class: "ingredient-rows" });
  const addButton = el("button", { type: "button", class: "add-row" }, "Add ingredient");
  addButton.addEventListener("click", () => {
    const row = append();
    syncAdd();
    row.combobox.input.focus();
  });

  /** The row's units: the loaded food's, a saved meal's servings, or what an ingredient as saved can change to. */
  const unitsOf = (choice: Choice): Measurable => (choice.kind === "meal" ? SERVINGS : choice.kind === "food" ? choice.food : (choice.food ?? savedUnits(choice.base.unit)));

  /** What the row gives, or why it gives nothing. Undefined for an empty row. */
  function readRow(r: Row): { ingredients: PrepIngredient[] } | { problem: string } | undefined {
    const choice = r.choice;
    if (!choice) {
      if (r.loading) return { problem: `Loading ${r.loading}…` };
      if (r.error) return { problem: r.error };
      return r.combobox.input.value.trim() || r.amount.input.value.trim() ? { problem: `Choose a food from the list for "${r.combobox.input.value.trim() || "the empty row"}", or remove the row.` } : undefined;
    }
    const name = choice.kind === "meal" ? choice.meal.name : choice.kind === "food" ? foodLabel(choice.food) : choice.base.label;
    const amount = r.amount.read();
    if (amount.state === "problem") return { problem: `${name}: ${amount.message}` };
    if (amount.state !== "ok") return { problem: `Enter an amount for ${name}.` };
    if (choice.kind === "meal") return { ingredients: expandMeal(choice.meal, toBaseAmount(SERVINGS, amount.quantity, amount.unit)) };
    if (choice.kind === "food") {
      const f = choice.food;
      try {
        return { ingredients: [{ ref: f.ref, label: foodLabel(f), quantity: amount.quantity, unit: amount.unit, profile: nutrientsForAmount(f, amount.quantity, amount.unit) }] };
      } catch (e) {
        return { problem: `${name}: ${errorMessage(e)}` };
      }
    }
    const scaled = rescaleSaved(choice.base, amount.quantity, amount.unit, choice.food);
    return scaled ? { ingredients: [scaled] } : { problem: `${name} can't be measured in that unit until its food has loaded.` };
  }

  function showRow(r: Row) {
    const read = readRow(r);
    if (read && "ingredients" in read) r.last = read.ingredients;
    else if (!r.choice) r.last = [];
    r.energy.textContent = read && "ingredients" in read ? `${fmtEnergy(batchProfile(read.ingredients).energyKcal)} ${energyLabel()}` : "";
    r.status.classList.toggle("error", Boolean(r.error));
    r.status.textContent = r.loading ? `Loading ${r.loading}…` : (r.error ?? "");
    r.element.classList.toggle("empty-row", !r.choice);
  }

  function changed(r: Row) {
    showRow(r);
    opts.onChange();
  }

  function forget(r: Row) {
    r.version++;
    r.choice = undefined;
    r.loading = undefined;
    r.error = undefined;
    r.last = [];
  }

  /** Shows the row's units, keeping the amount as it stands. */
  function showUnits(r: Row, fill: (food: Measurable) => ShownAmount = defaultAmount) {
    if (r.choice) r.amount.show(unitsOf(r.choice), fill);
  }

  /** Loads an ingredient as saved's food, so that its other portions and units are offered too. Once, and quietly: without it, the row still works in units of the same kind. */
  function loadSaved(r: Row) {
    const choice = r.choice;
    if (choice?.kind !== "saved" || r.asked || !canReload(choice.base.ref.source)) return;
    r.asked = true;
    const mine = r.version;
    opts.catalog.get(choice.base.ref).then(
      (food) => {
        // A food that no longer has the unit it was saved in would change the amount under the user: keep to what was saved.
        if (mine !== r.version || !food || !unitOptions(food).some((o) => o.value === choice.base.unit)) return;
        choice.food = food;
        showUnits(r);
        changed(r);
      },
      (e: unknown) => log.warn("Loading a saved ingredient's units failed", describeError(e)),
    );
  }

  function createRow(base?: PrepIngredient): Row {
    const n = next++;
    const id = `${opts.id}-${n}`;
    const amount = createAmountField({ id: `${id}-qty`, unitId: `${id}-unit`, placeholder: "e.g. 100 g", label: "Amount", unitLabel: "Unit", onChange: () => changed(row) });
    const mealRows = (query: string): ComboExtra[] =>
      savedMealRows(opts.meals?.() ?? [], query, (m) => {
        forget(row);
        row.choice = { kind: "meal", meal: m };
        amount.clear();
        showUnits(row);
        changed(row);
        amount.input.focus();
      });
    const combobox = createFoodCombobox(opts.catalog, {
      id: `${id}-food`,
      ...(opts.meals ? { extras: mealRows } : {}),
      onChoose: (hit) => {
        forget(row);
        const mine = row.version;
        row.loading = hit.summary.name;
        amount.clear();
        changed(row);
        amount.input.focus();
        opts.catalog.get(hit.summary.ref).then(
          (loaded) => {
            if (mine !== row.version) return;
            row.loading = undefined;
            if (loaded) {
              row.choice = { kind: "food", food: loaded };
              showUnits(row);
            } else row.error = "That food is no longer in the catalogue. Search again.";
            changed(row);
          },
          (e: unknown) => {
            if (mine !== row.version) return;
            row.loading = undefined;
            log.error("Loading an ingredient failed", describeError(e));
            row.error = `Could not load ${hit.summary.name}: ${errorMessage(e)}`;
            changed(row);
          },
        );
      },
      onCustom: () => {
        forget(row);
        row.error = "Custom foods can't be ingredients yet. Search for the food instead.";
        changed(row);
      },
      onEdit: () => {
        forget(row);
        amount.hideUnits();
        changed(row);
      },
    });
    combobox.input.placeholder = opts.placeholder;
    combobox.input.setAttribute("aria-label", "Ingredient");
    // Text in a row with nothing chosen keeps the recipe from being saved, so the total says so as it is typed.
    combobox.input.addEventListener("input", () => changed(row));
    // Inside a form, Enter would otherwise submit it. In the search it only chooses from the list.
    combobox.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") ev.preventDefault();
    });
    // Enter in an amount goes on to the next row, and from the last one adds a row.
    amount.input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      amount.settle();
      const after = rows[rows.indexOf(row) + 1];
      if (after) after.combobox.input.focus();
      else if (!addButton.disabled) addButton.click();
    });
    const energy = el("span", { class: "ingredient-energy" });
    const status = el("p", { class: "status", role: "status" });
    const remove = el(
      "button",
      {
        type: "button",
        class: "icon",
        title: "Remove ingredient",
        "aria-label": "Remove ingredient",
        onclick: () => {
          const at = rows.indexOf(row);
          row.version++;
          amount.dispose();
          combobox.dispose();
          rows = rows.filter((x) => x !== row);
          row.element.remove();
          syncAdd();
          opts.onChange();
          // Focus stays in the list, on the row that took this one's place.
          (rows[Math.min(at, rows.length - 1)]?.combobox.input ?? addButton).focus();
        },
      },
      // U+FE0E: as text, because some phones would otherwise draw it as an emoji.
      "✕︎",
    );
    const element = el(
      "li",
      { "data-row": String(n) },
      el("div", { class: "ingredient-food" }, combobox.element),
      amount.input,
      amount.unitSelect,
      energy,
      remove,
      el("div", { class: "ingredient-notes" }, amount.note, status),
    );
    const row: Row = { n, version: 0, asked: false, last: [], combobox, amount, energy, status, element };
    // Only the amount and unit need the food. Hovering the unit loads it before a click opens the list, so the options don't change under it.
    amount.input.addEventListener("focus", () => loadSaved(row));
    amount.unitSelect.addEventListener("focus", () => loadSaved(row));
    amount.unitSelect.addEventListener("pointerenter", () => loadSaved(row));
    if (base) {
      row.choice = { kind: "saved", base };
      combobox.showChoice(base.label);
      amount.show(savedUnits(base.unit), () => ({ text: formatAmount(base.quantity), unit: base.unit }));
    }
    showRow(row);
    return row;
  }

  function append(base?: PrepIngredient): Row {
    const row = createRow(base);
    rows.push(row);
    list.append(row.element);
    return row;
  }

  /** Each row is one ingredient at least, so there can be no more rows than ingredients. */
  function syncAdd() {
    addButton.disabled = rows.length >= MAX_INGREDIENTS;
  }

  function set(ingredients: readonly PrepIngredient[]) {
    for (const r of rows) {
      r.version++;
      r.amount.dispose();
      r.combobox.dispose();
    }
    rows = [];
    list.replaceChildren();
    if (ingredients.length === 0) append();
    else for (const i of ingredients) append(i);
    syncAdd();
  }

  return {
    element: el("div", { class: "ingredient-editor" }, list, addButton),
    set,
    read() {
      const ingredients: PrepIngredient[] = [];
      for (const r of rows) {
        const read = readRow(r);
        if (!read) continue;
        if ("problem" in read) return { ingredients, problem: read.problem };
        ingredients.push(...read.ingredients);
      }
      const tooMany = tooManyIngredients(ingredients.length, 0);
      return { ingredients, ...(tooMany ? { problem: tooMany } : {}) };
    },
    snapshot: () => rows.flatMap((r) => r.last),
    refresh() {
      for (const r of rows) showRow(r);
    },
  };
}
