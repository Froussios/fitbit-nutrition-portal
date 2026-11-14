import { byName, type SavedMeal } from "../core/meal";
import { batchProfile, type PrepIngredient } from "../core/prep";
import { describeAmount } from "../core/units";
import { el, replaceChildren } from "./dom";
import { energyLabel, fmtEnergy } from "./format";

export interface MealCardState {
  readonly meals: readonly SavedMeal[];
  readonly loading: boolean;
  readonly error: string;
  readonly offline: boolean;
  /** Meals deleted in this session: still shown, with an undo. */
  readonly deleted: readonly SavedMeal[];
  /** Meals with an action under way, so that a second click sends nothing. */
  readonly busy: ReadonlySet<string>;
  /** What happened last, by meal, e.g. "Saved." or why something failed. */
  readonly messages: ReadonlyMap<string, { readonly text: string; readonly error: boolean }>;
  /** The builder is open, so the list makes way for it. */
  readonly building: boolean;
}

export interface MealCardActions {
  readonly onNew: () => void;
  /** Log the meal: the log form takes over, with the meal chosen. */
  readonly onLog: (meal: SavedMeal) => void;
  readonly onEdit: (meal: SavedMeal) => void;
  readonly onDelete: (meal: SavedMeal) => void;
  readonly onRestore: (meal: SavedMeal) => void;
}

/**
 * The Saved meals tab: each meal on one line, with its energy, and its ingredients and amounts a click away. Log opens the log form with the meal chosen, where its
 * ingredients can be changed for that one entry. Here a meal is made, edited and deleted.
 */
export function createMealCard(actions: MealCardActions, builder: HTMLElement) {
  const list = el("div", { class: "meal-list" });
  const status = el("p", { class: "status", role: "status" });
  const newButton = el("button", { type: "button", onclick: () => actions.onNew() }, "New meal");
  const element = el(
    "div",
    { class: "meal-card" },
    el("div", { class: "prep-card-head" }, el("p", { class: "hint" }, "Meals you eat often, saved as their ingredients. Each one you log is one diary entry under the meal's name."), newButton),
    status,
    builder,
    list,
  );

  const ingredientRow = (i: PrepIngredient) => el("li", {}, el("span", {}, i.label), el("span", { class: "meal-amount" }, describeAmount(i.quantity, i.unit)));

  function mealRow(meal: SavedMeal, s: MealCardState, deleted: boolean, openLists: ReadonlySet<string | undefined>): HTMLElement {
    const busy = s.busy.has(meal.id);
    const off = busy || s.offline;
    const message = s.messages.get(meal.id);
    const count = meal.ingredients.length;
    const buttons = deleted
      ? [el("button", { type: "button", disabled: off, onclick: () => actions.onRestore(meal) }, "Undo delete")]
      : [
          el("button", { type: "button", class: "primary", disabled: busy, onclick: () => actions.onLog(meal) }, "Log"),
          el("button", { type: "button", disabled: off, onclick: () => actions.onEdit(meal) }, "Edit"),
          el("button", { type: "button", disabled: off, "aria-label": `Delete ${meal.name}`, onclick: () => actions.onDelete(meal) }, "Delete"),
        ];
    return el(
      "article",
      { class: deleted ? "meal deleted" : "meal", "data-meal": meal.id },
      el(
        "div",
        { class: "meal-line" },
        el("div", { class: "prep-name" }, el("strong", {}, meal.name), deleted && el("span", { class: "prep-age" }, "deleted")),
        el("span", { class: "meal-energy" }, deleted ? "" : `${fmtEnergy(batchProfile(meal.ingredients).energyKcal)} ${energyLabel()}`),
        el("div", { class: "actions" }, ...buttons),
      ),
      message && el("p", { class: message.error ? "status error" : "status", role: message.error ? "alert" : "status" }, message.text),
      !deleted &&
        count > 0 &&
        el(
          "details",
          { class: "meal-ingredients", open: openLists.has(meal.id) },
          el("summary", {}, `${count} ${count === 1 ? "ingredient" : "ingredients"}`),
          el("ul", {}, ...meal.ingredients.map(ingredientRow)),
        ),
    );
  }

  function update(next: MealCardState) {
    newButton.disabled = next.building || next.offline;
    status.textContent = next.loading ? "Loading…" : next.error;
    status.classList.toggle("error", !next.loading && Boolean(next.error));
    list.hidden = next.building;
    // Keep the open ingredient lists open across redraws.
    const openLists = new Set([...list.querySelectorAll<HTMLElement>("[data-meal]")].filter((a) => a.querySelector("details")?.open).map((a) => a.dataset["meal"]));
    const live = new Set(next.meals.map((m) => m.id));
    const rows = [...next.meals.map((m) => ({ meal: m, deleted: false })), ...next.deleted.filter((m) => !live.has(m.id)).map((m) => ({ meal: m, deleted: true }))].sort((a, b) => byName(a.meal, b.meal));
    replaceChildren(list, rows.length === 0 && !next.loading ? el("p", { class: "empty" }, "No saved meals yet. Make one with New meal.") : rows.map((r) => mealRow(r.meal, next, r.deleted, openLists)));
  }

  return { element, update };
}

export type MealCard = ReturnType<typeof createMealCard>;
