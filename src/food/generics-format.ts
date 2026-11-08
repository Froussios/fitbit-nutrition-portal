import type { FoodItem, FoodSource } from "../core/food";
import { NUTRIENT_KEYS, type NutrientKey } from "../core/nutrients";
import { usefulPortions } from "../core/portions";
import type { BaseUnit, Portion } from "../core/units";

/**
 * The generic foods file: authoritative food composition data, small enough to
 * download once and search in the browser (docs/FOOD_SEARCH.md section 13).
 * Built by `pipeline/build-generics.ts`. Sources are concatenated, never joined
 * on names, and each row keeps the values of its one source.
 */

export const GENERICS_FORMAT = 1;

/** [source, source's food ID, name, basis, kcal per 100, nutrients in NUTRIENT_KEYS order, density in g/ml, portions as [name, grams]] */
export type GenericRow = readonly [
  source: FoodSource,
  id: string,
  name: string,
  basis: BaseUnit,
  kcal: number,
  nutrients: readonly (number | null)[],
  density: number | null,
  portions: readonly (readonly [name: string, grams: number])[],
];

export interface GenericsFile {
  readonly format: number;
  readonly sources: readonly { readonly source: FoodSource; readonly title: string; readonly url: string; readonly licence: string }[];
  /** Must travel with the data: see public/generics-LICENSE.txt. */
  readonly notice: string;
  readonly foods: readonly GenericRow[];
}

export function genericToFoodItem(row: GenericRow): FoodItem {
  const [source, id, name, basis, kcal, values, density, portions] = row;
  const nutrients: Partial<Record<NutrientKey, number>> = {};
  NUTRIENT_KEYS.forEach((k, i) => {
    const v = values[i];
    if (v !== null && v !== undefined) nutrients[k] = v;
  });
  return {
    ref: { source, id },
    name,
    basis,
    per100: { energyKcal: kcal, nutrients },
    // Files built before DR-28 still list plain weights as portions.
    portions: usefulPortions(portions.map(([n, amount]): Portion => ({ name: n, amount, unit: "g" }))),
    ...(density ? { densityGPerMl: density } : {}),
  };
}
