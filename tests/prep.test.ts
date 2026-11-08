import { describe, expect, it } from "vitest";
import { batchProfile, checkIngredients, formatFraction, isFinished, leftOf, parseFraction, portionName, portionProfile } from "../src/core/prep";

describe("parseFraction", () => {
  it.each([
    ["1/6", 1 / 6],
    ["2/3", 2 / 3],
    ["25%", 0.25],
    ["12.5%", 0.125],
    ["0.25", 0.25],
    [".5", 0.5],
    ["1", 1],
    [" 1 / 6 ", 1 / 6],
  ])("reads %s", (text, value) => {
    expect(parseFraction(text)).toBeCloseTo(value);
  });

  it.each(["", "0", "0/6", "7/6", "1/0", "1.5", "150%", "150g", "150 g", "-1/6", "half", "1/6 cup"])("refuses %s", (text) => {
    expect(parseFraction(text)).toBeUndefined();
  });
});

describe("formatFraction", () => {
  it.each([
    [1 / 3, "1/3"],
    [1 / 6, "1/6"],
    [0.75, "3/4"],
    [0.3, "3/10"],
    [5 / 6, "5/6"],
    [0.37, "37%"],
    [0.004, "0.4%"],
    [1, "all"],
  ])("writes %d as %s", (fraction, text) => {
    expect(formatFraction(fraction)).toBe(text);
  });

  it("names a portion after its prep", () => {
    expect(portionName("Chili", 1 / 6)).toBe("Chili (1/6)");
  });
});

describe("what is left", () => {
  it("is nothing after three thirds, despite rounding", () => {
    const thirds = [{ fraction: 1 / 3 }, { fraction: 1 / 3 }, { fraction: 1 / 3 }];
    expect(leftOf(thirds)).toBe(0);
    expect(isFinished({ portions: thirds })).toBe(true);
  });

  it("is the rest of the batch otherwise", () => {
    expect(leftOf([])).toBe(1);
    expect(leftOf([{ fraction: 0.25 }])).toBeCloseTo(0.75);
    expect(isFinished({ portions: [{ fraction: 0.25 }] })).toBe(false);
  });
});

describe("nutrients", () => {
  const ingredients = [
    { profile: { energyKcal: 1200, nutrients: { protein: 100, fat: 80 } } },
    { profile: { energyKcal: 360, nutrients: { protein: 24 } } },
  ];

  it("adds up the batch", () => {
    expect(batchProfile(ingredients)).toEqual({ energyKcal: 1560, nutrients: { protein: 124, fat: 80 } });
  });

  it("scales a portion of it", () => {
    const sixth = portionProfile(ingredients, 1 / 6);
    expect(sixth.energyKcal).toBeCloseTo(260);
    expect(sixth.nutrients.protein).toBeCloseTo(124 / 6);
    expect(sixth.nutrients.fat).toBeCloseTo(80 / 6);
  });
});

describe("checkIngredients", () => {
  const good = { ref: { source: "afcd", id: "f001" }, label: "Beef", quantity: 500, unit: "g", profile: { energyKcal: 1200, nutrients: { protein: 100 } } };

  it("keeps only the fields it knows", () => {
    expect(checkIngredients([{ ...good, extra: "x", ref: { ...good.ref, more: 1 } }])).toEqual([good]);
  });

  it("refuses a meal prep as an ingredient", () => {
    expect(() => checkIngredients([{ ...good, ref: { source: "prep", id: "chili001" } }])).toThrow("unknown food");
  });
});
