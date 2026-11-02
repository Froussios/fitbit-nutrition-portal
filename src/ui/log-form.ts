import { nutrientsForAmount, type FoodItem } from "../core/food";
import { kjToKcal } from "../core/nutrients";
import { toDateTimeLocalValue } from "../core/time";
import { PORTION_PREFIX, selectableUnits, type BaseUnit } from "../core/units";
import { defaultMealType, MEAL_TYPES, type LogDraft } from "../health/mapping";
import type { MealType } from "../health/types";
import type { FoodCatalog } from "../food/catalog";
import { describeError, logger } from "../debug/log";
import { el, errorMessage, replaceChildren } from "./dom";
import { createFoodCombobox } from "./food-combobox";
import { summary } from "./format";

const log = logger("log-form");

/**
 * Form for one diary entry. The food is found by searching the catalogue as
 * you type (docs/FOOD_SEARCH.md), or entered as a custom food per 100 g / 100 ml.
 */
export function createLogForm(catalog: FoodCatalog, onSubmit: (draft: LogDraft) => Promise<void>): HTMLElement {
  /** The chosen catalogue food, once its full nutrients have loaded. */
  let chosen: FoodItem | undefined;
  /** The custom-food row was chosen. */
  let custom = false;
  /** A chosen food whose nutrients are still loading. */
  let loading: string | undefined;
  let choice = 0;

  // Custom food fields, values per 100 g or 100 ml.
  const cName = el("input", { id: "c-name", type: "text", placeholder: "e.g. Homemade muesli", maxlength: 80 });
  const cBasis = el("select", { id: "c-basis" }, el("option", { value: "g" }, "per 100 g"), el("option", { value: "ml" }, "per 100 ml"));
  const cEnergy = numberInput("c-energy", "0", "1");
  const cEnergyUnit = el("select", { id: "c-energy-unit" }, el("option", { value: "kj" }, "kJ"), el("option", { value: "kcal" }, "kcal"));
  const cProtein = numberInput("c-protein", "0", "0.1");
  const cCarbs = numberInput("c-carbs", "0", "0.1");
  const cFat = numberInput("c-fat", "0", "0.1");
  const customFields = el(
    "fieldset",
    { class: "custom", hidden: true },
    el("legend", {}, "Custom food (values per 100)"),
    field("Name", cName),
    el("div", { class: "row" }, field("Basis", cBasis), field("Energy", cEnergy), field("Unit", cEnergyUnit)),
    el("div", { class: "row" }, field("Protein (g)", cProtein), field("Carbs (g)", cCarbs), field("Fat (g)", cFat)),
  );

  const quantity = el("input", { id: "qty", type: "number", min: "0.01", step: "any", value: "1", required: true, inputmode: "decimal" });
  const unitSelect = el("select", { id: "unit", required: true });
  const now = new Date();
  const mealSelect = el(
    "select",
    { id: "meal" },
    ...MEAL_TYPES.map((m) => el("option", { value: m.value, selected: m.value === defaultMealType(now) }, m.label)),
  );
  const time = el("input", { id: "time", type: "datetime-local", value: toDateTimeLocalValue(now), required: true });
  const preview = el("p", { class: "preview", "aria-live": "polite" });
  const submit = el("button", { type: "submit", class: "primary" }, "Log entry");
  const status = el("p", { class: "status", role: "status" });

  const currentFood = (): FoodItem | undefined => {
    if (!custom) return chosen;
    const basis = cBasis.value as BaseUnit;
    const energy = Number(cEnergy.value) || 0;
    return {
      ref: { source: "manual", id: "custom" },
      name: cName.value.trim() || "Custom food",
      basis,
      per100: {
        energyKcal: cEnergyUnit.value === "kj" ? kjToKcal(energy) : energy,
        nutrients: { protein: Number(cProtein.value) || 0, carbohydrates: Number(cCarbs.value) || 0, fat: Number(cFat.value) || 0 },
      },
      portions: [],
    };
  };

  const refreshUnits = () => {
    const food = currentFood();
    if (!food) {
      replaceChildren(unitSelect);
      return;
    }
    const previous = unitSelect.value;
    const options = [
      ...food.portions.map((p) => el("option", { value: PORTION_PREFIX + p.name }, `× ${p.name}`)),
      ...selectableUnits(food).map((u) => el("option", { value: u.key }, u.label)),
    ];
    replaceChildren(unitSelect, ...options);
    if (options.some((o) => o.value === previous)) {
      unitSelect.value = previous;
    } else if (food.portions.length > 0) {
      // A portion is the natural default ("1 × can")...
      unitSelect.selectedIndex = 0;
      quantity.value = "1";
    } else {
      // ...otherwise 100 of the base unit.
      unitSelect.value = food.basis;
      quantity.value = "100";
    }
  };

  /** Why the entry cannot be logged as entered, if anything. */
  const validationError = (): string | undefined => {
    const q = Number(quantity.value);
    if (!quantity.value.trim() || !Number.isFinite(q) || q <= 0) return "Enter an amount greater than 0.";
    if (custom) {
      const values = [cEnergy, cProtein, cCarbs, cFat].map((i) => Number(i.value));
      if (values.some((v) => !Number.isFinite(v) || v < 0)) return "Custom food values must be numbers of 0 or more.";
    }
    return undefined;
  };

  const refreshPreview = () => {
    const food = currentFood();
    try {
      if (!food) throw new Error(loading ? `Loading ${loading}…` : "Search for a food, or choose “Custom food”.");
      const invalid = validationError();
      if (invalid) throw new Error(invalid);
      preview.textContent = `≈ ${summary(nutrientsForAmount(food, Number(quantity.value), unitSelect.value))}`;
      preview.classList.remove("error");
    } catch (e) {
      preview.textContent = errorMessage(e);
      preview.classList.add("error");
    }
  };

  // The time follows the clock until the user picks one, so a page left open logs at "now".
  let timeTouched = false;
  time.addEventListener("input", () => (timeTouched = true));

  const syncCustomFields = () => {
    customFields.hidden = !custom;
    // Disabled controls are skipped by form validation, so stale custom values can't block other foods.
    customFields.disabled = !custom;
  };

  const refreshAll = () => {
    syncCustomFields();
    refreshUnits();
    refreshPreview();
  };

  const combobox = createFoodCombobox(catalog, {
    id: "food",
    onChoose: (hit) => {
      const mine = ++choice;
      chosen = undefined;
      custom = false;
      loading = hit.summary.name;
      refreshAll();
      quantity.focus();
      catalog.get(hit.summary.ref).then(
        (food) => {
          if (mine !== choice) return; // the user moved on
          loading = undefined;
          chosen = food;
          if (!food) status.textContent = "That food is no longer in the catalogue. Search again.";
          refreshAll();
        },
        (e: unknown) => {
          if (mine !== choice) return;
          loading = undefined;
          log.error("Loading the chosen food failed", describeError(e));
          status.textContent = `Could not load ${hit.summary.name}: ${errorMessage(e)}`;
          status.classList.add("error");
          refreshAll();
        },
      );
    },
    onCustom: (query) => {
      choice++;
      chosen = undefined;
      loading = undefined;
      custom = true;
      if (query && !cName.value.trim()) cName.value = query;
      refreshAll();
      cName.focus();
    },
    onEdit: () => {
      choice++;
      chosen = undefined;
      loading = undefined;
      custom = false;
      refreshAll();
    },
  });
  customFields.addEventListener("input", () => {
    refreshUnits();
    refreshPreview();
  });
  for (const i of [quantity, unitSelect]) i.addEventListener("input", refreshPreview);

  const form = el(
    "form",
    { class: "card log-form", novalidate: false },
    el("h2", {}, "Log food"),
    el("div", { class: "field" }, el("span", {}, el("label", { for: "food" }, "Food")), combobox.element),
    customFields,
    el("div", { class: "row" }, field("Amount", quantity), field("Unit", unitSelect)),
    el("div", { class: "row" }, field("Meal", mealSelect), field("Time", time)),
    preview,
    el("div", { class: "actions" }, submit),
    status,
  );

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const food = currentFood();
    const when = timeTouched ? new Date(time.value) : new Date();
    const invalid = validationError() ?? (Number.isNaN(when.getTime()) ? "Enter a valid time." : undefined);
    if (!food || invalid) {
      status.textContent = invalid ?? (loading ? `Still loading ${loading}…` : "Search for a food first.");
      status.classList.add("error");
      return;
    }
    submit.disabled = true;
    status.textContent = "Saving to Google Health…";
    status.classList.remove("error");
    try {
      await onSubmit({ food, quantity: Number(quantity.value), unit: unitSelect.value, mealType: mealSelect.value as MealType, time: when });
      status.textContent = `Logged ${food.name}.`;
      timeTouched = false;
      time.value = toDateTimeLocalValue(new Date());
    } catch (e) {
      status.textContent = errorMessage(e);
      status.classList.add("error");
    } finally {
      submit.disabled = false;
    }
  });

  syncCustomFields();
  refreshUnits();
  refreshPreview();
  return form;
}

function numberInput(id: string, min: string, step: string): HTMLInputElement {
  return el("input", { id, type: "number", min, step, value: "0", inputmode: "decimal" });
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { class: "field", for: control.id }, el("span", {}, label), control);
}
