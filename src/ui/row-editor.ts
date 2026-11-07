import type { FoodItem } from "../core/food";
import { convertQuantity } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { basicMeasure, canConvertLogged, editedNutritionLogPoint, isLoggedAmount, loggedAmount, mealLabel, MEAL_TYPES, toDiaryEntry, type AmountEdit, type DiaryEntry, type EntryEdit } from "../health/mapping";
import type { MealType } from "../health/types";
import { el, errorMessage, replaceChildren } from "./dom";
import { unitOptions } from "./form-fields";
import { fmtEnergy, fmtGrams, summary } from "./format";

const log = logger("edit");

export interface RowEditorOptions {
  readonly catalog: FoodCatalog;
  readonly entry: DiaryEntry;
  readonly unitNames: ReadonlyMap<string, string>;
  readonly offline: boolean;
  readonly onSave: (edit: EntryEdit) => void;
  readonly onCancel: () => void;
}

/** The controls that replace a diary row's contents while it is edited (DR-22). The table puts them in its cells. */
export interface RowEditor {
  /** The entry's ID. */
  readonly id: string;
  readonly meal: HTMLElement;
  readonly amount: HTMLElement;
  readonly energy: HTMLElement;
  readonly protein: HTMLElement;
  readonly carbs: HTMLElement;
  readonly fat: HTMLElement;
  /** Save and Cancel, where the edit and delete buttons were. */
  readonly actions: HTMLElement;
  focus(): void;
  focusSave(): void;
  /** Shows the values again, after the energy unit changes. */
  refresh(): void;
  /** Blocks saving while the browser is offline; what the user entered stays. */
  setOffline(offline: boolean): void;
  setSaving(saving: boolean): void;
  dispose(): void;
}

export function createRowEditor({ catalog, entry, unitNames, offline: startOffline, onSave, onCancel }: RowEditorOptions): RowEditor {
  const nutritionLog = entry.point.nutritionLog!;
  const logged = loggedAmount(nutritionLog, unitNames);
  /** The food's record, once found. If the entry states an amount, only if the food can convert it. */
  let food: FoodItem | undefined;
  let lookingUp = false;
  const lookup = new AbortController();
  let saving = false;
  let offline = startOffline;
  /** The unit the number in the amount field is in. */
  let shownUnit: string = logged?.unit ?? "";
  const meal0: MealType | undefined = entry.mealType === "MEAL_TYPE_UNSPECIFIED" ? undefined : entry.mealType;

  const quantity = el("input", { id: "edit-qty", type: "number", min: "0.01", step: "any", inputmode: "decimal", placeholder: "Amount", "aria-label": `Amount of ${entry.displayName}` });
  const unitSelect = el("select", { id: "edit-unit", "aria-label": `Unit for ${entry.displayName}` });
  const fields = el("div", { class: "amount-edit" }, quantity, unitSelect);
  const fixedAmount = el("span", {}, entry.amount ?? "–");
  const problem = el("div", { class: "edit-error", hidden: true });
  const amountCell = el("div", {}, fixedAmount, fields, problem);

  const mealSelect = el(
    "select",
    { id: "edit-meal", "aria-label": `Meal for ${entry.displayName}` },
    el("option", { value: "" }, "No meal"),
    ...MEAL_TYPES.map((m) => el("option", { value: m.value }, m.label)),
    // A meal the form does not offer, such as the legacy ANYTIME, stays until the user changes it.
    meal0 && !MEAL_TYPES.some((m) => m.value === meal0) && el("option", { value: meal0 }, mealLabel(meal0)),
  );
  mealSelect.value = meal0 ?? "";

  const energy = el("span");
  const protein = el("span");
  const carbs = el("span");
  const fat = el("span");
  // The cells say this by changing; a screen reader needs it said.
  const announce = el("span", { class: "visually-hidden", role: "status" });

  const save = el("button", { type: "button", class: "icon save", title: "Save changes", "aria-label": `Save changes to ${entry.displayName}`, onclick: () => submit() }, "✓︎");
  const cancel = el("button", { type: "button", class: "icon", title: "Cancel", "aria-label": `Cancel editing ${entry.displayName}`, onclick: () => onCancel() }, "✕");
  const actions = el("div", { class: "row-actions" }, save, cancel, announce);

  const canEditAmount = () => Boolean(logged || food);
  const measure = () => food ?? basicMeasure(logged!.unit);

  /** Throws with the reason the amount can't be used. Undefined when the amount stays as logged. */
  const amountEdit = (): AmountEdit | undefined => {
    if (!canEditAmount()) return undefined;
    // With no amount stated, an empty field means the user is only changing the meal.
    if (!logged && !quantity.value.trim()) return undefined;
    const q = Number(quantity.value);
    if (!quantity.value.trim() || !Number.isFinite(q) || q <= 0) throw new Error("Enter an amount greater than 0.");
    if (logged && isLoggedAmount(logged, measure(), q, unitSelect.value)) return undefined;
    return { quantity: q, unit: unitSelect.value, ...(food ? { food } : {}) };
  };

  const chosenMeal = (): MealType | undefined => (mealSelect.value ? (mealSelect.value as MealType) : undefined);

  const currentEdit = (): EntryEdit => {
    const mealType = chosenMeal();
    const amount = amountEdit();
    return { ...(mealType ? { mealType } : {}), ...(amount ? { amount } : {}) };
  };

  /** Shows what would be saved in the row's own cells, and whether it can be saved. */
  const refresh = () => {
    let blocked = true;
    let error = "";
    let waiting = false;
    let shown = undefined as ReturnType<typeof toDiaryEntry>;
    try {
      const edit = currentEdit();
      // The food's record gives the exact values, so a new amount waits for the answer.
      waiting = Boolean(edit.amount && lookingUp);
      if (!waiting) {
        shown = toDiaryEntry(editedNutritionLogPoint(nutritionLog, edit, { id: "preview", unitNames }));
        blocked = !edit.amount && chosenMeal() === meal0;
      }
    } catch (e) {
      error = errorMessage(e);
    }
    const blank = waiting ? "…" : "–";
    energy.textContent = shown ? fmtEnergy(shown.profile.energyKcal) : blank;
    protein.textContent = shown ? fmtGrams(shown.profile.nutrients.protein) : blank;
    carbs.textContent = shown ? fmtGrams(shown.profile.nutrients.carbohydrates) : blank;
    fat.textContent = shown ? fmtGrams(shown.profile.nutrients.fat) : blank;
    problem.textContent = error;
    problem.hidden = !error;
    announce.textContent = error || (shown ? summary(shown.profile) : "");
    quantity.setAttribute("aria-invalid", String(Boolean(error)));
    const editable = canEditAmount();
    fixedAmount.hidden = editable;
    fields.hidden = !editable;
    save.disabled = blocked || saving || offline;
    cancel.disabled = saving;
    quantity.disabled = saving;
    unitSelect.disabled = saving;
    mealSelect.disabled = saving;
  };

  const showUnits = () => {
    if (!canEditAmount()) return;
    // No amount stated: start from the food's own unit, with the field empty.
    if (!shownUnit) shownUnit = food!.basis;
    replaceChildren(unitSelect, ...unitOptions(measure()));
    unitSelect.value = shownUnit;
  };

  function submit() {
    if (save.disabled) return;
    onSave(currentEdit());
  }

  quantity.addEventListener("input", refresh);
  mealSelect.addEventListener("input", refresh);
  // The same amount in the new unit, so that the nutrients do not jump: 375 ml becomes 1 × can.
  unitSelect.addEventListener("input", () => {
    const q = Number(quantity.value);
    try {
      if (q > 0) {
        // Back in the logged unit, the logged number, or the rounding on the way would count as an edit: 40 g, 1.41 oz, 39.97 g.
        const backToLogged = logged && unitSelect.value === logged.unit && isLoggedAmount(logged, measure(), q, shownUnit);
        quantity.value = String(backToLogged ? logged.amount : convertQuantity(measure(), q, shownUnit, unitSelect.value));
      }
    } catch {
      // The food cannot convert to this unit: the row says why.
    }
    shownUnit = unitSelect.value;
    refresh();
  });

  for (const control of [mealSelect, amountCell, actions]) {
    control.addEventListener("keydown", (ev) => {
      const { key, target } = ev as KeyboardEvent;
      if (key === "Escape" && !saving) onCancel();
      if (key === "Enter" && target === quantity) submit();
    });
  }

  if (logged) {
    quantity.value = String(logged.amount);
    showUnits();
  } else {
    log.warn("This entry states no amount in g or ml; it can change only if its food is found", { serving: nutritionLog.serving, name: entry.displayName, ref: entry.ref });
  }

  // Basic units work straight away. The food only adds to them, so a failed lookup costs its portions and exact values.
  if (entry.ref && entry.ref.source !== "manual") {
    lookingUp = true;
    catalog
      .get(entry.ref, { signal: lookup.signal })
      .then(
        (found) => {
          if (found && (!logged || canConvertLogged(found, logged))) food = found;
        },
        (error: unknown) => {
          if (!lookup.signal.aborted) log.warn("Could not load the food; scaling the logged values instead", { ref: entry.ref, error: describeError(error) });
        },
      )
      .finally(() => {
        if (lookup.signal.aborted) return;
        lookingUp = false;
        showUnits();
        refresh();
      });
  }

  refresh();

  return {
    id: entry.id,
    meal: mealSelect,
    amount: amountCell,
    energy,
    protein,
    carbs,
    fat,
    actions,
    focus() {
      const target = canEditAmount() ? quantity : mealSelect;
      target.focus();
      if (target === quantity) quantity.select();
    },
    focusSave() {
      save.focus();
    },
    refresh,
    setOffline(value) {
      offline = value;
      refresh();
    },
    setSaving(value) {
      saving = value;
      refresh();
    },
    dispose() {
      lookup.abort();
    },
  };
}
