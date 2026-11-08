import { canReload, foodLabel, nutrientsForAmount, type FoodItem, type FoodRef } from "../core/food";
import { idFromName, parseEntryId } from "../core/ids";
import type { LoggedFood } from "../core/logged-foods";
import { NUTRIENT_KEYS, NUTRIENTS, type NutrientKey, type NutrientProfile } from "../core/nutrients";
import { utcOffsetDuration } from "../core/time";
import { formatAmount, formatMeasurementLabel, formatNumber, metricAmount, PORTION_PREFIX, toBaseAmount, type BaseUnit, type Measurable } from "../core/units";
import type { DataPoint, EnergyQuantity, MealType, NutrientQuantity, NutritionLog, WeightQuantity } from "./types";

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

/**
 * A portion of a meal prep (#55): one entry with the batch's nutrients scaled to the portion. It has no `serving`,
 * because the ingredients don't add up to the cooked weight, so the fraction goes in the name (`Chili (1/6)`).
 */
export function buildPortionPoint(portion: { readonly name: string; readonly profile: NutrientProfile; readonly mealType?: MealType | undefined; readonly time: Date }, id: string): DataPoint {
  const end = new Date(portion.time.getTime() + ENTRY_DURATION_MS);
  const log: NutritionLog = {
    interval: {
      startTime: portion.time.toISOString(),
      endTime: end.toISOString(),
      startUtcOffset: utcOffsetDuration(portion.time),
      endUtcOffset: utcOffsetDuration(end),
    },
    foodDisplayName: portion.name,
    ...(portion.mealType ? { mealType: portion.mealType } : {}),
    energy: { kcal: round(portion.profile.energyKcal, 1), userProvidedUnit: "KILOCALORIE" },
    ...profileToLogFields(portion.profile),
  };
  return { name: `${NUTRITION_LOG_PARENT}/dataPoints/${id}`, nutritionLog: log };
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

/**
 * An equivalent entry to write back after a delete: the same food, time and nutrients,
 * under a new ID (whether a deleted ID can be reused is still open, #18), without the
 * read-only fields the API added when it listed the original.
 */
export function copyNutritionLogPoint(log: NutritionLog, id: string): DataPoint {
  const { startTime, endTime, startUtcOffset, endUtcOffset } = log.interval;
  const copy: NutritionLog = { ...log, interval: { startTime, endTime, startUtcOffset, endUtcOffset } };
  if (log.serving) {
    const { foodMeasurementUnit, amount } = log.serving;
    copy.serving = { foodMeasurementUnit, ...(amount !== undefined ? { amount } : {}) };
  }
  return { name: `${NUTRITION_LOG_PARENT}/dataPoints/${id}`, nutritionLog: copy };
}

/** How much of a food an entry says was eaten. */
export interface LoggedAmount {
  readonly amount: number;
  readonly unit: BaseUnit;
}

/**
 * The name this app knows for a unit resource. Google lists units under the user's own ID
 * (`users/<user ID>/dataTypes/food-measurement-unit/dataPoints/147`), but entries refer to the same
 * unit under `users/me/`, so the user part cannot be compared as written.
 */
function nameOfUnit(unitNames: ReadonlyMap<string, string> | undefined, unit: string): string | undefined {
  if (!unitNames) return undefined;
  const exact = unitNames.get(unit);
  if (exact !== undefined) return exact;
  const anyUser = (name: string) => name.replace(/^users\/[^/]+\//, "users/me/");
  const wanted = anyUser(unit);
  for (const [name, displayName] of unitNames) if (anyUser(name) === wanted) return displayName;
  return undefined;
}

/** Which base unit a name means. Loose, because the API's wording is not specified: "gram", "Grams", "gram (g)". */
function baseUnitNamed(name: string | undefined): BaseUnit | undefined {
  const n = name?.trim().toLowerCase() ?? "";
  if (/^(?:g|gm|grams?|grammes?)\b/.test(n)) return "g";
  if (/^(?:ml|millilit(?:er|re)s?)\b/.test(n)) return "ml";
  return undefined;
}

/**
 * The amount in an entry: from `serving`, or from its name when the API's units could not be
 * resolved. The unit resource this app looked up decides first, since it wrote the entry with it.
 * Undefined when it has none to work from, such as a meal prep portion (`Chili (1/6)`).
 */
export function loggedAmount(log: NutritionLog, unitNames?: ReadonlyMap<string, string>): LoggedAmount | undefined {
  if (log.serving) {
    const { amount, foodMeasurementUnit, foodMeasurementUnitDisplayName } = log.serving;
    const unit = baseUnitNamed(nameOfUnit(unitNames, foodMeasurementUnit)) ?? baseUnitNamed(foodMeasurementUnitDisplayName);
    const value = Number(amount);
    return unit && value > 0 ? { amount: value, unit } : undefined;
  }
  const inName = AMOUNT_IN_NAME.exec(log.foodDisplayName ?? "");
  const amount = Number(inName?.[1]?.replace(/,/g, ""));
  return inName && amount > 0 ? { amount, unit: inName[2] as BaseUnit } : undefined;
}

/** What converts amounts for an entry with no food record: the units of the kind it was logged in. */
export function basicMeasure(unit: BaseUnit): Measurable {
  return { basis: unit, portions: [] };
}

/** The portion that stands for an entry as it was logged, when nothing says how much that was: 2 of it doubles every value. */
export const AS_LOGGED = "this entry";
export const AS_LOGGED_UNIT = PORTION_PREFIX + AS_LOGGED;

/** What measures an entry whose amount can't be read and whose food isn't found: only "× this entry". */
export function asLoggedMeasure(): Measurable {
  return { basis: "g", portions: [{ name: AS_LOGGED, amount: 1, unit: "g" }], portionsOnly: true };
}

/** Whether a food can convert the entry's amount. It may have lost its density since the entry was logged. */
export function canConvertLogged(food: Measurable, logged: LoggedAmount): boolean {
  try {
    toBaseAmount(food, logged.amount, logged.unit);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an amount is the one logged. Across units, the number in the form was rounded when the unit
 * changed, so a small difference is not an edit: 40 g shown as 1.41 oz stays 40 g.
 */
export function isLoggedAmount(logged: LoggedAmount, measure: Measurable, quantity: number, unit: string): boolean {
  if (unit === logged.unit) return quantity === logged.amount;
  return Math.abs(toBaseAmount(measure, quantity, unit) / toBaseAmount(measure, logged.amount, logged.unit) - 1) < 0.005;
}

export interface AmountEdit {
  readonly quantity: number;
  /** A unit key (g, ml, cup...) or `portion:<name>`. */
  readonly unit: string;
  /** The food's record, when the catalogue has it. Without one, the logged values are scaled. */
  readonly food?: FoodItem;
}

export interface EntryEdit {
  /** Left out for no meal. */
  readonly mealType?: MealType;
  /** Left out when the amount stays as logged, so the nutrients do too. */
  readonly amount?: AmountEdit;
}

export interface EditOptions extends BuildOptions {
  readonly unitNames?: ReadonlyMap<string, string>;
}

function scaleLog(log: NutritionLog, factor: number): NutritionLog {
  const energy = (q: EnergyQuantity) => ({ ...q, kcal: round(q.kcal * factor, 1) });
  const weight = (q: WeightQuantity) => ({ ...q, grams: round(q.grams * factor, 4) });
  return {
    ...log,
    ...(log.energy ? { energy: energy(log.energy) } : {}),
    ...(log.energyFromFat ? { energyFromFat: energy(log.energyFromFat) } : {}),
    ...(log.totalFat ? { totalFat: weight(log.totalFat) } : {}),
    ...(log.totalCarbohydrate ? { totalCarbohydrate: weight(log.totalCarbohydrate) } : {}),
    ...(log.nutrients ? { nutrients: log.nutrients.map((n) => ({ ...n, quantity: weight(n.quantity) })) } : {}),
  };
}

/** An entry's log at a new amount: calculated again from the food's record if there is one, else scaled from the logged values. */
function atNewAmount(log: NutritionLog, edit: AmountEdit, opts: EditOptions): NutritionLog {
  const logged = loggedAmount(log, opts.unitNames);
  const { food, quantity, unit } = edit;
  if (!food && unit === AS_LOGGED_UNIT) {
    // A multiple of the entry: every value scales, the serving too if it has a number, whatever its unit.
    const out = scaleLog(copyNutritionLogPoint(log, opts.id).nutritionLog!, quantity);
    const served = Number(out.serving?.amount);
    if (out.serving && served > 0) out.serving = { ...out.serving, amount: round(served * quantity, 2) };
    return out;
  }
  // The food's record needs nothing from the entry. Scaling needs its amount.
  const measure = food ?? (logged && basicMeasure(logged.unit));
  if (!measure) throw new Error("This entry has no amount to change.");
  const copy = copyNutritionLogPoint(log, opts.id).nutritionLog!;
  // The entry's own unit needs no lookup, and the food stays under the name it was logged with.
  const servingUnits = { ...opts.servingUnits, ...(log.serving && logged ? { [logged.unit]: log.serving.foodMeasurementUnit } : {}) };
  const out: NutritionLog = food
    ? { ...buildNutritionLogPoint({ food, quantity, unit, time: new Date(log.interval.startTime) }, { id: opts.id, servingUnits }).nutritionLog!, interval: copy.interval }
    : scaleLog(copy, toBaseAmount(measure, quantity, unit) / logged!.amount);

  const metric = metricAmount(measure, quantity, unit);
  const servingUnit = servingUnits[metric.unit];
  const name = log.serving ? (log.foodDisplayName ?? "") : (log.foodDisplayName ?? "").replace(AMOUNT_IN_NAME, "");
  if (servingUnit) {
    out.foodDisplayName = name;
    out.serving = { foodMeasurementUnit: servingUnit, amount: round(metric.amount, 2) };
  } else {
    out.foodDisplayName = `${name} (${formatNumber(metric.amount)} ${metric.unit})`;
    delete out.serving;
  }
  return out;
}

/** The entry that replaces one the user edited. Time and name stay as logged; only a new amount changes the nutrients. */
export function editedNutritionLogPoint(log: NutritionLog, edit: EntryEdit, opts: EditOptions): DataPoint {
  const nutritionLog = edit.amount ? atNewAmount(log, edit.amount, opts) : copyNutritionLogPoint(log, opts.id).nutritionLog!;
  if (edit.mealType) nutritionLog.mealType = edit.mealType;
  else delete nutritionLog.mealType;
  return { name: `${NUTRITION_LOG_PARENT}/dataPoints/${opts.id}`, nutritionLog };
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
  /** The data point it was read from, which undoing a delete writes again. */
  readonly point: DataPoint;
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
  const name = (s.foodMeasurementUnitDisplayName ?? nameOfUnit(unitNames, s.foodMeasurementUnit) ?? "").trim();
  return `${formatAmount(s.amount)} ${UNIT_ABBREVIATIONS[name.toLowerCase()] ?? formatMeasurementLabel(name)}`.trim();
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
    displayName: (log.foodDisplayName ?? "(unnamed food)").replace(AMOUNT_IN_NAME, (text) => formatMeasurementLabel(text)),
    ...(amount ? { amount } : {}),
    profile: { energyKcal: log.energy?.kcal ?? 0, nutrients },
    own,
    ...(ref ? { ref } : {}),
    ...(label ? { sourceLabel: label } : {}),
    point,
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

/** The points whose entries the user has not deleted: the API may keep listing a deleted one for a while. */
export function withoutEntries(points: readonly DataPoint[], ids: ReadonlySet<string>): DataPoint[] {
  return points.filter((p) => !p.name || !ids.has(idFromName(p.name)));
}

/** Chronological order, for the diary's rows. */
export function byTime(a: DiaryEntry, b: DiaryEntry): number {
  return a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The order of the day's meals. Entries with no meal come last. */
const MEAL_ORDER: readonly MealType[] = ["BEFORE_BREAKFAST", "BREAKFAST", "BEFORE_LUNCH", "LUNCH", "BEFORE_DINNER", "DINNER", "AFTER_DINNER", "SNACK", "ANYTIME", "MEAL_TYPE_UNSPECIFIED"];

/** A meal's place in MEAL_ORDER. A value the API adds later goes last, with no meal. */
function mealRank(type: MealType): number {
  const i = MEAL_ORDER.indexOf(type);
  return i < 0 ? MEAL_ORDER.length : i;
}

/** The diary's row order: by meal, then chronological within a meal. */
export function byMeal(a: DiaryEntry, b: DiaryEntry): number {
  return mealRank(a.mealType) - mealRank(b.mealType) || byTime(a, b);
}

/** Entries in chronological order (the API returns newest first). */
export function toDiaryEntries(points: readonly DataPoint[], ctx: DiaryContext = {}): DiaryEntry[] {
  return points
    .map((p) => toDiaryEntry(p, ctx))
    .filter((e): e is DiaryEntry => e !== undefined)
    .sort(byTime);
}

/** The amount buildNutritionLogPoint puts in the name when the API's unit could not be resolved. */
const AMOUNT_IN_NAME = / \(([\d,.]+) (g|ml)\)$/;

/**
 * The entries a search can boost: this app's, with a food the catalogue can load again.
 * That leaves out other apps' entries, which have no food reference, and custom foods.
 */
export function toLoggedFoods(points: readonly DataPoint[], ownClientId?: string): LoggedFood[] {
  return points.flatMap((point) => {
    const entry = toDiaryEntry(point, ownClientId === undefined ? {} : { ownClientId });
    if (!entry?.ref || !canReload(entry.ref.source)) return [];
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
