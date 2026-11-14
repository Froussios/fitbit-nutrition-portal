// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { SavedMeal } from "../src/core/meal";
import type { PrepIngredient } from "../src/core/prep";
import { createMealCard, type MealCardState } from "../src/ui/meal-card";

const ing = (label: string, quantity: number, unit: string): PrepIngredient => ({ ref: { source: "afcd", id: label }, label, quantity, unit, profile: { energyKcal: 100, nutrients: {} } });
const MEAL: SavedMeal = { id: "bowl0001", name: "Burrito bowl", ingredients: [ing("Rice", 150, "g"), ing("Avocado", 0.5, "portion:medium")], createdAt: 1, updatedAt: 1 };

const state = (over: Partial<MealCardState> = {}): MealCardState => ({ meals: [MEAL], loading: false, error: "", offline: false, deleted: [], busy: new Set(), messages: new Map(), building: false, ...over });

function setUp() {
  const card = createMealCard({ onNew: vi.fn(), onLog: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onRestore: vi.fn() }, document.createElement("div"));
  document.body.replaceChildren(card.element);
  return card;
}

describe("Saved meals tab: ingredient quick view", () => {
  it("lists each ingredient with its amount, closed until asked", () => {
    const card = setUp();
    card.update(state());
    const details = card.element.querySelector<HTMLDetailsElement>("[data-meal=bowl0001] details.meal-ingredients")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("2 ingredients");
    expect([...details.querySelectorAll("li")].map((li) => [...li.children].map((c) => c.textContent))).toEqual([
      ["Rice", "150 g"],
      ["Avocado", "0.5 × medium"],
    ]);
  });

  it("stays open across redraws", () => {
    const card = setUp();
    card.update(state());
    card.element.querySelector<HTMLDetailsElement>("details.meal-ingredients")!.open = true;
    card.update(state({ busy: new Set(["bowl0001"]) }));
    expect(card.element.querySelector<HTMLDetailsElement>("details.meal-ingredients")!.open).toBe(true);
  });

  it("is not offered for a deleted meal", () => {
    const card = setUp();
    card.update(state({ meals: [], deleted: [MEAL] }));
    expect(card.element.querySelector("[data-meal=bowl0001]")!.textContent).toContain("deleted");
    expect(card.element.querySelector("details")).toBeNull();
  });
});
