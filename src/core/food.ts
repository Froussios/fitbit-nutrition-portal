import { scaleProfile, type NutrientProfile } from "./nutrients";
import { toBaseAmount, type BaseUnit, type Measurable, type Portion } from "./units";

/**
 * Where a food definition comes from. The diary itself only stores computed
 * nutrients, so this reference is what lets the app find the food again
 * (for "log again", meals, corrections).
 */
export type FoodSource =
  | "off" // Open Food Facts, id = barcode
  | "afcd" // Australian Food Composition Database (FSANZ), id = public food key
  | "ausnut" // AUSNUT (FSANZ), id = public food key
  | "fndds" // USDA Food and Nutrient Database for Dietary Studies, id = fdcId
  | "usda" // Other USDA FoodData Central data, id = fdcId
  | "sample" // Built-in sample catalogue (proof of concept)
  | "manual"; // Typed in by the user

/** The short tag shown wherever a food appears, so a bad value can be traced to its database. */
export const SOURCE_TAGS: Readonly<Record<FoodSource, string>> = {
  off: "OFF",
  afcd: "AFCD",
  ausnut: "AUSNUT",
  fndds: "FNDDS",
  usda: "USDA",
  sample: "Sample",
  manual: "Custom",
};

/** Authoritative food composition data: only these count as generic foods, not whatever lacks a brand. */
export function isGenericSource(source: FoodSource): boolean {
  return source === "afcd" || source === "ausnut" || source === "fndds" || source === "usda";
}

export interface FoodRef {
  readonly source: FoodSource;
  readonly id: string;
}

export interface FoodItem extends Measurable {
  readonly ref: FoodRef;
  readonly name: string;
  readonly brand?: string;
  /** Pack size as printed on the label, e.g. "575 g" (display only). */
  readonly packSize?: string;
  readonly basis: BaseUnit;
  /** Nutrients per 100 units of `basis` (100 g or 100 ml). */
  readonly per100: NutrientProfile;
  readonly portions: readonly Portion[];
  readonly densityGPerMl?: number;
}

/** Nutrients for `quantity` of `unit` (a unit key or `portion:<name>`). */
export function nutrientsForAmount(food: FoodItem, quantity: number, unit: string): NutrientProfile {
  const base = toBaseAmount(food, quantity, unit);
  return scaleProfile(food.per100, base / 100);
}

export function foodLabel(food: { readonly name: string; readonly brand?: string }): string {
  return food.brand ? `${food.name} (${food.brand})` : food.name;
}
