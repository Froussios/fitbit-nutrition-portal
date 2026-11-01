import type { FoodRef, FoodSource } from "./food";

/**
 * Client-supplied data point IDs.
 *
 * The Google Health API accepts IDs of 4-63 characters: lowercase letters,
 * digits and hyphens. We use them for idempotent writes and to carry the food
 * reference, because a NutritionLog has no metadata field of its own:
 *
 *   e-<time36>-<rand>-<src>[-<foodId>]     single entry
 *   m-<mealId>-<n>-...                     meal ingredient (milestone 2)
 *
 * The food id part is dropped when it would not fit or is not ID-safe.
 */

export const ID_PATTERN = /^[a-z0-9-]{4,63}$/;
const MAX_LEN = 63;

const SOURCE_CODES: Record<FoodSource, string> = {
  off: "off",
  ausnut: "aus",
  usda: "usda",
  sample: "smp",
  manual: "man",
};
const SOURCE_BY_CODE = new Map(Object.entries(SOURCE_CODES).map(([s, c]) => [c, s as FoodSource]));

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export function newEntryId(ref: FoodRef, now: number = Date.now(), rand: string = randomSuffix(4)): string {
  const head = `e-${now.toString(36)}-${rand}-${SOURCE_CODES[ref.source]}`;
  const foodId = ref.id.toLowerCase();
  const withFood = `${head}-${foodId}`;
  return /^[a-z0-9-]+$/.test(foodId) && withFood.length <= MAX_LEN ? withFood : head;
}

export interface ParsedEntryId {
  readonly kind: "entry";
  readonly loggedAt: Date;
  readonly ref?: FoodRef;
}

/** Recovers what newEntryId encoded; returns undefined for IDs written by other clients. */
export function parseEntryId(id: string): ParsedEntryId | undefined {
  const m = /^e-([0-9a-z]+)-[0-9a-z]+-([a-z]+)(?:-(.+))?$/.exec(id);
  if (!m) return undefined;
  const [, time36 = "", code = "", foodId] = m;
  const source = SOURCE_BY_CODE.get(code);
  const loggedAt = new Date(parseInt(time36, 36));
  if (!source || Number.isNaN(loggedAt.getTime())) return undefined;
  return foodId ? { kind: "entry", loggedAt, ref: { source, id: foodId } } : { kind: "entry", loggedAt };
}

/** The last segment of a resource name such as users/me/dataTypes/nutrition-log/dataPoints/<id>. */
export function idFromName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}
