import { foodLabel, nutrientsForAmount, type FoodItem, type FoodRef } from "../core/food";
import { idFromName, parseEntryId } from "../core/ids";
import type { LoggedFood } from "../core/logged-foods";
import { NUTRIENT_KEYS, NUTRIENTS, type NutrientKey, type NutrientProfile } from "../core/nutrients";
import { utcOffsetDuration } from "../core/time";
import { formatNumber, metricAmount, type BaseUnit } from "../core/units";
import type { DataPoint, MealType, NutrientQuantity, NutritionLog } from "./types";

export const NUTRITION_LOG_PARENT = "users/me/dataTypes/nutrition-log";

/** What the user asked to log. */
export interface LogDraft {
  readonly food: FoodItem;
  readonly quantity: number;
  /** A unit key (g, ml, cup...) or `portion:<name>`. */
  readonly unit: string;
  /** Left out when the user picks no meal: the API field is optional. */
  readonly mealType?: MealType;
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
  const profile = nutrientsForAmount(food, quantity, unit);
  const metric = metricAmount(food, quantity, unit);
  const servingUnit = opts.servingUnits?.[metric.unit];

  const end = new Date(draft.time.getTime() + ENTRY_DURATION_MS);
  const log: NutritionLog = {
    interval: {
      startTime: draft.time.toISOString(),
      endTime: end.toISOString(),
      startUtcOffset: utcOffsetDuration(draft.time),
      endUtcOffset: utcOffsetDuration(end),
    },
    // The amount belongs in `serving`; it goes into the name only when the API's unit could not be resolved.
    foodDisplayName: servingUnit ? foodLabel(food) : `${foodLabel(food)} (${formatNumber(metric.amount)} ${metric.unit})`,
    ...(draft.mealType ? { mealType: draft.mealType } : {}),
    energy: { kcal: round(profile.energyKcal, 1), userProvidedUnit: "KILOCALORIE" },
    ...profileToLogFields(profile),
  };

  if (servingUnit) log.serving = { foodMeasurementUnit: servingUnit, amount: round(metric.amount, 2) };

  return { name: `${NUTRITION_LOG_PARENT}/dataPoints/${opts.id}`, nutritionLog: log };
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

/** A diary row as the UI shows it, from any writer (this app, the Google Health app, other API clients). */
export interface DiaryEntry {
  readonly name: string;
  readonly id: string;
  readonly start: Date;
  readonly mealType: MealType;
  readonly displayName: string;
  /** The serving, e.g. "40 g" or "1 cup", when the entry has one. */
  readonly amount?: string;
  readonly profile: NutrientProfile;
  /** Food reference, when the entry was written by this app. */
  readonly ref?: FoodRef;
  /** Written by this app, so it may be deleted or edited with the write scope. */
  readonly own: boolean;
  /** Who wrote it, for entries from other apps ("Google Health app", "com.example.app"...). */
  readonly sourceLabel?: string;
}

const NUTRIENT_BY_GOOGLE = new Map<string, NutrientKey>(
  NUTRIENT_KEYS.flatMap((k) => {
    const g = NUTRIENTS[k].google;
    return "nutrient" in g ? [[g.nutrient, k] as const] : [];
  }),
);

const KNOWN_PACKAGES: Record<string, string> = {
  "com.google.fitbit": "Google Health app",
  "com.fitbit.FitbitMobile": "Google Health app",
};

const PLATFORM_LABELS: Record<string, string> = {
  FITBIT: "Fitbit",
  HEALTH_CONNECT: "Health Connect",
  HEALTH_KIT: "Apple Health",
  FIT: "Google Fit",
  FITBIT_WEB_API: "Fitbit Web API app",
  GOOGLE_WEB_API: "Google Health API app",
  GOOGLE_PARTNER_INTEGRATION: "Partner app",
};

function sourceLabel(point: DataPoint): string | undefined {
  const app = point.dataSource?.application;
  const pkg = app?.packageName;
  if (pkg) return KNOWN_PACKAGES[pkg] ?? pkg;
  const platform = point.dataSource?.platform;
  return platform ? (PLATFORM_LABELS[platform] ?? platform) : undefined;
}

export interface DiaryContext {
  /** This app's OAuth client ID; entries recorded with it are ours. */
  readonly ownClientId?: string;
  /** food-measurement-unit resource name → display name, for servings that arrive without one. */
  readonly unitNames?: ReadonlyMap<string, string>;
}

const UNIT_ABBREVIATIONS: Record<string, string> = { gram: "g", grams: "g", milliliter: "ml", millilitre: "ml", milliliters: "ml" };

function servingText(log: NutritionLog, unitNames?: ReadonlyMap<string, string>): string | undefined {
  const s = log.serving;
  if (!s || s.amount === undefined) return undefined;
  const name = (s.foodMeasurementUnitDisplayName ?? unitNames?.get(s.foodMeasurementUnit) ?? "").trim();
  return `${formatNumber(s.amount)} ${UNIT_ABBREVIATIONS[name.toLowerCase()] ?? name}`.trim();
}

export function toDiaryEntry(point: DataPoint, ctx: DiaryContext = {}): DiaryEntry | undefined {
  const { ownClientId } = ctx;
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
  const writer = point.dataSource?.application?.googleWebClientId;
  // Our ID format is the fallback for points read back before dataSource is filled in.
  const own = writer !== undefined ? writer === ownClientId : parseEntryId(id) !== undefined;
  const ref = own ? parseEntryId(id)?.ref : undefined;
  const label = own ? undefined : sourceLabel(point);
  const amount = servingText(log, ctx.unitNames);
  const entry: DiaryEntry = {
    name: point.name,
    id,
    start: new Date(log.interval.startTime),
    mealType: log.mealType ?? "MEAL_TYPE_UNSPECIFIED",
    displayName: log.foodDisplayName ?? "(unnamed food)",
    ...(amount ? { amount } : {}),
    profile: { energyKcal: log.energy?.kcal ?? 0, nutrients },
    own,
    ...(ref ? { ref } : {}),
    ...(label ? { sourceLabel: label } : {}),
  };
  return entry;
}

/**
 * Identifies the same nutrition log in our request and in the API's copy by
 * content (start second, name, rounded energy), for when the API stores it
 * under a different ID than the one we asked for.
 */
export function entryFingerprint(point: DataPoint): string | undefined {
  const log = point.nutritionLog;
  if (!log) return undefined;
  const start = Date.parse(log.interval.startTime);
  if (Number.isNaN(start)) return undefined;
  return `${Math.floor(start / 1000)}|${(log.foodDisplayName ?? "").trim().toLowerCase()}|${Math.round(log.energy?.kcal ?? 0)}`;
}

/**
 * Splits locally pending points (written but maybe not yet listed) into those
 * the listing already contains and those still pending. A pending point matches
 * a listed one by ID, or else by content (for when the API stored it under its
 * own ID). Content matches are one-to-one, so two identical entries logged in
 * the same minute need two listed copies, and only consider listed points this
 * app wrote (when the API says who wrote them).
 */
export function reconcilePending(
  pending: ReadonlyMap<string, DataPoint>,
  listed: readonly DataPoint[],
  ownClientId?: string,
): { listedById: string[]; listedByContent: string[]; stillPending: string[] } {
  const result = { listedById: [] as string[], listedByContent: [] as string[], stillPending: [] as string[] };
  const listedIds = new Set(listed.flatMap((p) => (p.name ? [idFromName(p.name)] : [])));

  // Listed points not claimed by an ID match are available for content matches, once each.
  const available = new Map<string, number>();
  for (const p of listed) {
    if (p.name && pending.has(idFromName(p.name))) continue;
    const writer = p.dataSource?.application?.googleWebClientId;
    if (ownClientId !== undefined && writer !== undefined && writer !== ownClientId) continue;
    const print = entryFingerprint(p);
    if (print !== undefined) available.set(print, (available.get(print) ?? 0) + 1);
  }

  for (const [key, point] of pending) {
    if (listedIds.has(key)) {
      result.listedById.push(key);
      continue;
    }
    const print = entryFingerprint(point);
    const left = print === undefined ? 0 : (available.get(print) ?? 0);
    if (print !== undefined && left > 0) {
      available.set(print, left - 1);
      result.listedByContent.push(key);
    } else {
      result.stillPending.push(key);
    }
  }
  return result;
}

/** Entries in chronological order (the API returns newest first). */
export function toDiaryEntries(points: readonly DataPoint[], ctx: DiaryContext = {}): DiaryEntry[] {
  return points
    .map((p) => toDiaryEntry(p, ctx))
    .filter((e): e is DiaryEntry => e !== undefined)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The amount buildNutritionLogPoint puts in the name when the API's unit could not be resolved. */
const AMOUNT_IN_NAME = / \([\d,.]+ (?:g|ml)\)$/;

/**
 * The entries a search can boost: this app's, with a food the catalogue can load again.
 * That leaves out other apps' entries, which have no food reference, and custom foods.
 */
export function toLoggedFoods(points: readonly DataPoint[], ownClientId?: string): LoggedFood[] {
  return points.flatMap((point) => {
    const entry = toDiaryEntry(point, ownClientId === undefined ? {} : { ownClientId });
    if (!entry?.ref || entry.ref.source === "manual") return [];
    return [{ id: entry.id, ref: entry.ref, label: entry.displayName.replace(AMOUNT_IN_NAME, ""), at: entry.start.getTime() }];
  });
}

/** Finds the gram and millilitre units among the API's food-measurement-unit points. */
export function unitNamesOf(points: readonly DataPoint[]): Map<string, string> {
  return new Map(points.flatMap((p) => (p.name && p.foodMeasurementUnit ? [[p.name, p.foodMeasurementUnit.displayName] as const] : [])));
}

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
];

export function mealLabel(type: MealType): string {
  if (type === "MEAL_TYPE_UNSPECIFIED") return "–";
  return MEAL_TYPES.find((m) => m.value === type)?.label ?? type.replace(/_/g, " ").toLowerCase();
}
