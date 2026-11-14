/**
 * Meal prep (#55, DR-24): a batch cooked once and eaten in fractions. Pure, and shared by the
 * browser and the meal prep API, so that both read and check the same shapes.
 *
 * A fraction is always of the whole batch: 1/6 means a sixth of what was cooked, not of what is left.
 */

import { foodLabel, type FoodItem, type FoodRef, type FoodSource } from "./food";
import { NUTRIENT_KEYS, scaleProfile, sumProfiles, type NutrientKey, type NutrientProfile } from "./nutrients";
import { PORTION_PREFIX } from "./units";

/** Below this, a fraction counts as nothing: 1/3 + 1/3 + 1/3 must leave nothing, despite rounding. */
export const FRACTION_EPSILON = 1e-6;
/** Finished and discarded preps stay this long, so that an undo can bring them back (DR-24). */
export const KEEP_ENDED_MS = 30 * 24 * 60 * 60_000;

export const PREP_ID = /^[a-z0-9]{8,16}$/;
export const PORTION_ID = /^[a-z0-9]{8,32}$/;
export const ENTRY_ID = /^[a-z0-9-]{4,63}$/;
export const MAX_NAME = 80;
export const MAX_INGREDIENTS = 60;
/**
 * The longest food ID, label and unit an ingredient may have, in UTF-16 units as `String.length` counts them. The food
 * index builders skip any food that would break one (`ingredientLimitProblem`), so every food in search can be saved.
 * Generous on purpose: Open Food Facts is trusted, and its long names, brands and serving texts are real (#91).
 */
export const MAX_FOOD_ID = 100;
/** A food's name and brand, as `foodLabel` joins them: the builder keeps 150 characters of the name, and the brand is uncapped. */
export const MAX_LABEL = 300;
/** A unit key, or `portion:` and the portion's name, such as a serving text from Open Food Facts. */
export const MAX_UNIT = 160;

/** One ingredient, with the nutrients worked out when cooking: custom foods can't be reloaded, and the index changes weekly. */
export interface PrepIngredient {
  readonly ref: FoodRef;
  /** The food's name as shown, e.g. `Rolled oats (Uncle Tobys)`. */
  readonly label: string;
  readonly quantity: number;
  /** A unit key (g, ml, cup...) or `portion:<name>`, as the log form uses. */
  readonly unit: string;
  readonly profile: NutrientProfile;
}

export type PortionState = "unconfirmed" | "confirmed";

export interface PrepPortion {
  readonly id: string;
  readonly fraction: number;
  /** The diary entry's ID: the one the app chose, then the one Google stored. */
  readonly entryId: string | null;
  /** Unconfirmed until the diary entry is known to exist. It counts as eaten either way. */
  readonly state: PortionState;
  /** When it was eaten, which is the diary entry's time. */
  readonly eatenAt: number;
  readonly createdAt: number;
}

export interface Prep {
  readonly id: string;
  readonly name: string;
  readonly ingredients: readonly PrepIngredient[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly discardedAt: number | null;
  readonly portions: readonly PrepPortion[];
}

/** A new ID for a prep or a portion: lowercase letters and digits, as the API and diary entry IDs allow. */
export function randomId(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => (b % 36).toString(36)).join("");
}

/** What is left of the batch, from 0 to 1. */
export function leftOf(portions: readonly Pick<PrepPortion, "fraction">[]): number {
  const left = 1 - portions.reduce((sum, p) => sum + p.fraction, 0);
  return left < FRACTION_EPSILON ? 0 : left;
}

export function isFinished(prep: { readonly portions: readonly Pick<PrepPortion, "fraction">[] }): boolean {
  return leftOf(prep.portions) === 0;
}

/** The whole batch's nutrients. */
export function batchProfile(ingredients: readonly Pick<PrepIngredient, "profile">[]): NutrientProfile {
  return sumProfiles(ingredients.map((i) => i.profile));
}

export function portionProfile(ingredients: readonly Pick<PrepIngredient, "profile">[], fraction: number): NutrientProfile {
  return scaleProfile(batchProfile(ingredients), fraction);
}

/**
 * Reads an amount of the batch: `1/6`, `25%`, `0.25` or `1`. Returns undefined for anything else,
 * including a weight: the ingredients don't add up to the cooked weight (#55).
 */
export function parseFraction(text: string): number | undefined {
  const t = text.trim().replace(/\s+/g, "");
  let value: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\/(\d+)$/.exec(t))) value = Number(m[2]) === 0 ? undefined : Number(m[1]) / Number(m[2]);
  else if ((m = /^(\d+(?:\.\d+)?)%$/.exec(t))) value = Number(m[1]) / 100;
  else if (/^(\d+(?:\.\d+)?|\.\d+)$/.test(t)) value = Number(t);
  return value !== undefined && value > FRACTION_EPSILON && value <= 1 + FRACTION_EPSILON ? Math.min(value, 1) : undefined;
}

/** A fraction as people write it: `1/6`, `2/3`, or a percentage when no small fraction fits. */
export function formatFraction(fraction: number): string {
  if (Math.abs(fraction - 1) < FRACTION_EPSILON) return "all";
  for (let d = 2; d <= 12; d++) {
    const n = Math.round(fraction * d);
    if (n > 0 && n < d && Math.abs(fraction - n / d) < 1e-4) return `${n}/${d}`;
  }
  const percent = fraction * 100;
  return `${percent < 1 ? Math.round(percent * 10) / 10 : Math.round(percent)}%`;
}

/** The diary entry's name, e.g. `Chili (1/6)`. */
export function portionName(prepName: string, fraction: number): string {
  return `${prepName} (${formatFraction(fraction)})`;
}

/** How a portion's entry name ends, e.g. ` (1/6)`, ` (25%)` or ` (all)`. */
export const PORTION_SUFFIX = / \((all|\d+\/\d+|\d+(\.\d+)?%)\)$/;

/** A diary entry, as far as finding its portion needs. */
export interface PortionEntry {
  readonly id: string;
  /** The entry's name as Google stores it, e.g. `Chili (1/6)`. */
  readonly foodDisplayName: string | undefined;
  readonly start: number;
}

/**
 * The portion a diary entry was logged for. First by the entry's ID. Failing that, by its name and a time within a second
 * of when it was eaten (Google may drop or round the milliseconds), among portions whose own entry is not in `listed`: that covers an entry Google stored under its own ID, which
 * the portion never learnt. Undefined when the entry is not a portion, or the prep has been renamed since.
 */
export function portionOfEntry(
  preps: readonly Prep[],
  entry: PortionEntry,
  listed: ReadonlySet<string> = new Set(),
): { prep: Prep; portion: PrepPortion } | undefined {
  const all = preps.flatMap((prep) => prep.portions.map((portion) => ({ prep, portion })));
  const byId = all.find(({ portion }) => portion.entryId === entry.id);
  if (byId) return byId;
  const name = entry.foodDisplayName?.trim();
  return all.find(
    ({ prep, portion }) =>
      portionName(prep.name.trim(), portion.fraction) === name && Math.abs(portion.eatenAt - entry.start) <= 1000 && !(portion.entryId && listed.has(portion.entryId)),
  );
}

const SOURCES: ReadonlySet<FoodSource> = new Set<FoodSource>(["off", "afcd", "ausnut", "fndds", "usda", "sample", "manual"]);
const NUTRIENT_SET: ReadonlySet<string> = new Set(NUTRIENT_KEYS);

const isAmount = (v: unknown, max = 1e7): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

/**
 * Why a food could not be saved as an ingredient, or undefined when it can. The food index builders skip such foods,
 * so that a food found in search never fails `checkIngredients` (#91).
 */
export function ingredientLimitProblem(food: Pick<FoodItem, "ref" | "name" | "brand" | "portions">): string | undefined {
  if (food.ref.id.length > MAX_FOOD_ID) return `ID is ${food.ref.id.length} characters, over ${MAX_FOOD_ID}`;
  const label = foodLabel(food);
  if (label.length > MAX_LABEL) return `name and brand are ${label.length} characters, over ${MAX_LABEL}`;
  for (const p of food.portions) {
    const unit = `${PORTION_PREFIX}${p.name}`;
    if (unit.length > MAX_UNIT) return `portion "${p.name.slice(0, 40)}…" makes a unit of ${unit.length} characters, over ${MAX_UNIT}`;
  }
  return undefined;
}

/** Checks ingredients sent to the API; returns only the fields it knows. Throws a message fit to show. */
export function checkIngredients(value: unknown, what = "prep"): PrepIngredient[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INGREDIENTS) throw new Error(`A ${what} needs 1 to ${MAX_INGREDIENTS} ingredients.`);
  return value.map((item: unknown, i) => {
    const fail = (what: string): never => {
      throw new Error(`Ingredient ${i + 1}: ${what}.`);
    };
    if (typeof item !== "object" || item === null) return fail("not an ingredient");
    const { ref, label, quantity, unit, profile } = item as Record<string, unknown>;
    const r = ref as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || !SOURCES.has(r["source"] as FoodSource) || !isText(r["id"], MAX_FOOD_ID)) fail("unknown food");
    if (!isText(label, MAX_LABEL)) fail("no name");
    if (!isAmount(quantity) || quantity === 0) fail("no amount");
    if (!isText(unit, MAX_UNIT)) fail("no unit");
    const p = profile as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null || !isAmount(p["energyKcal"])) fail("no energy");
    const n = (p as Record<string, unknown>)["nutrients"];
    if (typeof n !== "object" || n === null) fail("no nutrients");
    const nutrients: Partial<Record<NutrientKey, number>> = {};
    for (const [key, grams] of Object.entries(n as Record<string, unknown>)) {
      if (!NUTRIENT_SET.has(key) || !isAmount(grams)) fail(`bad value for ${key.slice(0, 40)}`);
      nutrients[key as NutrientKey] = grams as number;
    }
    return {
      ref: { source: r!["source"] as FoodSource, id: r!["id"] as string },
      label: label as string,
      quantity: quantity as number,
      unit: unit as string,
      profile: { energyKcal: (p as Record<string, unknown>)["energyKcal"] as number, nutrients },
    };
  });
}
