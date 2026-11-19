import type { NutrientProfile } from "./nutrients";

/**
 * Whether a food's stated energy agrees with its fat, carbohydrate and protein (DR-42).
 * Open Food Facts values are typed in by people, and a wrong one usually disagrees with the
 * rest of the label: `Vegemite (Vegemite)` at 6 kcal per 100 g, with 5 g of carbohydrate and no protein.
 */

/** Stated and implied energy may differ by this much: 20%, or 10 kcal for low-energy foods. */
export const ENERGY_CHECK_SHARE = 0.2;
export const ENERGY_CHECK_KCAL = 10;

/** kcal per gram (Atwater factors, as on Australian and EU labels). */
const FAT = 9;
const PROTEIN = 4;
const CARBOHYDRATE = 4;
const FIBRE = 2;
const POLYOLS = 2.4;
/** kcal per 100 ml for each % alcohol by volume: 0.789 g/ml × 7 kcal/g. */
const ALCOHOL_PER_PERCENT = 0.789 * 7;

/** What the label says beyond the nutrients the app keeps, when Open Food Facts records it. */
export interface EnergyExtras {
  /** % alcohol by volume. */
  readonly alcoholPercent?: number;
  /** Grams of sugar alcohols, counted in carbohydrate. */
  readonly polyols?: number;
}

/**
 * The energy per 100 that the macronutrients account for, under each way labels count fibre:
 * outside carbohydrate (Australia, the EU) and inside it (the US). Undefined when fat,
 * carbohydrate or protein is missing.
 */
export function energyFromMacros(per100: NutrientProfile, extras: EnergyExtras = {}): readonly [number, number] | undefined {
  const { fat, carbohydrates, protein } = per100.nutrients;
  if (fat === undefined || carbohydrates === undefined || protein === undefined) return undefined;
  const fibre = per100.nutrients.fiber ?? 0;
  const polyols = Math.min(Math.max(extras.polyols ?? 0, 0), carbohydrates);
  const base =
    FAT * fat +
    PROTEIN * protein +
    (POLYOLS - CARBOHYDRATE) * polyols +
    ALCOHOL_PER_PERCENT * Math.max(extras.alcoholPercent ?? 0, 0) +
    FIBRE * fibre;
  return [base + CARBOHYDRATE * carbohydrates, base + CARBOHYDRATE * Math.max(carbohydrates - fibre, 0)];
}

function agrees(stated: number, implied: number): boolean {
  return Math.abs(stated - implied) <= Math.max(ENERGY_CHECK_KCAL, ENERGY_CHECK_SHARE * Math.max(stated, implied));
}

/**
 * The energy per 100 the macronutrients imply, when the stated energy disagrees with it under
 * either way of counting fibre; undefined when they agree or the food can't be checked.
 */
export function energyMismatch(per100: NutrientProfile, extras: EnergyExtras = {}): number | undefined {
  const implied = energyFromMacros(per100, extras);
  if (!implied || implied.some((kcal) => agrees(per100.energyKcal, kcal))) return undefined;
  // The closer of the two, so the figure shown is the most generous reading of the label.
  return Math.abs(implied[0] - per100.energyKcal) <= Math.abs(implied[1] - per100.energyKcal) ? implied[0] : implied[1];
}
