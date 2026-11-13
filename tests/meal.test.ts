import { describe, expect, it } from "vitest";
import { canReload } from "../src/core/food";
import { newEntryId, parseEntryId } from "../src/core/ids";
import { byName, expandMeal, scaleIngredient, tooManyIngredients } from "../src/core/meal";
import type { PrepIngredient } from "../src/core/prep";
import { parseQuantity, unitText } from "../src/ui/ingredient-list";

const rice: PrepIngredient = { ref: { source: "afcd", id: "f1" }, label: "Rice", quantity: 150, unit: "g", profile: { energyKcal: 150, nutrients: { protein: 3, fat: 1.5 } } };
const banana: PrepIngredient = { ref: { source: "afcd", id: "f2" }, label: "Banana", quantity: 1, unit: "portion:medium", profile: { energyKcal: 90, nutrients: { carbohydrates: 20 } } };

describe("saved meals", () => {
  it("scales an ingredient's nutrients with its amount, in the same unit", () => {
    expect(scaleIngredient(rice, 100)).toEqual({ ...rice, quantity: 100, profile: { energyKcal: 100, nutrients: { protein: 2, fat: 1 } } });
    expect(scaleIngredient(rice, 150)).toBe(rice);
  });

  it("expands a meal into copies of its ingredients, scaled to the servings", () => {
    const half = expandMeal({ ingredients: [rice, banana] }, 0.5);
    expect(half.map((i) => [i.label, i.quantity, i.unit, i.profile.energyKcal])).toEqual([
      ["Rice", 75, "g", 75],
      ["Banana", 0.5, "portion:medium", 45],
    ]);
    expect(expandMeal({ ingredients: [rice] }, 1)).toEqual([rice]);
  });

  it("refuses a list that would pass the ingredient limit", () => {
    expect(tooManyIngredients(58, 2)).toBeUndefined();
    expect(tooManyIngredients(58, 3)).toMatch(/up to 60.*61/);
  });

  it("sorts meals by name, whatever their case", () => {
    expect([{ name: "tuna wrap" }, { name: "Burrito bowl" }, { name: "apple" }].sort(byName).map((m) => m.name)).toEqual(["apple", "Burrito bowl", "tuna wrap"]);
  });

  it("logs a meal under an ID that names it, and never looks it up in the catalogue", () => {
    expect(parseEntryId(newEntryId({ source: "meal", id: "bowl0001" }, 1_800_000_000_000, "abcd"))?.ref).toEqual({ source: "meal", id: "bowl0001" });
    expect(canReload("meal")).toBe(false);
  });

  it("reads the amounts typed into an ingredient", () => {
    expect(["150", "0.5", "1,5", ".5", "1/2"].map(parseQuantity)).toEqual([150, 0.5, 1.5, 0.5, 0.5]);
    expect(["", "0", "-1", "abc", "1/0", "2 cups"].map(parseQuantity)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect([unitText("g"), unitText("portion:medium")]).toEqual(["g", "× medium"]);
  });
});
