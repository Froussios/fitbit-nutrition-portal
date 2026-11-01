import { kcalToKj, type NutrientProfile } from "../core/nutrients";
import { formatNumber } from "../core/units";

export const fmtKcal = (kcal: number) => formatNumber(kcal, 0);
export const fmtKj = (kcal: number) => formatNumber(kcalToKj(kcal), 0);
export const fmtGrams = (g: number | undefined) => (g === undefined ? "–" : `${formatNumber(g, 1)} g`);

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

export function summary(p: NutrientProfile): string {
  const n = p.nutrients;
  return `${fmtKcal(p.energyKcal)} kcal (${fmtKj(p.energyKcal)} kJ) · protein ${fmtGrams(n.protein)} · carbs ${fmtGrams(n.carbohydrates)} · fat ${fmtGrams(n.fat)}`;
}
