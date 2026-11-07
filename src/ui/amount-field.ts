import { amountForFood, readAmount, readAmountText, settledAmount, typedQuantity, type AmountRead, type ShownAmount } from "../core/amount-text";
import type { Measurable } from "../core/units";
import { el, replaceChildren } from "./dom";
import { unitOptions } from "./form-fields";

export interface AmountFieldOptions {
  readonly id: string;
  readonly unitId: string;
  readonly placeholder?: string;
  readonly label?: string;
  readonly unitLabel?: string;
  /** Called after anything that can change what `read` returns. */
  readonly onChange: () => void;
  /** Keeps the amount the same when a unit is picked by hand. Without it, the number stays as it is. May throw if it cannot convert. */
  readonly convert?: (quantity: number, from: string, to: string) => number;
}

export interface AmountField {
  readonly input: HTMLInputElement;
  readonly unitSelect: HTMLSelectElement;
  /** `pending` while a food's portions may still arrive. With no food yet, this is always "typing". */
  read(pending?: boolean): AmountRead;
  /** The user has finished: moves a typed unit to its field. */
  settle(): void;
  set(text: string, unit: string): void;
  /** Starts again with no amount and no unit, for a new food. */
  clear(): void;
  /** The food's units have arrived or changed. `fill` is what an untouched field starts as. */
  show(food: Measurable, fill: (food: Measurable) => ShownAmount): void;
  /** Takes the units away, keeping what was typed. */
  hideUnits(): void;
  /** What is showing no longer counts as typed by the user: the entry it was typed for is logged. */
  forgetTyping(): void;
}

/**
 * A free-text amount and its unit dropdown (DR-25). The text is read as it is typed, and on leaving the field its unit
 * moves to the dropdown. A unit is only ever chosen by the user, by typing it or picking it, or by showing it before
 * they typed: a bare number never gets one afterwards.
 */
export function createAmountField(options: AmountFieldOptions): AmountField {
  const input = el("input", { id: options.id, type: "text", autocomplete: "off", spellcheck: "false", placeholder: options.placeholder, "aria-label": options.label });
  const unitSelect = el("select", { id: options.unitId, "aria-label": options.unitLabel });
  const blankOption = () => el("option", { value: "" }, "Choose unit");

  let food: Measurable | undefined;
  /** What the dropdown shows. Setting a select's value does not fire its events, so this is the record of what the number is in. */
  let unit = "";
  /** The user changed the text since it was last filled in. */
  let typed = false;
  /** The user finished typing, so an unfinished text is now simply wrong. */
  let settled = false;

  const showUnit = (next: string) => {
    unit = next;
    if (next) unitSelect.querySelector('option[value=""]')?.remove();
    unitSelect.value = next;
  };

  const settle = () => {
    settled = true;
    if (!food) return;
    const next = settledAmount({ text: input.value, unit }, food);
    if (next.text !== input.value) input.value = next.text;
    if (next.unit !== unit) showUnit(next.unit);
    options.onChange();
  };

  input.addEventListener("input", () => {
    typed = true;
    settled = false;
    options.onChange();
  });
  input.addEventListener("blur", settle);

  // A unit picked by hand wins over a typed one, and settles a choice between several of them.
  unitSelect.addEventListener("input", () => {
    const from = unit;
    const to = unitSelect.value;
    if (food) {
      const reading = readAmountText(input.value, food);
      const named = typedQuantity(reading);
      if (named !== undefined) input.value = String(named);
      else if (reading.kind === "amount" && options.convert && from) {
        try {
          input.value = String(options.convert(reading.quantity, from, to));
        } catch {
          // The food cannot convert to this unit: the form says why.
        }
      }
    }
    showUnit(to);
    options.onChange();
  });

  return {
    input,
    unitSelect,
    read: (pending = false) => (food ? readAmount(input.value, unit, food, { settled, pending }) : { state: "typing" }),
    settle,
    set(text, nextUnit) {
      input.value = text;
      unit = nextUnit;
      typed = false;
      settled = false;
    },
    clear() {
      input.value = "";
      typed = false;
      settled = false;
      food = undefined;
      unit = "";
      replaceChildren(unitSelect);
    },
    show(nextFood, fill) {
      food = nextFood;
      const next = amountForFood(nextFood, { text: input.value, unit }, typed, fill);
      replaceChildren(unitSelect, !next.unit && blankOption(), unitOptions(nextFood));
      input.value = next.text;
      showUnit(next.unit);
      const focused = document.activeElement === input;
      // A default filled in under the cursor must be replaced by typing, not added to.
      if (!typed && focused) input.select();
      if (typed && !focused) settle();
    },
    hideUnits() {
      food = undefined;
      unit = "";
      replaceChildren(unitSelect);
    },
    forgetTyping() {
      typed = false;
    },
  };
}
