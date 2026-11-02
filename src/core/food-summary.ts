import type { FoodItem, FoodRef } from "./food";
import { toBaseAmount, PORTION_PREFIX, type BaseUnit, type Portion } from "./units";

/**
 * What a row in the food search dropdown shows (docs/FOOD_SEARCH.md section 3.3).
 * The index builder stores one per product, so search can show rows without
 * fetching the full nutrients; those are fetched only when a row is chosen.
 */
export interface FoodSummary {
  readonly ref: FoodRef;
  readonly name: string;
  readonly brand?: string;
  /** Pack size as printed, e.g. "575 g". */
  readonly packSize?: string;
  readonly basis: BaseUnit;
  readonly kcalPer100: number;
  readonly serving?: { readonly label: string; readonly amount: number; readonly unit: BaseUnit; readonly kcal: number };
}

/** The serving portion: any named portion other than the whole pack. */
export function servingPortion(food: FoodItem): Portion | undefined {
  return food.portions.find((p) => !p.name.startsWith("pack"));
}

export function summarise(food: FoodItem): FoodSummary {
  const summary: { -readonly [K in keyof FoodSummary]: FoodSummary[K] } = {
    ref: food.ref,
    name: food.name,
    basis: food.basis,
    kcalPer100: food.per100.energyKcal,
  };
  if (food.brand) summary.brand = food.brand;
  if (food.packSize) summary.packSize = food.packSize;
  const serving = servingPortion(food);
  if (serving) {
    try {
      const base = toBaseAmount(food, 1, PORTION_PREFIX + serving.name);
      summary.serving = { label: serving.name, amount: serving.amount, unit: serving.unit, kcal: (food.per100.energyKcal * base) / 100 };
    } catch {
      // A serving in the other kind of unit without a density: no per-serving figure.
    }
  }
  return summary;
}
