// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { PrepIngredient } from "../src/core/prep";
import type { FoodCatalog } from "../src/food/catalog";
import { createIngredientRows } from "../src/ui/ingredient-rows";

const ing = (label: string): PrepIngredient => ({ ref: { source: "afcd", id: label }, label, quantity: 100, unit: "g", profile: { energyKcal: 100, nutrients: {} } });

/** A catalogue that counts who follows its changes. */
function catalog() {
  const listeners = new Set<() => void>();
  const c: FoodCatalog = {
    label: "test",
    search: async () => [],
    get: async () => undefined,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { catalog: c, listeners };
}

describe("ingredient rows", () => {
  it("stop following the catalogue once they are removed or replaced (#133)", () => {
    const { catalog: c, listeners } = catalog();
    const rows = createIngredientRows({ catalog: c, id: "t", placeholder: "", onChange: () => undefined });
    document.body.replaceChildren(rows.element);

    rows.set([ing("Rice"), ing("Beans"), ing("Corn")]);
    expect(listeners.size).toBe(3);
    // Opening another meal in the builder starts the rows again.
    rows.set([ing("Oats")]);
    expect(listeners.size).toBe(1);

    rows.element.querySelector<HTMLButtonElement>("button[aria-label='Remove ingredient']")!.click();
    expect(listeners.size).toBe(0);
  });
});
