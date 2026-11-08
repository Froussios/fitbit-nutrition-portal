import { amountAi } from "../ai/amount-ai";
import { canReload, type FoodItem } from "../core/food";
import { convertQuantity, type Measurable } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { AS_LOGGED_UNIT, asLoggedMeasure, basicMeasure, canConvertLogged, editedNutritionLogPoint, isLoggedAmount, loggedAmount, mealLabel, MEAL_TYPES, toDiaryEntry, type AmountEdit, type DiaryEntry, type EntryEdit } from "../health/mapping";
import type { MealType } from "../health/types";
import { createAmountField } from "./amount-field";
import { el, errorMessage } from "./dom";
import { fmtEnergy, fmtGrams, summary } from "./format";

const log = logger("edit");

/** The amount cannot be used yet, and it is too early to call it wrong. */
class StillTyping extends Error {}

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
  /** With no amount to read and no food, the amount is a multiple of the entry as logged, so it can always change. */
  const asLogged = asLoggedMeasure();
  /** The user has typed in the amount or picked a unit, so a food that arrives later must not replace what they chose. */
  let touched = false;
  let lookingUp = false;
  const lookup = new AbortController();
  let saving = false;
  let offline = startOffline;
  const meal0: MealType | undefined = entry.mealType === "MEAL_TYPE_UNSPECIFIED" ? undefined : entry.mealType;

  const amountField = createAmountField({
    id: "edit-qty",
    unitId: "edit-unit",
    placeholder: "Amount",
    label: `Amount of ${entry.displayName}`,
    unitLabel: `Unit for ${entry.displayName}`,
    onChange: () => refresh(),
    isPending: () => lookingUp,
    interpreter: amountAi,
    // The same amount in the new unit, so that the nutrients do not jump: 375 ml becomes 1 × can.
    convert: (q, from, to) => {
      // Back in the logged unit, the logged number, or the rounding on the way would count as an edit: 40 g, 1.41 oz, 39.97 g.
      const backToLogged = logged && to === logged.unit && isLoggedAmount(logged, measure(), q, from);
      return backToLogged ? logged.amount : convertQuantity(measure(), q, from, to);
    },
  });
  const quantity = amountField.input;
  const unitSelect = amountField.unitSelect;
  const fields = el("div", { class: "amount-edit" }, quantity, unitSelect);
  const problem = el("div", { class: "edit-error", hidden: true });
  const amountCell = el("div", {}, fields, amountField.note, problem);

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

  // Words, not icons: Cancel must never look like the delete button it replaces.
  const save = el("button", { type: "button", class: "primary edit-save", "aria-label": `Save changes to ${entry.displayName}`, onclick: () => submit() }, "Save");
  const cancel = el("button", { type: "button", class: "link edit-cancel", "aria-label": `Cancel editing ${entry.displayName}`, onclick: () => onCancel() }, "Cancel");
  const actions = el("div", { class: "row-actions" }, save, cancel, announce);

  const measure = (): Measurable => food ?? (logged ? basicMeasure(logged.unit) : asLogged);

  /** Throws with the reason the amount can't be used. Undefined when the amount stays as logged. */
  const amountEdit = (): AmountEdit | undefined => {
    // No amount was stated, so an empty field means the user is only changing the meal.
    if (!logged && !quantity.value.trim()) return undefined;
    const read = amountField.read();
    if (read.state === "typing") throw new StillTyping();
    if (read.state === "problem") throw new Error(read.message);
    if (logged && isLoggedAmount(logged, measure(), read.quantity, read.unit)) return undefined;
    if (read.unit === AS_LOGGED_UNIT && read.quantity === 1) return undefined;
    return { quantity: read.quantity, unit: read.unit, ...(food ? { food } : {}) };
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
      if (e instanceof StillTyping) waiting = true;
      else error = errorMessage(e);
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
    save.disabled = blocked || saving || offline;
    cancel.disabled = saving;
    quantity.disabled = saving;
    unitSelect.disabled = saving;
    mealSelect.disabled = saving;
  };

  /** An entry that stated no amount starts from its food's own unit with the field empty, so nothing changes until the user types. */
  const showUnits = () => amountField.show(measure(), (m) => ({ text: logged ? quantity.value : "", unit: m.basis }));

  function submit() {
    // Enter leaves the focus in the field, so the typed unit has not moved yet.
    amountField.settle();
    if (save.disabled) return;
    onSave(currentEdit());
  }

  mealSelect.addEventListener("input", refresh);
  quantity.addEventListener("input", () => (touched = true));
  unitSelect.addEventListener("input", () => (touched = true));

  for (const control of [mealSelect, amountCell, actions]) {
    control.addEventListener("keydown", (ev) => {
      const { key, target } = ev as KeyboardEvent;
      // On a dropdown, Escape may be closing its list, which must not discard what was typed.
      if (key === "Escape" && !saving && !(target instanceof HTMLSelectElement)) onCancel();
      if (key === "Enter" && target === quantity) submit();
    });
  }

  if (logged) {
    amountField.set(String(logged.amount), logged.unit);
  } else {
    amountField.set("1", AS_LOGGED_UNIT);
    log.warn("This entry states no amount in g or ml, so its amount is offered as a multiple of the entry unless its food is found", { id: entry.id, serving: nutritionLog.serving, name: entry.displayName, ref: entry.ref });
  }
  showUnits();

  // Basic units work straight away. The food only adds to them, so a failed lookup costs its portions and exact values.
  if (entry.ref && canReload(entry.ref.source)) {
    lookingUp = true;
    catalog
      .get(entry.ref, { signal: lookup.signal })
      .then(
        (found) => {
          if (!found || (logged && !canConvertLogged(found, logged))) return;
          // Once the user has typed a multiple of the entry, it stays: switching units would throw away what they typed.
          if (!logged && touched) return;
          food = found;
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
      quantity.focus();
      quantity.select();
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
      amountField.dispose();
    },
  };
}
