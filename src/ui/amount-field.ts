import type { AmountInterpreter } from "../ai/amount-ai";
import { worthAsking } from "../core/amount-answer";
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
  /** The food's portions are still loading, so a word may yet turn out to be one. */
  readonly isPending?: () => boolean;
  /** Tries to read what the rules could not. Its answer only fills the fields: logging it takes another Enter. */
  readonly interpreter?: AmountInterpreter;
}

export interface AmountField {
  readonly input: HTMLInputElement;
  readonly unitSelect: HTMLSelectElement;
  /** Says when a model is reading the amount, and when it has. The form places it. */
  readonly note: HTMLElement;
  /** With no food yet, or while a model reads the text, this is "typing". */
  read(): AmountRead;
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
  /** Stops anything still running, when the field goes away. */
  dispose(): void;
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
  const note = el("p", { class: "amount-note", role: "status", hidden: true });

  let food: Measurable | undefined;
  /** What the dropdown shows. Setting a select's value does not fire its events, so this is the record of what the number is in. */
  let unit = "";
  /** The user changed the text since it was last filled in. */
  let typed = false;
  /** The user finished typing, so an unfinished text is now simply wrong. */
  let settled = false;
  /** A model is reading the text. */
  let asking: AbortController | undefined;
  /** What the model was last asked, so that leaving the field twice does not ask twice. */
  let asked = "";

  const showUnit = (next: string) => {
    unit = next;
    if (next) unitSelect.querySelector('option[value=""]')?.remove();
    unitSelect.value = next;
  };

  const showNote = (text: string) => {
    note.textContent = text;
    note.hidden = !text;
  };

  const stopAsking = () => {
    asking?.abort();
    asking = undefined;
    showNote("");
  };

  /** Only for text the user has finished, once the rules have refused it and the food's units are all known. */
  const askModel = () => {
    const { interpreter } = options;
    if (!food || !interpreter?.isOn() || options.isPending?.() || asking) return;
    const text = input.value;
    if (!worthAsking(text, food)) return;
    const question = `${text}\n${[...unitSelect.options].map((o) => o.value).join()}`;
    if (question === asked) return;
    asked = question;
    const mine = (asking = new AbortController());
    showNote("Reading this with on-device AI…");
    void interpreter.interpret(text, food, mine.signal).then((answer) => {
      if (mine !== asking) return; // The user has moved on.
      asking = undefined;
      showNote("");
      // A model that was slow to wake up may do better next time. One that was refused would only be refused again.
      if (answer !== "refused") asked = "";
      if (answer !== "refused" && answer !== "no-answer") {
        input.value = String(answer.quantity);
        if (answer.unit) showUnit(answer.unit);
        showNote("Read by on-device AI. Check the amount and unit.");
      }
      options.onChange();
    });
  };

  const settle = () => {
    settled = true;
    if (!food) return;
    const next = settledAmount({ text: input.value, unit }, food);
    if (next.text !== input.value) input.value = next.text;
    if (next.unit !== unit) showUnit(next.unit);
    askModel();
    options.onChange();
  };

  input.addEventListener("input", () => {
    typed = true;
    settled = false;
    stopAsking();
    options.onChange();
  });
  input.addEventListener("blur", settle);

  // A unit picked by hand wins over a typed one, and settles a choice between several of them.
  unitSelect.addEventListener("input", () => {
    const from = unit;
    const to = unitSelect.value;
    stopAsking();
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
    note,
    read: () => (food && !asking ? readAmount(input.value, unit, food, { settled, pending: options.isPending?.() ?? false }) : { state: "typing" }),
    settle,
    set(text, nextUnit) {
      input.value = text;
      unit = nextUnit;
      typed = false;
      settled = false;
    },
    clear() {
      stopAsking();
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
      stopAsking();
      food = undefined;
      unit = "";
      replaceChildren(unitSelect);
    },
    forgetTyping() {
      typed = false;
      showNote("");
    },
    dispose: stopAsking,
  };
}
