import type { FoodRef, FoodSource } from "./food";

/**
 * Client-supplied data point IDs.
 *
 * The Google Health API accepts IDs of 4-63 characters: lowercase letters,
 * digits and hyphens. We use them to carry the food reference, because a
 * NutritionLog has no metadata field of its own. They would also make retries
 * idempotent, but only if a retry reuses the same ID; the app does not retry
 * writes (DR-18), and logging again after a failure sends a new ID:
 *
 *   e-<time36>-<rand>[<step36>]-<src>[-<foodId>]     single entry
 *
 * `rand` is always 4 characters. Any characters after it are the entry's step (DR-37): how much the diary's + button
 * adds, in hundredths of the entry's gram or millilitre unit, base 36 (`ab127s` is 4 random characters and 10 g). It
 * records the unit the user logged in, which the entry itself can't: its serving is only ever grams or millilitres.
 *
 * A saved meal is one entry with source `meal` and the meal's ID as its food ID.
 *
 * The food id part is dropped when it would not fit or is not ID-safe.
 */

export const ID_PATTERN = /^[a-z0-9-]{4,63}$/;
const MAX_LEN = 63;

const SOURCE_CODES: Record<FoodSource, string> = {
  off: "off",
  afcd: "afcd",
  ausnut: "aus",
  fndds: "fnds",
  usda: "usda",
  sample: "smp",
  manual: "man",
  prep: "prep",
  meal: "meal",
};
const SOURCE_BY_CODE = new Map(Object.entries(SOURCE_CODES).map(([s, c]) => [c, s as FoodSource]));

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/** The step's part of an ID: hundredths, base 36. Nothing for no step, or one too small to write. */
function stepCode(step: number | null | undefined): string {
  const hundredths = step !== null && step !== undefined && Number.isFinite(step) ? Math.round(step * 100) : 0;
  return hundredths > 0 ? hundredths.toString(36) : "";
}

export function newEntryId(ref: FoodRef, now: number = Date.now(), rand: string = randomSuffix(4), step?: number): string {
  const head = `e-${now.toString(36)}-${rand}${stepCode(step)}-${SOURCE_CODES[ref.source]}`;
  const foodId = ref.id.toLowerCase();
  const withFood = `${head}-${foodId}`;
  return /^[a-z0-9-]+$/.test(foodId) && withFood.length <= MAX_LEN ? withFood : head;
}

/**
 * A new ID for a copy of an entry, recording the same source and food. An ID the
 * API chose has neither, so its copy reads like an entry with no food reference.
 * The copy keeps the original's step unless `step` gives another, or null for none.
 */
export function copiedEntryId(id: string, now: number = Date.now(), rand: string = randomSuffix(4), step: number | null = entryStep(id) ?? null): string {
  const m = /^e-[0-9a-z]+-[0-9a-z]+-([a-z]+)(-.+)?$/.exec(id);
  const head = `e-${now.toString(36)}-${rand}${stepCode(step)}-${m?.[1] ?? SOURCE_CODES.manual}`;
  // A longer step can push the food reference past the limit, which drops it, as for a new entry.
  const withFood = `${head}${m?.[2] ?? ""}`;
  return withFood.length <= MAX_LEN ? withFood : head;
}

/** The step an ID records (see the top of this file), in the entry's grams or millilitres. Undefined for none. */
export function entryStep(id: string): number | undefined {
  const segment = /^e-[0-9a-z]+-([0-9a-z]+)-[a-z]+(?:-.+)?$/.exec(id)?.[1] ?? "";
  if (segment.length <= 4) return undefined;
  const hundredths = parseInt(segment.slice(4), 36);
  return Number.isFinite(hundredths) && hundredths > 0 ? hundredths / 100 : undefined;
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
