import type { FoodItem } from "../core/food";
import { convertQuantity } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { basicMeasure, canConvertLogged, editedNutritionLogPoint, isLoggedAmount, loggedAmount, mealLabel, MEAL_TYPES, toDiaryEntry, type AmountEdit, type DiaryEntry, type EntryEdit, type LoggedAmount } from "../health/mapping";
import type { MealType } from "../health/types";
import { el, errorMessage, replaceChildren } from "./dom";
import { field, unitOptions } from "./form-fields";
import { fmtTime, summary } from "./format";

const log = logger("edit");

export interface EditDialog {
  readonly element: HTMLDialogElement;
  open(entry: DiaryEntry, unitNames: ReadonlyMap<string, string>): void;
  close(): void;
  /** Blocks saving while the browser is offline; what the user entered stays in the form. */
  setOffline(offline: boolean): void;
}

/**
 * Changes the amount and meal of a diary entry (DR-22). A dialog rather than editing in the table,
 * because refreshes redraw the table and on a phone it scrolls sideways.
 */
export function createEditDialog(
  catalog: FoodCatalog,
  /** Resolves once the new entry is saved, and the caller closes the dialog. If it rejects, the dialog stays open and shows why. */
  onSave: (entry: DiaryEntry, edit: EntryEdit) => Promise<void>,
  onClosed: () => void,
): EditDialog {
  let entry: DiaryEntry | undefined;
  let logged: LoggedAmount | undefined;
  let unitNames: ReadonlyMap<string, string> = new Map();
  /** The food's record, once found and only if it can convert the logged amount. */
  let food: FoodItem | undefined;
  let lookingUp = false;
  let lookup: AbortController | undefined;
  let saving = false;
  let offline = false;
  /** The unit the number in the amount field is in. */
  let shownUnit = "";

  const title = el("p", { class: "edit-food" });
  const quantity = el("input", { id: "edit-qty", type: "number", min: "0.01", step: "any", required: true, inputmode: "decimal" });
  const unitSelect = el("select", { id: "edit-unit", required: true });
  const mealSelect = el("select", { id: "edit-meal" });
  const preview = el("p", { class: "preview", "aria-live": "polite" });
  const save = el("button", { type: "submit", class: "primary" }, "Save");
  const cancel = el("button", { type: "button", onclick: () => element.close() }, "Cancel");
  const status = el("p", { class: "status error", role: "status" });
  const amountFields = el("div", { class: "row" }, field("Amount", quantity), field("Unit", unitSelect));
  const noAmount = el("p", { class: "hint", hidden: true }, "This entry has no amount that can be changed, so only its meal can.");

  const measure = () => food ?? basicMeasure(logged!.unit);

  /** Throws with the reason the form cannot be saved as entered. Undefined when the amount stays as logged. */
  const amountEdit = (): AmountEdit | undefined => {
    if (!logged) return undefined;
    const q = Number(quantity.value);
    if (!quantity.value.trim() || !Number.isFinite(q) || q <= 0) throw new Error("Enter an amount greater than 0.");
    if (isLoggedAmount(logged, measure(), q, unitSelect.value)) return undefined;
    return { quantity: q, unit: unitSelect.value, ...(food ? { food } : {}) };
  };

  const chosenMeal = (): MealType | undefined => (mealSelect.value ? (mealSelect.value as MealType) : undefined);
  const currentMeal = (e: DiaryEntry): MealType | undefined => (e.mealType === "MEAL_TYPE_UNSPECIFIED" ? undefined : e.mealType);

  /** Shows what would be saved, and whether it can be. */
  const refresh = () => {
    const nutritionLog = entry?.point.nutritionLog;
    if (!entry || !nutritionLog) return;
    let blocked = true;
    try {
      const amount = amountEdit();
      if (amount && lookingUp) {
        // The food's record gives the exact values, so an amount waits for the answer.
        preview.textContent = `Loading ${entry.displayName}…`;
      } else {
        const mealType = chosenMeal();
        const point = editedNutritionLogPoint(nutritionLog, { ...(mealType ? { mealType } : {}), ...(amount ? { amount } : {}) }, { id: "preview", unitNames });
        preview.textContent = `≈ ${summary(toDiaryEntry(point)!.profile)}`;
        blocked = !amount && mealType === currentMeal(entry);
      }
      preview.classList.remove("error");
    } catch (e) {
      preview.textContent = errorMessage(e);
      preview.classList.add("error");
    }
    save.disabled = blocked || saving || offline;
    save.classList.toggle("saving", saving);
    // A write under way cannot be called back, and closing would hide why it failed.
    cancel.disabled = saving;
  };

  const showUnits = () => {
    if (!logged) return;
    replaceChildren(unitSelect, ...unitOptions(measure()));
    unitSelect.value = shownUnit;
  };

  /** Basic units work straight away. The food only adds to them, so a failed lookup costs its portions and exact values. */
  const lookUpFood = (e: DiaryEntry) => {
    if (!logged || !e.ref || e.ref.source === "manual") return;
    const mine = (lookup = new AbortController());
    lookingUp = true;
    catalog
      .get(e.ref, { signal: mine.signal })
      .then(
        (found) => {
          // A lookup that ignored its abort must not hand this food to the next entry opened.
          if (mine === lookup && found && logged && canConvertLogged(found, logged)) food = found;
        },
        (error: unknown) => {
          if (!mine.signal.aborted) log.warn("Could not load the food; scaling the logged values instead", { ref: e.ref, error: describeError(error) });
        },
      )
      .finally(() => {
        if (mine !== lookup) return;
        lookingUp = false;
        showUnits();
        refresh();
      });
  };

  const form = el(
    "form",
    {},
    el("h2", {}, "Edit entry"),
    title,
    amountFields,
    noAmount,
    field("Meal", mealSelect),
    preview,
    el("div", { class: "actions" }, save, cancel),
    status,
  );
  const element = el("dialog", { class: "edit-dialog", "aria-labelledby": "edit-title" }, form);
  form.querySelector("h2")!.id = "edit-title";

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
      // The food cannot convert to this unit: the preview says why.
    }
    shownUnit = unitSelect.value;
    refresh();
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!entry || save.disabled) return;
    const amount = amountEdit();
    const mealType = chosenMeal();
    saving = true;
    status.textContent = "";
    refresh();
    try {
      await onSave(entry, { ...(mealType ? { mealType } : {}), ...(amount ? { amount } : {}) });
    } catch (e) {
      status.textContent = errorMessage(e);
    } finally {
      saving = false;
      refresh();
    }
  });

  // Likewise Escape waits for the write's answer.
  element.addEventListener("cancel", (ev) => {
    if (saving) ev.preventDefault();
  });
  element.addEventListener("close", () => {
    lookup?.abort();
    lookup = undefined;
    entry = undefined;
    onClosed();
  });

  return {
    element,
    open(next, names) {
      if (element.open) return;
      entry = next;
      unitNames = names;
      logged = next.point.nutritionLog && loggedAmount(next.point.nutritionLog, names);
      food = undefined;
      lookingUp = false;
      status.textContent = "";
      title.replaceChildren(next.displayName, el("span", {}, ` · ${fmtTime(next.start)}`));

      amountFields.hidden = !logged;
      noAmount.hidden = Boolean(logged);
      quantity.required = Boolean(logged);
      unitSelect.required = Boolean(logged);
      if (logged) {
        shownUnit = logged.unit;
        quantity.value = String(logged.amount);
        showUnits();
      }

      const meal = currentMeal(next);
      replaceChildren(
        mealSelect,
        el("option", { value: "" }, "No meal"),
        ...MEAL_TYPES.map((m) => el("option", { value: m.value }, m.label)),
        // A meal the form does not offer, such as the legacy ANYTIME, stays until the user changes it.
        meal && !MEAL_TYPES.some((m) => m.value === meal) && el("option", { value: meal }, mealLabel(meal)),
      );
      mealSelect.value = meal ?? "";

      lookUpFood(next);
      refresh();
      element.showModal();
    },
    close() {
      if (element.open) element.close();
    },
    setOffline(value) {
      offline = value;
      refresh();
    },
  };
}
