import { describe, expect, it } from "vitest";
import { isRescaledUnit, usefulPortions } from "../src/core/portions";
import type { BaseUnit } from "../src/core/units";

const portion = (name: string, amount: number, unit: BaseUnit = "g") => ({ name, amount, unit });

describe("isRescaledUnit", () => {
  it.each([
    ["100 g", 100, "g"],
    ["100g", 100, "g"],
    ["30 grams", 30, "g"],
    ["1 oz", 28.35, "g"],
    ["1 oz", 28, "g"],
    ["2 ounces", 56.7, "g"],
    ["1 lb", 453.6, "g"],
    ["0.5 kg", 500, "g"],
    ["1 oz, cooked", 28.4, "g"],
    ["3.5 oz (100 g)", 100, "g"],
    ["250 ml", 250, "ml"],
    ["1 L", 1000, "ml"],
    ["33 cl", 330, "ml"],
    ["2 dl", 200, "ml"],
    ["12,5 g", 12.5, "g"],
    ["3.5 oz (99,2 g)", 99.2, "g"],
    ["1 1/2 oz", 42.5, "g"],
    ["8 fluid ounces", 236.6, "ml"],
    ["12 fl oz (355 ml)", 355, "ml"],
    ["1 cup", 250, "ml"],
    ["1/2 cup", 125, "ml"],
  ] as const)("drops %s = %s %s", (name, amount, unit) => {
    expect(isRescaledUnit(portion(name, amount, unit))).toBe(true);
  });

  it.each([
    // A serving, named as one.
    ["1 pie (150g)", 150, "g"],
    ["1 serving (300ml)", 300, "ml"],
    ["2 biscuits (30 g)", 30, "g"],
    ["pack (500 g)", 500, "g"],
    ["5 oz package", 142, "g"],
    ["1 bottle (16.9 fl oz or 500 ml)", 524, "g"],
    // Not the size the measure says: these are information, not another size of a unit.
    ["1 oz, dry, yields", 170, "g"],
    ["1 oz yields", 21, "g"],
    ["1 cup", 125, "g"],
    ["1 cup", 240, "ml"],
    ["1 tablespoon", 15, "ml"],
    ["1 fl oz", 30.5, "g"],
    // A weight on a volume, or the other way round, is a density.
    ["100 g", 95, "ml"],
    // Something in the brackets that is not a measure.
    ["1 oz (about 10 chips)", 28.35, "g"],
    ["serving", 40, "g"],
  ] as const)("keeps %s = %s %s", (name, amount, unit) => {
    expect(isRescaledUnit(portion(name, amount, unit))).toBe(false);
  });

  it("keeps the order of what is left", () => {
    expect(usefulPortions([portion("1 slice", 21), portion("1 oz", 28.35), portion("1 cup, diced", 132)]).map((p) => p.name)).toEqual(["1 slice", "1 cup, diced"]);
  });
});
