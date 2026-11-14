import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE_FOODS } from "../src/food/sample-foods";
import { genericToFoodItem, type GenericsFile } from "../src/food/generics-format";
import { MAX_FOOD_ID, MAX_LABEL, MAX_UNIT, PORTION_SUFFIX, batchProfile, checkIngredients, ingredientLimitProblem, formatFraction, isFinished, leftOf, parseFraction, portionName, portionOfEntry, portionProfile, type Prep } from "../src/core/prep";

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

  it("accepts every field at its limit, and nothing over it", () => {
    const longest = { ...good, ref: { source: "off", id: "1".repeat(MAX_FOOD_ID) }, label: "é".repeat(MAX_LABEL), unit: `portion:${"s".repeat(MAX_UNIT - 8)}` };
    expect(checkIngredients([longest])).toEqual([longest]);
    expect(() => checkIngredients([{ ...longest, ref: { source: "off", id: "1".repeat(MAX_FOOD_ID + 1) } }])).toThrow("unknown food");
    expect(() => checkIngredients([{ ...longest, label: "é".repeat(MAX_LABEL + 1) }])).toThrow("no name");
    expect(() => checkIngredients([{ ...longest, unit: "s".repeat(MAX_UNIT + 1) }])).toThrow("no unit");
  });
});

describe("ingredientLimitProblem", () => {
  const food = { ref: { source: "off" as const, id: "9300000000001" }, name: "Muesli", brand: "Brand", portions: [{ name: "1 bowl (45 g)", amount: 45, unit: "g" as const }] };

  it("agrees with checkIngredients on what can be saved", () => {
    expect(ingredientLimitProblem(food)).toBeUndefined();
    // The label joins the name and brand as "Name (Brand)".
    expect(ingredientLimitProblem({ ...food, brand: "b".repeat(MAX_LABEL - 9) })).toBeUndefined();
    expect(ingredientLimitProblem({ ...food, brand: "b".repeat(MAX_LABEL - 8) })).toContain("name and brand");
    expect(ingredientLimitProblem({ ...food, portions: [{ name: "p".repeat(MAX_UNIT - 7), amount: 45, unit: "g" }] })).toContain("portion");
    expect(ingredientLimitProblem({ ...food, ref: { source: "off", id: "1".repeat(MAX_FOOD_ID + 1) } })).toContain("ID");
  });

  it("passes every generic and sample food, so all of them can be ingredients", () => {
    const generics = (JSON.parse(readFileSync(new URL("../src/food/data/generics.json", import.meta.url), "utf8")) as GenericsFile).foods.map(genericToFoodItem);
    const problems = [...generics, ...SAMPLE_FOODS].map((f) => [f.ref.id, ingredientLimitProblem(f)]).filter(([, p]) => p);
    expect(problems).toEqual([]);
  });
});

describe("portionOfEntry", () => {
  const at = Date.UTC(2026, 10, 11, 12, 30, 15, 250);
  const portion = (id: string, fraction: number, entryId: string | null, eatenAt = at) => ({ id, fraction, entryId, state: "confirmed" as const, eatenAt, createdAt: eatenAt });
  const preps: Prep[] = [
    { id: "chiliprep01", name: "Chili", ingredients: [], createdAt: 0, updatedAt: 0, discardedAt: null, portions: [portion("p1", 1 / 4, "e-ours-1"), portion("p2", 1 / 6, "e-ours-2", at + 60_000)] },
  ];

  it("finds a portion by its entry's ID", () => {
    expect(portionOfEntry(preps, { id: "e-ours-2", foodDisplayName: "Something else", start: 0 })?.portion.id).toBe("p2");
  });

  it("finds one Google stored under its own ID by name and second", () => {
    expect(portionOfEntry(preps, { id: "1234", foodDisplayName: "Chili (1/4)", start: at - 250 })?.portion.id).toBe("p1");
    expect(portionOfEntry(preps, { id: "1234", foodDisplayName: "Chili (1/4)", start: at + 750 })?.portion.id).toBe("p1");
  });

  it("does not match more than a second away, another name, or a portion whose own entry is still listed", () => {
    expect(portionOfEntry(preps, { id: "1234", foodDisplayName: "Chili (1/4)", start: at + 1251 })).toBeUndefined();
    expect(portionOfEntry(preps, { id: "1234", foodDisplayName: "Chili (1/6)", start: at })).toBeUndefined();
    expect(portionOfEntry(preps, { id: "1234", foodDisplayName: "Chili (1/4)", start: at }, new Set(["e-ours-1"]))).toBeUndefined();
  });
});

it.each(["Chili (1/6)", "Chili (25%)", "Chili (12.5%)", "Chili (all)"])("PORTION_SUFFIX matches %s", (name) => expect(PORTION_SUFFIX.test(name)).toBe(true));
it.each(["Chili", "Oats (40 g)", "Chili (one)"])("PORTION_SUFFIX skips %s", (name) => expect(PORTION_SUFFIX.test(name)).toBe(false));
