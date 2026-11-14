import type { FoodItem, FoodRef } from "../core/food";
import { summarise, type FoodSummary } from "../core/food-summary";
import { compareMatch, compareRank, highlightRuns, isEmptyQuery, looseForms, matchRank, nameWordCount, parseQuery, productMatches, productWordCount, sameNameKey, type ParsedQuery, type TextRun } from "../core/tokens";

/** One row of search results: what the dropdown shows, with matched words marked. */
export interface FoodSearchHit {
  readonly summary: FoodSummary;
  readonly name: readonly TextRun[];
  readonly brand?: readonly TextRun[];
}

export interface SearchOptions {
  /** Defaults to 10. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
  /** Search loosely (DR-30, ParsedQuery.loose). searchWithFallback() sets it when an exact search finds nothing. */
  readonly loose?: boolean;
}

/**
 * Where food definitions come from. The UI only talks to this interface.
 *
 * The app never queries Open Food Facts' public API: its rate limits (about
 * 10 searches/min per IP) are far too low for interactive search. Real data
 * comes from our own static index of the Open Food Facts export
 * (StaticFoodCatalog, docs/FOOD_SEARCH.md).
 *
 * Matching (DR-13): every query word must be in the name or brand, in any
 * order, the last word may be a prefix, no typo tolerance; with `loose`, every
 * word may be a prefix or a variant without an ending (DR-30). Ordering (DR-15):
 * see matchRank(). Whole-word matches in the name come first, products the query
 * uses up entirely first among them, then products where a query word is the food
 * and not its flavour, then branded before no brand listed, then the fewest name words
 * the query does not account for; products that only matched on their brand come last.
 */
export interface FoodCatalog {
  /** Shown in the debug log and attribution line. */
  readonly label: string;
  readonly attributions?: readonly { readonly text: string; readonly href: string }[];
  search(query: string, options?: SearchOptions): Promise<FoodSearchHit[]>;
  /** The full food: on choosing a search hit, or by barcode. */
  get(ref: FoodRef, options?: { readonly signal?: AbortSignal }): Promise<FoodItem | undefined>;
  /** For a catalogue whose answers can change: `listener` runs when an earlier search might now answer differently. */
  onChange?(listener: () => void): void;
}

export const DEFAULT_LIMIT = 10;

/** Whether a loose search could find anything an exact one does not. */
function loosens(query: string): boolean {
  const q = parseQuery(query);
  return q.words.length > 0 || (q.prefix !== undefined && looseForms(q.prefix).length > 0);
}

/**
 * Searches for exact words, and only when that finds nothing at all, searches again with every
 * word allowed to be a prefix or a variant without an ending (DR-30): "tall ice americano" finds
 * "Tall Iced Americano", "bake beans" finds "Baked Beans".
 */
export async function searchWithFallback(catalog: FoodCatalog, query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
  const hits = await catalog.search(query, options);
  if (hits.length > 0 || options.loose || !loosens(query)) return hits;
  options.signal?.throwIfAborted();
  return catalog.search(query, { ...options, loose: true });
}

export function toHit(summary: FoodSummary, q: ParsedQuery): FoodSearchHit {
  return {
    summary,
    name: highlightRuns(summary.name, q),
    ...(summary.brand ? { brand: highlightRuns(summary.brand, q) } : {}),
  };
}

/** In-memory catalogue for development without the index, and for tests. Same matching and ordering rules. */
export class LocalFoodCatalog implements FoodCatalog {
  readonly label = "Sample foods (local)";
  private readonly ranked: readonly FoodItem[];

  constructor(items: readonly FoodItem[]) {
    const sameName = new Map<string, number>();
    for (const f of items) sameName.set(sameNameKey(f.name), (sameName.get(sameNameKey(f.name)) ?? 0) + 1);
    const key = (f: FoodItem) => ({
      branded: Boolean(f.brand),
      nameWordCount: nameWordCount(f.name),
      productWordCount: productWordCount(f.name, f.brand),
      sameNameCount: sameName.get(sameNameKey(f.name)) ?? 0,
      popularity: 0,
      key: f.name,
    });
    this.ranked = [...items].sort((a, b) => compareRank(key(a), key(b)));
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const q = parseQuery(query, options.loose);
    if (isEmptyQuery(q)) return [];
    return this.ranked
      .filter((f) => productMatches(q, f.name, f.brand))
      .map((f) => ({ f, rank: matchRank(q, f.name, f.brand) }))
      .sort((a, b) => compareMatch(a.rank, b.rank))
      .slice(0, options.limit ?? DEFAULT_LIMIT)
      .map(({ f }) => toHit(summarise(f), q));
  }

  async get(ref: FoodRef): Promise<FoodItem | undefined> {
    return this.ranked.find((f) => f.ref.source === ref.source && f.ref.id === ref.id);
  }
}
