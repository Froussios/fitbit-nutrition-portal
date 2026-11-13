import { scaleIngredient } from "../core/meal";
import type { PrepIngredient } from "../core/prep";
import { formatAmount, formatMeasurementLabel, PORTION_PREFIX, unitDef } from "../core/units";
import { el, replaceChildren } from "./dom";
import { energyLabel, fmtEnergy } from "./format";

export interface IngredientListOptions {
  /** Prefix for the amount fields' IDs. */
  readonly id: string;
  /**
   * "edit": the list is the recipe, and ✕ takes an ingredient out of it. "adjust": the list starts from a saved meal,
   * for one diary entry. ✕ leaves an ingredient out, which can be undone, and changes are counted against the meal.
   */
  readonly mode: "edit" | "adjust";
  /** Called after anything that changes what `read` returns. */
  readonly onChange: () => void;
}

export interface IngredientList {
  readonly element: HTMLElement;
  /** Starts again from these ingredients. In "adjust" mode, changes are counted against them. */
  set(ingredients: readonly PrepIngredient[]): void;
  add(ingredients: readonly PrepIngredient[]): void;
  /** The ingredients as they stand, or why one of the amounts can't be used. */
  read(): { readonly ingredients: PrepIngredient[]; readonly problem?: string };
  /** The ingredients as they stand, with the last good amount for any that can't be read: for keeping a draft. */
  snapshot(): PrepIngredient[];
  /** How many ingredients are added, left out or at another amount than the meal. Always 0 in "edit" mode. */
  changes(): number;
  /** How many ingredients go into the entry. */
  readonly size: number;
  /** Shows the energy again, after the energy unit changes. */
  refresh(): void;
}

interface Row {
  readonly base: PrepIngredient;
  /** What is typed in the amount field. */
  text: string;
  /** The last amount that could be read. */
  quantity: number;
  /** Left out of this entry ("adjust" mode only). */
  left: boolean;
  /** Not in the meal it started from ("adjust" mode only). */
  readonly added: boolean;
}

/** Reads an amount: `150`, `0.5`, `1,5` or `1/2`. Undefined unless it is more than 0. */
export function parseQuantity(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  const value = m ? Number(m[1]) / Number(m[2]) : /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 1e6 ? value : undefined;
}

/** The unit as it reads after an amount: `g`, or `× medium` for a food's own portion. */
export function unitText(unit: string): string {
  return unit.startsWith(PORTION_PREFIX) ? `× ${formatMeasurementLabel(unit.slice(PORTION_PREFIX.length))}` : (unitDef(unit)?.key ?? unit);
}

/**
 * Ingredients, each with an amount that can be changed in place, in the unit it was added in. The nutrients scale with
 * the amount, which needs no food lookup. Shared by the meal prep and saved meal builders, and by a saved meal chosen
 * in the log form.
 */
export function createIngredientList(opts: IngredientListOptions): IngredientList {
  let rows: Row[] = [];
  let next = 0;
  const list = el("ul", { class: "ingredients" });

  const toRow = (base: PrepIngredient, added: boolean): Row => ({ base, text: formatAmount(base.quantity), quantity: base.quantity, left: false, added });
  const current = (r: Row) => scaleIngredient(r.base, r.quantity);
  const inEntry = () => rows.filter((r) => !r.left);

  function render(focus?: number) {
    replaceChildren(list, ...rows.map((r, i) => renderRow(r, i)));
    if (focus !== undefined) {
      const buttons = list.querySelectorAll<HTMLButtonElement>("button");
      buttons[Math.min(focus, buttons.length - 1)]?.focus();
    }
  }

  function renderRow(r: Row, i: number): HTMLElement {
    const id = `${opts.id}-${next++}`;
    const energy = el("span", { class: "ingredient-energy" });
    const showEnergy = () => (energy.textContent = r.left ? "" : `${fmtEnergy(current(r).profile.energyKcal)} ${energyLabel()}`);
    const input = el("input", { id, type: "text", inputmode: "decimal", autocomplete: "off", value: r.text, disabled: r.left, "aria-label": `${r.base.label}, amount in ${unitText(r.base.unit)}` });
    input.addEventListener("input", () => {
      r.text = input.value;
      const q = parseQuantity(input.value);
      if (q !== undefined) r.quantity = q;
      input.setAttribute("aria-invalid", String(q === undefined));
      li.classList.toggle("changed", opts.mode === "adjust" && !r.added && r.quantity !== r.base.quantity);
      showEnergy();
      opts.onChange();
    });
    const leaving = opts.mode === "adjust" && !r.added;
    const button = el(
      "button",
      {
        type: "button",
        class: r.left ? "icon undo" : "icon",
        title: r.left ? "Put it back" : leaving ? "Leave out of this entry" : "Remove ingredient",
        "aria-label": `${r.left ? "Put back" : leaving ? "Leave out" : "Remove"} ${r.base.label}`,
        onclick: () => {
          if (leaving) r.left = !r.left;
          else rows = rows.filter((x) => x !== r);
          render(i);
          opts.onChange();
        },
      },
      // U+FE0E: as text, because some phones would otherwise draw these as emoji.
      r.left ? "↩︎" : "✕",
    );
    const li = el(
      "li",
      { class: [r.left && "left-out", r.added && "added", opts.mode === "adjust" && !r.added && r.quantity !== r.base.quantity && "changed"].filter(Boolean).join(" ") },
      el("span", { class: "ingredient-name" }, r.base.label, r.added && el("span", { class: "tag" }, "added"), r.left && el("span", { class: "tag" }, "left out")),
      input,
      el("span", { class: "ingredient-unit" }, unitText(r.base.unit)),
      energy,
      button,
    );
    showEnergy();
    return li;
  }

  return {
    element: list,
    set(ingredients) {
      rows = ingredients.map((i) => toRow(i, false));
      render();
    },
    add(ingredients) {
      rows = [...rows, ...ingredients.map((i) => toRow(i, opts.mode === "adjust"))];
      render();
    },
    read() {
      const bad = inEntry().find((r) => parseQuantity(r.text) === undefined);
      return { ingredients: inEntry().map(current), ...(bad ? { problem: `Enter an amount for ${bad.base.label}.` } : {}) };
    },
    snapshot: () => rows.map(current),
    changes: () => (opts.mode === "adjust" ? rows.filter((r) => r.added || r.left || r.quantity !== r.base.quantity).length : 0),
    get size() {
      return inEntry().length;
    },
    refresh: () => render(),
  };
}
