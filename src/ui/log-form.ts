import { foodLabel, nutrientsForAmount, type FoodItem } from "../core/food";
import { kjToKcal } from "../core/nutrients";
import { toDateTimeLocalValue } from "../core/time";
import { PORTION_PREFIX, selectableUnits, type BaseUnit } from "../core/units";
import { defaultMealType, MEAL_TYPES, type LogDraft } from "../health/mapping";
import type { MealType } from "../health/types";
import { el, errorMessage, replaceChildren } from "./dom";
import { summary } from "./format";

const CUSTOM = "__custom__";

/**
 * Form for one diary entry. Foods come from the sample catalogue (shaped like
 * Open Food Facts records) or a custom food typed in per 100 g / 100 ml.
 */
export function createLogForm(foods: readonly FoodItem[], onSubmit: (draft: LogDraft) => Promise<void>): HTMLElement {
  const foodSelect = el(
    "select",
    { id: "food", required: true },
    ...foods.map((f, i) => el("option", { value: String(i) }, foodLabel(f))),
    el("option", { value: CUSTOM }, "Custom food…"),
  );

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

  const quantity = el("input", { id: "qty", type: "number", min: "0", step: "any", value: "1", required: true, inputmode: "decimal" });
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
    if (foodSelect.value !== CUSTOM) return foods[Number(foodSelect.value)];
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
    if (!food) return;
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

  const refreshPreview = () => {
    const food = currentFood();
    try {
      if (!food) throw new Error("Pick a food");
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

  foodSelect.addEventListener("change", () => {
    customFields.hidden = foodSelect.value !== CUSTOM;
    refreshUnits();
    refreshPreview();
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
    field("Food", foodSelect),
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
    if (!food || Number.isNaN(when.getTime())) return;
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
