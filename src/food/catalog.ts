import type { FoodItem, FoodRef } from "../core/food";
import { summarise, type FoodSummary } from "../core/food-summary";
import { compareRank, highlightRuns, isEmptyQuery, nameWords, parseQuery, productMatches, type ParsedQuery, type TextRun } from "../core/tokens";

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
 * order, the last word may be a prefix, no typo tolerance. Ordering: fewer
 * words in the name first (more of the name covered by the query), then more
 * popular.
 */
export interface FoodCatalog {
  /** Shown in the debug log and attribution line. */
  readonly label: string;
  readonly attribution?: { readonly text: string; readonly href: string };
  search(query: string, options?: SearchOptions): Promise<FoodSearchHit[]>;
  /** The full food: on choosing a search hit, or by barcode. */
  get(ref: FoodRef, options?: { readonly signal?: AbortSignal }): Promise<FoodItem | undefined>;
}

export const DEFAULT_LIMIT = 10;

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
    const key = (f: FoodItem) => ({ nameWordCount: Math.max(1, nameWords(f.name).length), popularity: 0, key: f.name });
    this.ranked = [...items].sort((a, b) => compareRank(key(a), key(b)));
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const q = parseQuery(query);
    if (isEmptyQuery(q)) return [];
    return this.ranked
      .filter((f) => productMatches(q, f.name, f.brand))
      .slice(0, options.limit ?? DEFAULT_LIMIT)
      .map((f) => toHit(summarise(f), q));
  }

  async get(ref: FoodRef): Promise<FoodItem | undefined> {
    return this.ranked.find((f) => f.ref.source === ref.source && f.ref.id === ref.id);
  }
}
