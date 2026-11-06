import type { FoodRef } from "./food";
import { matchRank, productMatches, type ParsedQuery } from "./tokens";

/**
 * Which foods the user logged before get boosted in search (docs/FOOD_SEARCH.md
 * section 14). Pure: it only looks at the entries it is given.
 */

/** One diary entry of a food the catalogue can load again. */
export interface LoggedFood {
  /** The diary entry's ID. */
  readonly id: string;
  readonly ref: FoodRef;
  /** The name stored in the entry, as `foodLabel()` wrote it. */
  readonly label: string;
  /** When it was eaten, in milliseconds since the epoch. */
  readonly at: number;
}

/** The major boost covers this many of the foods logged most recently... */
export const RECENT_FOODS = 20;
/** ...and anything logged within this time. */
export const RECENT_MS = 14 * 24 * 60 * 60_000;
/** The most rows the minor boost may take, so that it does not crowd out the normal results. */
export const MAX_MINOR_ROWS = 3;
/** Fewer letters than this say too little about a word for it to be a good match. */
const MIN_GOOD_PREFIX = 3;

/** The same food, whichever way its ID is cased: entry IDs are lower case, catalogue IDs may not be. */
export function foodKey(ref: FoodRef): string {
  return `${ref.source}:${ref.id.toLowerCase()}`;
}

/** Each food once, at its latest entry, newest first. */
function latestPerFood(entries: readonly LoggedFood[]): LoggedFood[] {
  const latest = new Map<string, LoggedFood>();
  for (const entry of entries) {
    const key = foodKey(entry.ref);
    const seen = latest.get(key);
    if (!seen || entry.at > seen.at) latest.set(key, entry);
  }
  return [...latest.values()].sort((a, b) => b.at - a.at);
}

/**
 * The logged foods to show ahead of the normal results for a query, best first.
 * Major: one of the last RECENT_FOODS foods, or logged within RECENT_MS. These show
 * whenever they match. Minor: any other logged food, only if it is a good match.
 */
export function boostedFoods(q: ParsedQuery, entries: readonly LoggedFood[], now: number, limit: number): LoggedFood[] {
  type Candidate = { readonly food: LoggedFood; readonly tier: number; readonly notTheFood: number };
  const major: Candidate[] = [];
  const minor: Candidate[] = [];
  latestPerFood(entries).forEach((food, recency) => {
    if (!productMatches(q, food.label)) return;
    const [tier = 0, , notTheFood = 0] = matchRank(q, food.label);
    const candidate = { food, tier, notTheFood };
    if (recency < RECENT_FOODS || now - food.at <= RECENT_MS) major.push(candidate);
    else if (notTheFood === 0 && (tier === 0 || (tier === 1 && (q.prefix?.length ?? 0) >= MIN_GOOD_PREFIX))) minor.push(candidate);
  });
  const best = (a: Candidate, b: Candidate) => a.tier - b.tier || a.notTheFood - b.notTheFood || b.food.at - a.food.at;
  return [...major.sort(best), ...minor.sort(best).slice(0, MAX_MINOR_ROWS)].slice(0, limit).map((c) => c.food);
}
