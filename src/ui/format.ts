import { kcalToKj, type NutrientProfile } from "../core/nutrients";
import { formatNumber } from "../core/units";
import { getEnergyUnit, type EnergyUnit } from "./energy-unit";

/** An amount of energy in the chosen unit, without the unit's name. */
export const fmtEnergy = (kcal: number, unit: EnergyUnit = getEnergyUnit()) => formatNumber(unit === "kj" ? kcalToKj(kcal) : kcal, 0);
export const energyLabel = (unit: EnergyUnit = getEnergyUnit()) => (unit === "kj" ? "kJ" : "kcal");
export const fmtGrams = (g: number | undefined) => (g === undefined ? "–" : `${formatNumber(g, 1)} g`);

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

export function summary(p: NutrientProfile, unit: EnergyUnit = getEnergyUnit()): string {
  const n = p.nutrients;
  return `${fmtEnergy(p.energyKcal, unit)} ${energyLabel(unit)} · protein ${fmtGrams(n.protein)} · carbs ${fmtGrams(n.carbohydrates)} · fat ${fmtGrams(n.fat)}`;
}
