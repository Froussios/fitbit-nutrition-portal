import { foodLabel, nutrientsForAmount, type FoodItem, type FoodRef } from "../core/food";
import { idFromName, parseEntryId } from "../core/ids";
import { NUTRIENT_KEYS, NUTRIENTS, type NutrientKey, type NutrientProfile } from "../core/nutrients";
import { utcOffsetDuration } from "../core/time";
import { formatNumber, PORTION_PREFIX, toBaseAmount, unitDef, type BaseUnit } from "../core/units";
import type { DataPoint, MealType, NutrientQuantity, NutritionLog } from "./types";

export const NUTRITION_LOG_PARENT = "users/me/dataTypes/nutrition-log";

/** What the user asked to log. */
export interface LogDraft {
  readonly food: FoodItem;
  readonly quantity: number;
  /** A unit key (g, ml, cup...) or `portion:<name>`. */
  readonly unit: string;
  readonly mealType: MealType;
  readonly time: Date;
}

export interface BuildOptions {
  /** Client-supplied data point id (see core/ids.ts). */
  readonly id: string;
  /**
   * Resource names of the API's food-measurement-unit points for gram and
   * millilitre, when the API lets us list them. Without them no `serving` is sent.
   */
  readonly servingUnits?: Partial<Record<BaseUnit, string>>;
}

/** Session length used for a single food entry; the API needs an end time. */
const ENTRY_DURATION_MS = 60_000;

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Builds an anonymous nutrition-log data point: name and nutrients come from
 * our own food data. Anonymous logs cannot be updated, so edits are
 * delete-and-recreate.
 */
export function buildNutritionLogPoint(draft: LogDraft, opts: BuildOptions): DataPoint {
  const { food, quantity, unit } = draft;
  const baseAmount = toBaseAmount(food, quantity, unit);
  const profile = nutrientsForAmount(food, quantity, unit);

  const end = new Date(draft.time.getTime() + ENTRY_DURATION_MS);
  const log: NutritionLog = {
    interval: {
      startTime: draft.time.toISOString(),
      endTime: end.toISOString(),
      startUtcOffset: utcOffsetDuration(draft.time),
      endUtcOffset: utcOffsetDuration(end),
    },
    // The amount goes into the name because Health Connect keeps no serving size.
    foodDisplayName: `${foodLabel(food)} (${amountLabel(food, quantity, unit, baseAmount)})`,
    mealType: draft.mealType,
    energy: { kcal: round(profile.energyKcal, 1), userProvidedUnit: "KILOCALORIE" },
    ...profileToLogFields(profile),
  };

  const servingUnit = opts.servingUnits?.[food.basis];
  if (servingUnit) log.serving = { foodMeasurementUnit: servingUnit, amount: round(baseAmount, 2) };

  return { name: `${NUTRITION_LOG_PARENT}/dataPoints/${opts.id}`, nutritionLog: log };
}

/** "250 g" as typed for plain units; portions resolve to the base amount ("40 g", not "1 × 1/2 cup (40 g)"). */
function amountLabel(food: FoodItem, quantity: number, unit: string, baseAmount: number): string {
  if (unit.startsWith(PORTION_PREFIX)) return `${formatNumber(baseAmount)} ${food.basis}`;
  return `${formatNumber(quantity)} ${unitDef(unit)?.key ?? unit}`;
}

function profileToLogFields(profile: NutrientProfile): Pick<NutritionLog, "totalFat" | "totalCarbohydrate" | "nutrients"> {
  const out: Pick<NutritionLog, "totalFat" | "totalCarbohydrate" | "nutrients"> = {};
  const list: NutrientQuantity[] = [];
  for (const key of NUTRIENT_KEYS) {
    const grams = profile.nutrients[key];
    if (grams === undefined) continue;
    const quantity = { grams: round(grams, 4) };
    const target = NUTRIENTS[key].google;
    if ("field" in target) out[target.field] = quantity;
    else list.push({ nutrient: target.nutrient, quantity });
  }
  if (list.length) out.nutrients = list;
  return out;
}

/** A diary row as the UI shows it, from any source (this app, Google Health app, Health Connect). */
export interface DiaryEntry {
  readonly name: string;
  readonly id: string;
  readonly start: Date;
  readonly mealType: MealType;
  readonly displayName: string;
  readonly profile: NutrientProfile;
  /** Food reference, when the entry was written by this app. */
  readonly ref?: FoodRef;
  readonly platform?: string;
}

const NUTRIENT_BY_GOOGLE = new Map<string, NutrientKey>(
  NUTRIENT_KEYS.flatMap((k) => {
    const g = NUTRIENTS[k].google;
    return "nutrient" in g ? [[g.nutrient, k] as const] : [];
  }),
);

export function toDiaryEntry(point: DataPoint): DiaryEntry | undefined {
  const log = point.nutritionLog;
  if (!log || !point.name) return undefined;

  const nutrients: Partial<Record<NutrientKey, number>> = {};
  if (log.totalFat) nutrients.fat = log.totalFat.grams;
  if (log.totalCarbohydrate) nutrients.carbohydrates = log.totalCarbohydrate.grams;
  for (const n of log.nutrients ?? []) {
    const key = NUTRIENT_BY_GOOGLE.get(n.nutrient);
    if (key) nutrients[key] = n.quantity.grams;
    // Some clients may send carbohydrates as a nutrient instead of the top-level field.
    else if (n.nutrient === "CARBOHYDRATES" && nutrients.carbohydrates === undefined) nutrients.carbohydrates = n.quantity.grams;
  }

  const id = idFromName(point.name);
  const ref = parseEntryId(id)?.ref;
  const entry: DiaryEntry = {
    name: point.name,
    id,
    start: new Date(log.interval.startTime),
    mealType: log.mealType ?? "MEAL_TYPE_UNSPECIFIED",
    displayName: log.foodDisplayName ?? "(unnamed food)",
    profile: { energyKcal: log.energy?.kcal ?? 0, nutrients },
    ...(ref ? { ref } : {}),
    ...(point.dataSource?.platform ? { platform: point.dataSource.platform } : {}),
  };
  return entry;
}

/** Entries in chronological order (the API returns newest first). */
export function toDiaryEntries(points: readonly DataPoint[]): DiaryEntry[] {
  return points
    .map(toDiaryEntry)
    .filter((e): e is DiaryEntry => e !== undefined)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Finds the gram and millilitre units among the API's food-measurement-unit points. */
export function findServingUnits(points: readonly DataPoint[]): Partial<Record<BaseUnit, string>> {
  const out: Partial<Record<BaseUnit, string>> = {};
  for (const p of points) {
    const n = p.foodMeasurementUnit?.displayName?.trim().toLowerCase();
    if (!p.name || !n) continue;
    if (n === "gram" || n === "g") out.g ??= p.name;
    if (n === "milliliter" || n === "millilitre" || n === "ml") out.ml ??= p.name;
  }
  return out;
}

export const MEAL_TYPES: readonly { value: MealType; label: string }[] = [
  { value: "BREAKFAST", label: "Breakfast" },
  { value: "LUNCH", label: "Lunch" },
  { value: "DINNER", label: "Dinner" },
  { value: "SNACK", label: "Snack" },
  { value: "ANYTIME", label: "Anytime" },
];

export function mealLabel(type: MealType): string {
  return MEAL_TYPES.find((m) => m.value === type)?.label ?? type.replace(/_/g, " ").toLowerCase();
}

/** Default meal for a time of day (local). */
export function defaultMealType(d: Date): MealType {
  const h = d.getHours();
  if (h >= 4 && h < 11) return "BREAKFAST";
  if (h >= 11 && h < 15) return "LUNCH";
  if (h >= 17 && h < 22) return "DINNER";
  return "SNACK";
}
