import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { amountForFood, defaultAmount, readAmount, readAmountText, settledAmount, type AmountReading } from "../src/core/amount-text";
import { PORTION_PREFIX, type Measurable, type Portion } from "../src/core/units";
import type { GenericsFile } from "../src/food/generics-format";

const portion = (name: string, amount = 100, unit: Portion["unit"] = "g"): Portion => ({ name, amount, unit });
const value = (name: string) => PORTION_PREFIX + name;

const bare: Measurable = { basis: "g", portions: [] };
const liquid: Measurable = { basis: "ml", portions: [], densityGPerMl: 1.03 };
const noDensity: Measurable = { basis: "ml", portions: [] };
const flour: Measurable = { basis: "g", portions: [portion("1 cup", 125), portion("1 tablespoon", 8), portion("1 slice", 30)] };

const amount = (quantity: number, unit?: string): AmountReading => ({ kind: "amount", quantity, ...(unit ? { unit } : {}) });

describe("the issue's examples", () => {
  it.each([
    ["10 g", amount(10, "g")],
    ["10g", amount(10, "g")],
    ["10 grams", amount(10, "g")],
    ["10 gram", amount(10, "g")],
    ["10", amount(10)],
  ])("%s", (text, expected) => expect(readAmountText(text, bare)).toEqual(expected));

  it.each([
    ["10 cups", amount(10, "cup")],
    ["1 cup", amount(1, "cup")],
  ])("%s", (text, expected) => expect(readAmountText(text, liquid)).toEqual(expected));
});

describe("numbers", () => {
  it.each([
    ["10.5", 10.5],
    [".5", 0.5],
    ["5.", 5],
    ["1,000", 1000],
    ["1,000.5", 1000.5],
    ["1/2", 0.5],
    ["1 / 2", 0.5],
    ["1 1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["1 ½", 1.5],
    ["1/3", 0.333],
    ["⅔", 0.667],
    ["two", 2],
    ["TEN", 10],
    ["half", 0.5],
    ["a quarter", 0.25],
    ["a third", 0.333],
    ["three quarters", 0.75],
    ["two thirds", 0.667],
    ["twenty", 20],
    ["two and a half", 2.5],
    ["two and a quarter", 2.25],
    ["1 and a half", 1.5],
    ["one and three quarters", 1.75],
    ["10 and half", 10.5],
  ])("reads %s", (text, quantity) => expect(readAmountText(text, bare)).toEqual(amount(quantity)));

  it.each([
    ["half a cup", 0.5],
    ["half an cup", 0.5],
    ["half cup", 0.5],
    ["a half cup", 0.5],
    ["quarter of a cup", 0.25],
    ["a cup", 1],
    ["an cup", 1],
    ["one cup", 1],
    ["two cups", 2],
    ["two and a half cups", 2.5],
    ["three quarters of a cup", 0.75],
    ["1 and a half cups", 1.5],
  ])("reads %s with its unit", (text, quantity) => expect(readAmountText(text, liquid)).toEqual(amount(quantity, "cup")));

  it.each(["1,5", "1-2 cups", "1e3", "-5", "+5", "1/2/3", "1/0", "1,000,5", "cup", "g", "1.2.3", "abc", "9".repeat(400)])("refuses %s", (text) => {
    const reading = readAmountText(text, liquid);
    expect(reading.kind).not.toBe("amount");
  });

  it("calls zero what it is", () => {
    expect(readAmountText("0", bare).kind).toBe("zero");
    expect(readAmountText("0 g", bare).kind).toBe("zero");
  });

  it("ignores case and spacing", () => {
    expect(readAmountText("  10   ML ", liquid)).toEqual(amount(10, "ml"));
    expect(readAmountText("2 L", liquid)).toEqual(amount(2, "l"));
  });
});

describe("unit names", () => {
  it.each([
    ["g", "g"], ["gm", "g"], ["gms", "g"], ["gram", "g"], ["grams", "g"], ["gramme", "g"], ["grammes", "g"], ["g.", "g"],
    ["kg", "kg"], ["kgs", "kg"], ["kilo", "kg"], ["kilos", "kg"], ["kilogram", "kg"], ["kilograms", "kg"],
    ["mg", "mg"], ["milligram", "mg"], ["milligrams", "mg"],
    ["oz", "oz"], ["ounce", "oz"], ["ounces", "oz"],
    ["lb", "lb"], ["lbs", "lb"], ["pound", "lb"], ["pounds", "lb"],
    ["ml", "ml"], ["mls", "ml"], ["millilitre", "ml"], ["millilitres", "ml"], ["milliliter", "ml"], ["milliliters", "ml"],
    ["l", "l"], ["litre", "l"], ["litres", "l"], ["liter", "l"], ["liters", "l"],
    ["tsp", "tsp"], ["teaspoon", "tsp"], ["teaspoons", "tsp"],
    ["tbsp", "tbsp"], ["tablespoon", "tbsp"], ["tablespoons", "tbsp"],
    ["cup", "cup"], ["cups", "cup"],
  ])("%s is %s", (word, key) => expect(readAmountText(`2 ${word}`, liquid)).toEqual(amount(2, key)));

  it.each(["T", "t", "c"])("refuses the ambiguous %s", (word) => {
    const food: Measurable = { basis: "ml", portions: [portion("can", 375, "ml")], densityGPerMl: 1 };
    expect(readAmountText(`2 ${word}`, food).kind).toBe("unknown-unit");
  });
});

describe("the food's portions", () => {
  it("finds a portion by its name, singular or plural", () => {
    expect(readAmountText("2 slices", flour)).toEqual(amount(2, value("1 slice")));
    expect(readAmountText("1 SLICE", flour)).toEqual(amount(1, value("1 slice")));
    expect(readAmountText("2 cookies", { basis: "g", portions: [portion("1 cookie")] })).toEqual(amount(2, value("1 cookie")));
    expect(readAmountText("2 boxes", { basis: "g", portions: [portion("box")] })).toEqual(amount(2, value("box")));
  });

  it("ignores what is in brackets", () => {
    const cola: Measurable = { basis: "ml", portions: [portion("can (375 ml)", 375, "ml")] };
    expect(readAmountText("1 can", cola)).toEqual(amount(1, value("can (375 ml)")));
  });

  it("applies unit names to portions", () => {
    expect(readAmountText("1 tbsp", flour)).toEqual(amount(1, value("1 tablespoon")));
    expect(readAmountText("3 tablespoons", flour)).toEqual(amount(3, value("1 tablespoon")));
  });

  it("reads the dropdown's own wording", () => {
    expect(readAmountText("2 × can", { basis: "ml", portions: [portion("can", 375, "ml")] })).toEqual(amount(2, value("can")));
    expect(readAmountText("2 x 1 cup", flour)).toEqual(amount(2, value("1 cup")));
    expect(readAmountText("2x 1 cup", flour)).toEqual(amount(2, value("1 cup")));
    expect(readAmountText("2 * 1 cup", flour)).toEqual(amount(2, value("1 cup")));
    expect(readAmountText("2 cup (250 ml, metric)", liquid)).toEqual(amount(2, "cup"));
  });

  it("prefers the food's cup to the metric one", () => {
    const milk: Measurable = { basis: "ml", portions: [portion("1 cup (240 ml)", 240, "ml")], densityGPerMl: 1.03 };
    expect(readAmountText("1 cup", milk)).toEqual(amount(1, value("1 cup (240 ml)")));
  });

  it("keeps weights exact, whatever portions the food has", () => {
    const meat: Measurable = { basis: "g", portions: [portion("1 oz, cooked", 28.4), portion("1 g, dry", 3)] };
    expect(readAmountText("4 oz", meat)).toEqual(amount(4, "oz"));
    expect(readAmountText("4 g", meat)).toEqual(amount(4, "g"));
    expect(readAmountText("4 × 1 oz, cooked", meat)).toEqual(amount(4, value("1 oz, cooked")));
  });

  it("uses a qualified cup when it is the only one", () => {
    const carrot: Measurable = { basis: "g", portions: [portion("1 cup, diced", 130)] };
    expect(readAmountText("1 cup", carrot)).toEqual(amount(1, value("1 cup, diced")));
  });

  it("asks when several cups fit, and takes one when it is named", () => {
    const carrot: Measurable = { basis: "g", portions: [portion("1 cup, diced", 130), portion("1 cup, sliced", 120)] };
    expect(readAmountText("2 cups", carrot)).toMatchObject({ kind: "ambiguous", quantity: 2, choices: ["1 cup, diced", "1 cup, sliced"] });
    expect(readAmountText("2 cups, sliced", carrot)).toEqual(amount(2, value("1 cup, sliced")));
    expect(readAmountText("2 cup diced", carrot)).toEqual(amount(2, value("1 cup, diced")));
  });

  it("prefers the plain name, and asks when only bracketed names differ", () => {
    const sandwich: Measurable = { basis: "g", portions: [portion("1 sandwich", 92), portion("1 sandwich (1 slice bread)", 46)] };
    expect(readAmountText("1 sandwich", sandwich)).toEqual(amount(1, value("1 sandwich")));
    const fat: Measurable = { basis: "g", portions: [portion('1 slice (2" x 1")', 26), portion('1 slice (4" x 1")', 47)] };
    expect(readAmountText("1 slice", fat).kind).toBe("ambiguous");
    expect(readAmountText('1 × 1 slice (4" x 1")', fat)).toEqual(amount(1, value('1 slice (4" x 1")')));
  });

  it("takes either portion when they are the same amount", () => {
    const yogurt: Measurable = { basis: "g", portions: [portion("1 cup (8 fl oz)", 245), portion("1 cup (250 ml)", 245)] };
    expect(readAmountText("1 cup", yogurt)).toEqual(amount(1, value("1 cup (8 fl oz)")));
  });

  it("reads a whole portion name that starts with its own count", () => {
    const oats: Measurable = { basis: "g", portions: [portion("1/2 cup (40 g)", 40), portion("2 slices (50 g)", 50)] };
    expect(readAmountText("1/2 cup", oats)).toEqual(amount(1, value("1/2 cup (40 g)")));
    expect(readAmountText("2 slices", oats)).toEqual(amount(1, value("2 slices (50 g)")));
  });

  it("prefers a whole portion name to the metric cup, when a density makes both possible", () => {
    const oats: Measurable = { basis: "g", portions: [portion("1/2 cup (40 g)", 40)], densityGPerMl: 0.4 };
    expect(readAmountText("1/2 cup", oats)).toEqual(amount(1, value("1/2 cup (40 g)")));
    expect(readAmountText("1 cup", oats)).toEqual(amount(1, "cup"));
    expect(readAmountText("2 × 1/2 cup", oats)).toEqual(amount(2, value("1/2 cup (40 g)")));
  });
});

describe("units this food cannot use", () => {
  it("never assumes a density (DR-06)", () => {
    expect(readAmountText("1 cup", bare)).toMatchObject({ kind: "not-for-this-food", quantity: 1 });
    expect(readAmountText("90 g", noDensity)).toMatchObject({ kind: "not-for-this-food", quantity: 90 });
    expect(readAmountText("90 g", liquid)).toEqual(amount(90, "g"));
  });

  it("does not invent a unit", () => {
    expect(readAmountText("1 scoop", bare)).toMatchObject({ kind: "unknown-unit", word: "scoop" });
    expect(readAmountText("a couple of cups", liquid).kind).toBe("unknown-unit");
    expect(readAmountText("2 and a bit cups", liquid).kind).toBe("unknown-unit");
  });
});

describe("while typing", () => {
  it.each([
    ["1/", bare], ["1 1/", bare], [".", bare], ["1,0", bare], ["ha", bare], ["a", bare], ["half a", bare], ["half of", bare], ["2 x", bare], ["0", bare],
    ["two and", bare], ["two and a", bare], ["two and a h", bare], ["1 and", bare], ["three q", bare], ["thre", bare],
    ["1 1", bare], ["10 gr", bare], ["10 gra", bare], ["1 l", bare], ["1 cu", bare], ["2 sli", flour],
  ] as const)("%s is not wrong yet", (text, food) => {
    expect(readAmount(text, "g", food, { settled: false })).toEqual({ state: "typing" });
    expect(readAmount(text, "g", food, { settled: true }).state).toBe("problem");
  });

  it("calls a word wrong straight away when nothing starts with it", () => {
    expect(readAmount("10 zz", "g", bare, { settled: false }).state).toBe("problem");
    expect(readAmount("zz", "g", bare, { settled: false }).state).toBe("problem");
  });

  it("does not rush several cups", () => {
    const carrot: Measurable = { basis: "g", portions: [portion("1 cup, diced", 130), portion("1 cup, sliced", 120)] };
    expect(readAmount("1 cup", "g", carrot, { settled: false })).toEqual({ state: "typing" });
    expect(readAmount("1 cup", "g", carrot, { settled: true })).toMatchObject({ state: "problem", inUnit: true });
  });

  it("waits for a food's portions before calling a word wrong", () => {
    expect(readAmount("1 can", "ml", noDensity, { settled: true, pending: true })).toEqual({ state: "typing" });
    expect(readAmount("1 can", "ml", noDensity, { settled: true })).toMatchObject({ state: "problem", inUnit: true });
  });
});

describe("readAmount", () => {
  it("a bare number takes the unit showing", () => {
    expect(readAmount("90", value("1 cup"), flour, { settled: true })).toEqual({ state: "ok", quantity: 90, unit: value("1 cup") });
    expect(readAmount("90", "g", flour, { settled: false })).toEqual({ state: "ok", quantity: 90, unit: "g" });
  });

  it("a bare number with no unit showing asks, and never takes a default", () => {
    expect(readAmount("90", "", flour, { settled: true })).toMatchObject({ state: "problem", inUnit: true, message: "Choose a unit for this amount." });
  });

  it("a named unit needs nothing to be showing", () => {
    expect(readAmount("90 g", "", flour, { settled: true })).toEqual({ state: "ok", quantity: 90, unit: "g" });
  });

  it("a named unit beats the one showing", () => {
    expect(readAmount("90 g", value("1 cup"), flour, { settled: true })).toEqual({ state: "ok", quantity: 90, unit: "g" });
  });

  it("refuses nothing and zero", () => {
    expect(readAmount("", "g", bare, { settled: false })).toMatchObject({ state: "problem", inUnit: false });
    expect(readAmount("0", "g", bare, { settled: true })).toMatchObject({ state: "problem", message: "Enter an amount greater than 0." });
  });
});

describe("settledAmount", () => {
  it("moves the unit to its field", () => {
    expect(settledAmount({ text: "90 g", unit: "" }, bare)).toEqual({ text: "90", unit: "g" });
    expect(settledAmount({ text: "2 slices", unit: "g" }, flour)).toEqual({ text: "2", unit: value("1 slice") });
  });

  it("writes a number the field can keep", () => {
    expect(settledAmount({ text: "1,000", unit: "g" }, bare)).toEqual({ text: "1000", unit: "g" });
    expect(settledAmount({ text: "half", unit: "g" }, bare)).toEqual({ text: "0.5", unit: "g" });
    expect(settledAmount({ text: "1/3 kg", unit: "g" }, bare)).toEqual({ text: "0.333", unit: "kg" });
  });

  it("leaves a bare number's unit alone, even when none is showing", () => {
    expect(settledAmount({ text: "90", unit: "" }, bare)).toEqual({ text: "90", unit: "" });
  });

  it("leaves what it cannot read as typed", () => {
    expect(settledAmount({ text: "1 scoop", unit: "g" }, bare)).toEqual({ text: "1 scoop", unit: "g" });
  });
});

describe("amountForFood", () => {
  const blank = { text: "", unit: "" };

  it("fills an untouched field with the food's default", () => {
    expect(amountForFood(flour, blank, false, defaultAmount)).toEqual({ text: "1", unit: value("1 cup") });
    expect(amountForFood(bare, blank, false, defaultAmount)).toEqual({ text: "100", unit: "g" });
  });

  it("keeps an untouched amount whose unit is still offered", () => {
    expect(amountForFood(bare, { text: "250", unit: "kg" }, false, defaultAmount)).toEqual({ text: "250", unit: "kg" });
  });

  it("never fills in a unit after a bare number typed while none was showing", () => {
    expect(amountForFood(flour, { text: "90", unit: "" }, true, defaultAmount)).toEqual({ text: "90", unit: "" });
  });

  it("applies a unit typed before the units arrived", () => {
    expect(amountForFood(flour, { text: "90 g", unit: "" }, true, defaultAmount)).toEqual({ text: "90 g", unit: "g" });
    expect(amountForFood(flour, { text: "2 slices", unit: "" }, true, defaultAmount)).toEqual({ text: "2 slices", unit: value("1 slice") });
  });

  it("blanks a unit the new food cannot use rather than swapping it under a typed number", () => {
    expect(amountForFood(noDensity, { text: "90", unit: "g" }, true, defaultAmount)).toEqual({ text: "90", unit: "" });
  });

  it("keeps a typed number when its unit is still offered", () => {
    expect(amountForFood(flour, { text: "90", unit: "g" }, true, defaultAmount)).toEqual({ text: "90", unit: "g" });
  });

  it("keeps a typed text it cannot read", () => {
    expect(amountForFood(bare, { text: "1 scoop", unit: "" }, true, defaultAmount)).toEqual({ text: "1 scoop", unit: "" });
  });
});

describe("the real generic foods", () => {
  const file = JSON.parse(readFileSync(new URL("../src/food/data/generics.json", import.meta.url), "utf8")) as GenericsFile;
  const foods = file.foods.map(([, , , basis, , , density, portions]): Measurable => ({
    basis,
    portions: portions.map(([name, amount]) => ({ name, amount, unit: "g" })),
    ...(density ? { densityGPerMl: density } : {}),
  }));

  it("reads every portion from the dropdown's wording", () => {
    const failures = foods.flatMap((food) =>
      food.portions.filter((p) => {
        const reading = readAmountText(`2 × ${p.name}`, food);
        if (reading.kind !== "amount" || reading.quantity !== 2) return true;
        const chosen = food.portions.find((other) => value(other.name) === reading.unit);
        return chosen?.amount !== p.amount;
      }),
    );
    expect(failures.map((p) => p.name)).toEqual([]);
  });

  it("always answers 1 cup with a cup or a refusal, never anything else", () => {
    for (const food of foods) {
      const reading = readAmountText("1 cup", food);
      if (reading.kind === "amount") expect(reading.unit === "cup" || /cup/i.test(reading.unit ?? "")).toBe(true);
      else expect(["ambiguous", "not-for-this-food"]).toContain(reading.kind);
    }
  });
});

describe("an entry measured only as a multiple of itself", () => {
  const entry = { basis: "g" as const, portions: [{ name: "this entry", amount: 1, unit: "g" as const }], portionsOnly: true };

  it("reads a number in that portion", () => {
    expect(readAmount("2", "portion:this entry", entry, { settled: true })).toEqual({ state: "ok", quantity: 2, unit: "portion:this entry" });
    expect(readAmount("0.5", "portion:this entry", entry, { settled: true })).toEqual({ state: "ok", quantity: 0.5, unit: "portion:this entry" });
  });

  it("does not accept a weight or volume, which it has no way to convert", () => {
    expect(readAmount("80 g", "portion:this entry", entry, { settled: true }).state).toBe("problem");
    expect(readAmount("1 cup", "portion:this entry", entry, { settled: true }).state).toBe("problem");
  });
});
