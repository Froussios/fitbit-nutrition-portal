import { defaultAmount } from "../core/amount-text";
import { foodLabel, nutrientsForAmount, type FoodItem } from "../core/food";
import { expandMeal, type SavedMeal } from "../core/meal";
import { batchProfile, type PrepIngredient } from "../core/prep";
import { toBaseAmount, type Measurable } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { createAmountField } from "./amount-field";
import { el, errorMessage } from "./dom";
import { createFoodCombobox, type ComboExtra } from "./food-combobox";
import { field } from "./form-fields";
import { energyLabel, fmtEnergy } from "./format";

const log = logger("ingredients");

/** While typing, at most this many saved meals come before the food search hits. */
const MAX_MEAL_HITS = 2;
/**
 * A saved meal is measured in servings: one is the meal as saved. The serving is modelled as a portion of 1 g, so
 * toBaseAmount gives the number of servings. That is safe only because of `portionsOnly`: without it, a typed `g`
 * would be read as grams and taken as that many servings.
 */
export const SERVINGS: Measurable = { basis: "g", portions: [{ name: "serving", amount: 1, unit: "g" }], portionsOnly: true };

export interface IngredientAdderOptions {
  readonly catalog: FoodCatalog;
  /** Prefix for the fields' IDs. */
  readonly id: string;
  /** What the search field says when empty. */
  readonly placeholder: string;
  /** Saved meals to offer in the search. Each is added as its ingredients, not as a link to the meal. */
  readonly meals?: () => readonly SavedMeal[];
  /** Adds the ingredients, or says why they can't be added. `from` is the saved meal they came from. */
  readonly onAdd: (ingredients: PrepIngredient[], from?: SavedMeal) => string | undefined;
}

export interface IngredientAdder {
  readonly element: HTMLElement;
  /** Starts the search afresh, so that nothing half-chosen is carried over. */
  reset(): void;
  readonly input: HTMLInputElement;
}

/**
 * Finds one ingredient in the food catalogue and adds it at the amount given, or a saved meal, which adds all its
 * ingredients scaled to the servings given. Custom foods can't be ingredients yet: they can't be loaded again.
 */
export function createIngredientAdder(opts: IngredientAdderOptions): IngredientAdder {
  let food: FoodItem | undefined;
  let meal: SavedMeal | undefined;
  let loading: string | undefined;
  let choice = 0;

  const amount = createAmountField({ id: `${opts.id}-qty`, unitId: `${opts.id}-unit`, placeholder: "e.g. 100 g", onChange: () => refresh() });
  const addButton = el("button", { type: "button" }, "Add");
  const status = el("p", { class: "status", role: "status" });

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

  const refresh = () => {
    addButton.disabled = !(food || meal) || amount.read().state !== "ok";
    if (loading) say(`Loading ${loading}…`);
  };

  const forget = () => {
    choice++;
    food = undefined;
    meal = undefined;
    loading = undefined;
  };

  const mealRows = (query: string): ComboExtra[] => {
    const q = query.trim().toLowerCase();
    return (opts.meals?.() ?? [])
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, MAX_MEAL_HITS)
      .map((m) => ({
        name: m.name,
        detail: `${fmtEnergy(batchProfile(m.ingredients).energyKcal)} ${energyLabel()}`,
        tag: "Saved meal",
        sub: `${m.ingredients.length} ${m.ingredients.length === 1 ? "ingredient" : "ingredients"}`,
        choose: () => {
          forget();
          meal = m;
          say("");
          combobox.showChoice(m.name);
          amount.clear();
          amount.show(SERVINGS, defaultAmount);
          refresh();
          amount.input.focus();
        },
      }));
  };

  const combobox = createFoodCombobox(opts.catalog, {
    id: `${opts.id}-food`,
    ...(opts.meals ? { extras: mealRows } : {}),
    onChoose: (hit) => {
      forget();
      const mine = choice;
      loading = hit.summary.name;
      amount.clear();
      refresh();
      amount.input.focus();
      opts.catalog.get(hit.summary.ref).then(
        (loaded) => {
          if (mine !== choice) return;
          loading = undefined;
          food = loaded;
          if (loaded) {
            say("");
            amount.show(loaded, defaultAmount);
          } else say("That food is no longer in the catalogue. Search again.", true);
          refresh();
        },
        (e: unknown) => {
          if (mine !== choice) return;
          loading = undefined;
          log.error("Loading an ingredient failed", describeError(e));
          say(`Could not load ${hit.summary.name}: ${errorMessage(e)}`, true);
          refresh();
        },
      );
    },
    onCustom: () => {
      forget();
      say("Custom foods can't be ingredients yet. Search for the food instead.", true);
      refresh();
    },
    onEdit: () => {
      forget();
      say("");
      amount.hideUnits();
      refresh();
    },
  });
  combobox.input.placeholder = opts.placeholder;

  function reset() {
    forget();
    combobox.reset();
    amount.clear();
    amount.hideUnits();
    refresh();
  }

  // Inside the log form, Enter would otherwise log the meal. In the search it only chooses from the list.
  combobox.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") ev.preventDefault();
  });
  // Enter in the amount adds the ingredient.
  amount.input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    addButton.click();
  });

  addButton.addEventListener("click", () => {
    amount.settle();
    const read = amount.read();
    if (read.state !== "ok" || !(food || meal)) return;
    let ingredients: PrepIngredient[];
    let added: string;
    if (meal) {
      const servings = toBaseAmount(SERVINGS, read.quantity, read.unit);
      ingredients = expandMeal(meal, servings);
      added = `Added ${ingredients.length} ${ingredients.length === 1 ? "ingredient" : "ingredients"} from ${meal.name}.`;
    } else {
      const f = food!;
      ingredients = [{ ref: f.ref, label: foodLabel(f), quantity: read.quantity, unit: read.unit, profile: nutrientsForAmount(f, read.quantity, read.unit) }];
      added = `Added ${f.name}.`;
    }
    const problem = opts.onAdd(ingredients, meal);
    if (problem) return say(problem, true);
    reset();
    say(added);
    combobox.input.focus();
  });

  refresh();
  return {
    element: el(
      "div",
      { class: "ingredient-adder" },
      el("div", { class: "field" }, el("span", {}, el("label", { for: `${opts.id}-food` }, "Add an ingredient")), combobox.element),
      el("div", { class: "row" }, field("Amount", amount.input), field("Unit", amount.unitSelect), el("div", { class: "field add-field" }, el("span", { "aria-hidden": "true" }, " "), addButton)),
      amount.note,
      status,
    ),
    reset,
    input: combobox.input,
  };
}
