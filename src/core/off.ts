import type { FoodItem } from "./food";
import { kjToKcal, NUTRIENT_KEYS, NUTRIENTS, type NutrientKey, type NutrientProfile } from "./nutrients";
import type { BaseUnit, Portion } from "./units";

/**
 * The subset of an Open Food Facts product record that the app reads. Same
 * shape in the API and in the data dumps a mirror would be built from.
 * https://openfoodfacts.github.io/openfoodfacts-server/api/
 */
export interface OffProduct {
  code: string;
  product_name?: string;
  brands?: string;
  /** Free-text pack size, e.g. "375 ml". */
  quantity?: string;
  product_quantity?: number | string;
  product_quantity_unit?: string;
  /** Free-text serving, e.g. "1 cup (40 g)". */
  serving_size?: string;
  serving_quantity?: number | string;
  serving_quantity_unit?: string;
  /** "100g" or "serving" (legacy); newer schemas may state "100ml". */
  nutrition_data_per?: string;
  nutriments?: Record<string, number | string | undefined>;
}

export class OffNormalizationError extends Error {
  override name = "OffNormalizationError";
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function baseUnitOf(unit: string | undefined): BaseUnit | undefined {
  const u = unit?.trim().toLowerCase();
  if (u === "g" || u === "kg" || u === "mg") return "g";
  if (u === "ml" || u === "l" || u === "cl" || u === "dl") return "ml";
  return undefined;
}

function toBase(amount: number, unit: string | undefined): number {
  switch (unit?.trim().toLowerCase()) {
    case "kg":
    case "l":
      return amount * 1000;
    case "dl":
      return amount * 100;
    case "cl":
      return amount * 10;
    case "mg":
      return amount / 1000;
    default:
      return amount;
  }
}

/**
 * Decides whether `<nutrient>_100g` means per 100 g or per 100 ml.
 * OFF keeps the `_100g` suffix for liquids, so we rely on the stated basis
 * when present and otherwise on the units the product's quantities use.
 */
export function offBasis(p: OffProduct): BaseUnit {
  const per = p.nutrition_data_per?.toLowerCase();
  if (per === "100ml") return "ml";
  // Legacy records say "100g" even for drinks, so a liquid pack or serving size wins.
  return baseUnitOf(p.product_quantity_unit) ?? baseUnitOf(p.serving_quantity_unit) ?? "g";
}

/** Converts an Open Food Facts product into the app's FoodItem (nutrients per 100 g/ml). */
export function fromOffProduct(p: OffProduct): FoodItem {
  const n = p.nutriments ?? {};
  const basis = offBasis(p);

  const servingQty = num(p.serving_quantity);
  const servingBase = servingQty !== undefined ? toBase(servingQty, p.serving_quantity_unit) : undefined;

  // Prefer per-100 values; fall back to per-serving values when the serving size is known.
  const read = (key: string): number | undefined => {
    const per100 = num(n[`${key}_100g`]);
    if (per100 !== undefined) return per100;
    const perServing = num(n[`${key}_serving`]);
    if (perServing !== undefined && servingBase) return (perServing / servingBase) * 100;
    return undefined;
  };

  const kcal = read("energy-kcal") ?? mapDefined(read("energy-kj") ?? read("energy"), kjToKcal);
  if (kcal === undefined) {
    throw new OffNormalizationError(`Product ${p.code} has no usable energy value`);
  }

  const nutrients: Partial<Record<NutrientKey, number>> = {};
  for (const key of NUTRIENT_KEYS) {
    const v = read(NUTRIENTS[key].off);
    if (v !== undefined) nutrients[key] = v;
  }
  const per100: NutrientProfile = { energyKcal: kcal, nutrients };

  const portions: Portion[] = [];
  if (servingBase && baseUnitOf(p.serving_quantity_unit ?? basis)) {
    const unit = baseUnitOf(p.serving_quantity_unit) ?? basis;
    portions.push({ name: p.serving_size?.trim() || "serving", amount: servingBase, unit });
  }
  const packQty = num(p.product_quantity);
  const packUnit = baseUnitOf(p.product_quantity_unit);
  if (packQty && packUnit) {
    portions.push({ name: p.quantity ? `pack (${p.quantity.trim()})` : "pack", amount: toBase(packQty, p.product_quantity_unit), unit: packUnit });
  }

  const item: FoodItem = {
    ref: { source: "off", id: p.code },
    name: p.product_name?.trim() || `Product ${p.code}`,
    basis,
    per100,
    portions,
  };
  const brand = p.brands?.split(",")[0]?.trim();
  const packSize = p.quantity?.trim();
  return { ...item, ...(brand ? { brand } : {}), ...(packSize ? { packSize } : {}) };
}

function mapDefined<T, R>(v: T | undefined, f: (v: T) => R): R | undefined {
  return v === undefined ? undefined : f(v);
}
