import { kcalToKj, type NutrientProfile } from "../core/nutrients";
import { formatNumber } from "../core/units";
import { getEnergyUnit, type EnergyUnit } from "./energy-unit";

/** An amount of energy in the chosen unit, without the unit's name. */
export const fmtEnergy = (kcal: number, unit: EnergyUnit = getEnergyUnit()) => formatNumber(unit === "kj" ? kcalToKj(kcal) : kcal, 0);
export const energyLabel = (unit: EnergyUnit = getEnergyUnit()) => (unit === "kj" ? "kJ" : "kcal");
export const fmtGrams = (g: number | undefined) => (g === undefined ? "–" : `${formatNumber(g, 1)} g`);

export function summary(p: NutrientProfile, unit: EnergyUnit = getEnergyUnit()): string {
  const n = p.nutrients;
  return `${fmtEnergy(p.energyKcal, unit)} ${energyLabel(unit)} · protein ${fmtGrams(n.protein)} · carbs ${fmtGrams(n.carbohydrates)} · fat ${fmtGrams(n.fat)}`;
}

/** A share of a meal prep's batch, e.g. "60%". */
export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

const DAY_MS = 24 * 60 * 60_000;

/** How long ago a meal prep was made, e.g. "made 2 days ago". */
export function madeAgo(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / DAY_MS);
  return days <= 0 ? "made today" : days === 1 ? "made yesterday" : `made ${days} days ago`;
}
