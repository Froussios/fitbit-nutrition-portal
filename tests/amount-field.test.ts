// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAmount } from "../src/core/amount-text";
import { PORTION_PREFIX, type Measurable } from "../src/core/units";
import { createAmountField, type AmountField, type AmountFieldOptions } from "../src/ui/amount-field";

const CUP = `${PORTION_PREFIX}1 cup`;
const SLICE = `${PORTION_PREFIX}1 slice`;
const flour: Measurable = {
  basis: "g",
  portions: [
    { name: "1 cup", amount: 125, unit: "g" },
    { name: "1 slice", amount: 30, unit: "g" },
  ],
};
const carrot: Measurable = {
  basis: "g",
  portions: [
    { name: "1 cup, diced", amount: 130, unit: "g" },
    { name: "1 cup, sliced", amount: 120, unit: "g" },
  ],
};

function setUp(options: Partial<AmountFieldOptions> = {}): { field: AmountField; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const field = createAmountField({ id: "qty", unitId: "unit", onChange, ...options });
  document.body.replaceChildren(field.input, field.unitSelect);
  return { field, onChange };
}

function type(field: AmountField, text: string) {
  field.input.focus();
  field.input.value = text;
  field.input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pick(field: AmountField, unit: string) {
  field.unitSelect.value = unit;
  field.unitSelect.dispatchEvent(new Event("input", { bubbles: true }));
}

const shown = (field: AmountField) => [field.input.value, field.unitSelect.value];
const options = (field: AmountField) => [...field.unitSelect.options].map((o) => o.value);

beforeEach(() => document.body.replaceChildren());

describe("a bare number and the unit showing", () => {
  it("uses a unit that was showing before it was typed", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    expect(shown(field)).toEqual(["1", CUP]);
    type(field, "90");
    expect(field.read()).toEqual({ state: "ok", quantity: 90, unit: CUP });
  });

  it("gets no unit from a food that loads afterwards", () => {
    const { field } = setUp();
    field.clear();
    type(field, "90");
    expect(field.read()).toEqual({ state: "typing" });

    field.show(flour, defaultAmount);

    expect(shown(field)).toEqual(["90", ""]);
    expect(field.unitSelect.selectedOptions[0]?.textContent).toBe("Choose unit");
    expect(field.read()).toMatchObject({ state: "problem", inUnit: true });

    field.settle();
    expect(shown(field)).toEqual(["90", ""]);
    expect(field.read()).toMatchObject({ state: "problem", inUnit: true });
  });

  it("logs once the user picks, and the blank choice goes away", () => {
    const { field } = setUp();
    field.clear();
    type(field, "90");
    field.show(flour, defaultAmount);

    pick(field, "g");

    expect(field.read()).toEqual({ state: "ok", quantity: 90, unit: "g" });
    expect(options(field)).not.toContain("");
  });

  it("loses a unit the new food cannot use, rather than getting another", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    pick(field, "g");
    type(field, "90");

    field.show({ basis: "ml", portions: [] }, defaultAmount);

    expect(shown(field)).toEqual(["90", ""]);
  });
});

describe("a unit typed before the units arrive", () => {
  it("applies while the field still has the focus, leaving the text alone", () => {
    const { field } = setUp();
    field.clear();
    type(field, "90 g");
    field.show(flour, defaultAmount);
    expect(shown(field)).toEqual(["90 g", "g"]);
    expect(field.read()).toEqual({ state: "ok", quantity: 90, unit: "g" });
  });

  it("settles when the field has lost the focus", () => {
    const { field } = setUp();
    field.clear();
    type(field, "2 slices");
    field.input.blur();
    field.show(flour, defaultAmount);
    expect(shown(field)).toEqual(["2", SLICE]);
  });
});

describe("an untouched field", () => {
  it("takes the food's default", () => {
    const { field } = setUp();
    field.clear();
    field.show({ basis: "g", portions: [] }, defaultAmount);
    expect(shown(field)).toEqual(["100", "g"]);
  });

  it("selects a default filled in under the cursor, so that typing replaces it", () => {
    const { field } = setUp();
    field.clear();
    field.input.focus();
    field.show({ basis: "g", portions: [] }, defaultAmount);
    expect([field.input.selectionStart, field.input.selectionEnd]).toEqual([0, 3]);
  });

  it("takes a new food's default again after an entry is logged", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    pick(field, "g");
    type(field, "90");
    field.forgetTyping();
    field.show({ basis: "ml", portions: [] }, defaultAmount);
    expect(shown(field)).toEqual(["100", "ml"]);
  });
});

describe("settling", () => {
  it("moves the unit on blur", () => {
    const { field, onChange } = setUp();
    field.show(flour, defaultAmount);
    type(field, "10 grams");
    onChange.mockClear();
    field.input.blur();
    expect(shown(field)).toEqual(["10", "g"]);
    expect(onChange).toHaveBeenCalled();
  });

  it("does not call half a word wrong until the user has finished", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    type(field, "10 gr");
    expect(field.read()).toEqual({ state: "typing" });
    field.settle();
    expect(field.read().state).toBe("problem");
    expect(field.input.value).toBe("10 gr");
    type(field, "10 gra");
    expect(field.read()).toEqual({ state: "typing" });
  });
});

describe("picking a unit by hand", () => {
  it("wins over the typed unit, and settles a choice of several", () => {
    const { field } = setUp();
    field.show(carrot, defaultAmount);
    type(field, "2 cups");
    field.settle();
    expect(field.read()).toMatchObject({ state: "problem", inUnit: true });

    pick(field, `${PORTION_PREFIX}1 cup, sliced`);

    expect(shown(field)).toEqual(["2", `${PORTION_PREFIX}1 cup, sliced`]);
    expect(field.read()).toEqual({ state: "ok", quantity: 2, unit: `${PORTION_PREFIX}1 cup, sliced` });
  });

  it("leaves the number alone by default", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    pick(field, "g");
    type(field, "90");
    pick(field, "oz");
    expect(shown(field)).toEqual(["90", "oz"]);
  });

  it("converts a bare number when asked to, from the unit it was in", () => {
    const convert = vi.fn((q: number) => q * 30);
    const { field } = setUp({ convert });
    field.show(flour, defaultAmount);
    pick(field, SLICE);
    convert.mockClear();
    type(field, "2");
    pick(field, "g");
    expect(convert).toHaveBeenCalledWith(2, SLICE, "g");
    expect(shown(field)).toEqual(["60", "g"]);
  });

  it("keeps track of a typed unit, so that a later pick converts from it", () => {
    const convert = vi.fn((q: number) => q * 30);
    const { field } = setUp({ convert });
    field.show(flour, defaultAmount);
    type(field, "2 slices");
    field.settle();
    expect(convert).not.toHaveBeenCalled();
    pick(field, "g");
    expect(convert).toHaveBeenCalledWith(2, SLICE, "g");
  });

  it("does not convert a number that named its own unit", () => {
    const convert = vi.fn((q: number) => q);
    const { field } = setUp({ convert });
    field.show(carrot, defaultAmount);
    type(field, "2 cups");
    pick(field, "g");
    expect(convert).not.toHaveBeenCalled();
    expect(shown(field)).toEqual(["2", "g"]);
  });

  it("keeps the number when the food cannot convert", () => {
    const { field } = setUp({
      convert: () => {
        throw new Error("no density");
      },
    });
    field.show(flour, defaultAmount);
    pick(field, "g");
    type(field, "90");
    pick(field, "oz");
    expect(shown(field)).toEqual(["90", "oz"]);
  });
});

describe("clear", () => {
  it("starts again with no amount and no unit", () => {
    const { field } = setUp();
    field.show(flour, defaultAmount);
    type(field, "90 g");
    field.clear();
    expect(shown(field)).toEqual(["", ""]);
    expect(options(field)).toEqual([]);
    expect(field.read()).toEqual({ state: "typing" });
  });
});
