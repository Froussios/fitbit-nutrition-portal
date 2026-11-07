import { describe, expect, it } from "vitest";
import { AMOUNT_INSTRUCTIONS, amountPrompt, amountSchema, checkAnswer, worthAsking } from "../src/core/amount-answer";
import { PORTION_PREFIX, type Measurable } from "../src/core/units";

const flour: Measurable = {
  basis: "g",
  portions: [
    { name: "1 cup", amount: 125, unit: "g" },
    { name: "1 slice", amount: 30, unit: "g" },
  ],
};
const liquid: Measurable = { basis: "ml", portions: [], densityGPerMl: 1 };

const answer = (quantity: number, quantityText: string, unit = "", unitText = "") => ({ quantity, quantityText, unit, unitText });

describe("worthAsking", () => {
  it.each(["10 grms", "cups: two", "1 scoop", "1-2 cups", "2 cups of flour", "some"])("asks about %s", (text) => {
    expect(worthAsking(text, flour)).toBe(true);
  });

  it.each(["1", "90", "1.5", "1/2", "half", "two and a half", "90 g", "2 cups", "1,5", "", "  ", "-1"])("never asks about %s", (text) => {
    expect(worthAsking(text, flour)).toBe(false);
  });

  it("does not ask about a real unit the food cannot use, because a model cannot supply a density", () => {
    expect(worthAsking("1 cup", { basis: "g", portions: [] })).toBe(false);
  });

  it("does not ask about several cups, because only the user can say which", () => {
    const carrot: Measurable = { basis: "g", portions: [{ name: "1 cup, diced", amount: 130, unit: "g" }, { name: "1 cup, sliced", amount: 120, unit: "g" }] };
    expect(worthAsking("1 cup", carrot)).toBe(false);
  });
});

describe("what the model is told", () => {
  const sugar = { ...flour, name: "Sugar, white", ref: { source: "off", id: "123" }, per100: {} };

  it("never includes the food", () => {
    const told = [amountPrompt("1 cpu", sugar), JSON.stringify(amountSchema(sugar)), JSON.stringify(AMOUNT_INSTRUCTIONS)].join();
    expect(told).not.toMatch(/sugar/i);
    expect(told).not.toContain("123");
  });

  it("gives the typed text and the food's own units", () => {
    expect(amountPrompt(" 1 cpu ", flour)).toBe('Allowed units: g, kg, mg, oz, lb, 1 cup, 1 slice\nText: "1 cpu"');
    expect(amountSchema(flour).properties).toMatchObject({ unit: { enum: ["g", "kg", "mg", "oz", "lb", "1 cup", "1 slice", ""] } });
  });

  it("does not offer a unit this food cannot use", () => {
    const prompt = amountPrompt("1 cpu", { basis: "g", portions: [] });
    expect(prompt).not.toMatch(/\bml\b/);
    expect(prompt).not.toMatch(/\bcup\b/);
  });
});

describe("checkAnswer accepts", () => {
  it("a mistyped unit", () => {
    expect(checkAnswer("10 grms", answer(10, "10", "g", "grms"), flour)).toEqual({ ok: true, quantity: 10, unit: "g" });
    expect(checkAnswer("2 tablespoosn", answer(2, "2", "tbsp", "tablespoosn"), liquid)).toEqual({ ok: true, quantity: 2, unit: "tbsp" });
    expect(checkAnswer("3 cpus", answer(3, "3", "1 cup", "cpus"), flour)).toEqual({ ok: true, quantity: 3, unit: `${PORTION_PREFIX}1 cup` });
    expect(checkAnswer("2 slcies", answer(2, "2", "1 slice", "slcies"), flour)).toEqual({ ok: true, quantity: 2, unit: `${PORTION_PREFIX}1 slice` });
  });

  it("the words in another order", () => {
    expect(checkAnswer("cups: two", answer(2, "two", "1 cup", "cups"), flour)).toEqual({ ok: true, quantity: 2, unit: `${PORTION_PREFIX}1 cup` });
    expect(checkAnswer("g 90", answer(90, "90", "g", "g"), flour)).toEqual({ ok: true, quantity: 90, unit: "g" });
  });

  it("a count with filler words", () => {
    expect(checkAnswer("a cpu", answer(1, "a", "1 cup", "cpu"), flour)).toEqual({ ok: true, quantity: 1, unit: `${PORTION_PREFIX}1 cup` });
    expect(checkAnswer("a slcie of", answer(1, "a", "1 slice", "slcie"), flour)).toMatchObject({ ok: true });
  });

  it("no unit when none was typed, leaving that to the unit field", () => {
    expect(checkAnswer("x two", answer(2, "two"), flour)).toEqual({ ok: true, quantity: 2 });
  });

  it("uses the rules' number, not the model's", () => {
    expect(checkAnswer("two thirds cpu", answer(0.67, "two thirds", "1 cup", "cpu"), flour)).toEqual({ ok: true, quantity: 0.667, unit: `${PORTION_PREFIX}1 cup` });
  });

  it("ignores case in what it quotes", () => {
    expect(checkAnswer("10 GRMS", answer(10, "10", "g", "GRMS"), flour)).toMatchObject({ ok: true });
  });
});

describe("checkAnswer refuses a guess", () => {
  it.each([
    ["a unit the text never mentions", "2 slcies", answer(2, "2", "1 cup", "cup")],
    ["a unit picked with no words behind it", "x two", answer(2, "two", "1 cup", "")],
    ["a substitute that is not a typing mistake", "1 scoop", answer(1, "1", "1 cup", "scoop")],
    ["a similar short word", "1 mug", answer(1, "1", "1 cup", "mug")],
    ["words for one unit, labelled as another", "1 slcie", answer(1, "1", "1 cup", "slcie")],
    ["a unit not on the list", "1 cpu", answer(1, "1", "bucket", "cpu")],
    ["a number that is not typed", "some cpus", answer(3, "3", "1 cup", "cpus")],
    ["a number that does not match its words", "2 cpus", answer(3, "2", "1 cup", "cpus")],
    ["a vague word as a number", "a couple of cpus", answer(2, "a couple", "1 cup", "cpus")],
    ["a few", "a few cpus", answer(3, "a few", "1 cup", "cpus")],
    ["half of a range", "1-2 cpus", answer(1, "1", "1 cup", "cpus")],
    ["the middle of a range", "1-2 cpus", answer(1.5, "1-2", "1 cup", "cpus")],
    ["a decimal comma", "1,5 cpus", answer(1.5, "1,5", "1 cup", "cpus")],
    ["half of a decimal comma", "1,5 cpus", answer(1, "1", "1 cup", "cpus")],
    ["an unexplained word", "1 big cpu", answer(1, "1", "1 cup", "cpu")],
    ["an amount with a hedge", "about 2 cpus", answer(2, "2", "1 cup", "cpus")],
    ["an extra food", "2 cpus of flour", answer(2, "2", "1 cup", "cpus")],
    ["another number left over", "2 cpus 3", answer(2, "2", "1 cup", "cpus")],
    ["zero", "0 cpus", answer(0, "0", "1 cup", "cpus")],
    ["a negative", "-1 cpus", answer(-1, "-1", "1 cup", "cpus")],
    ["nothing", "some", answer(0, "")],
  ])("%s", (_name, text, reply) => {
    expect(checkAnswer(text, reply, flour)).toMatchObject({ ok: false });
  });

  it("refuses a malformed answer", () => {
    for (const reply of [null, "2 cups", 2, {}, [], { quantity: "2", quantityText: "2", unit: "", unitText: "" }, { quantity: Number.NaN, quantityText: "2", unit: "", unitText: "" }]) {
      expect(checkAnswer("2 cpus", reply, flour)).toMatchObject({ ok: false });
    }
  });

  it("refuses a unit this food cannot use, even if the words fit", () => {
    expect(checkAnswer("1 cpu", answer(1, "1", "cup", "cpu"), { basis: "g", portions: [] })).toMatchObject({ ok: false });
  });
});
