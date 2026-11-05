import { isGenericSource, type FoodItem, type FoodRef } from "../core/food";
import { summarise } from "../core/food-summary";
import { isEmptyQuery, parseQuery } from "../core/tokens";
import { DEFAULT_LIMIT, toHit, type FoodCatalog, type FoodSearchHit, type SearchOptions } from "./catalog";
import { GenericIndex } from "./generic-search";
import { GENERICS_FORMAT, genericToFoodItem, type GenericsFile, type GenericRow } from "./generics-format";
import { describeError, logger } from "../debug/log";

const log = logger("search");

/** Most generic rows shown ahead of products, so branded products stay in view. */
export const MAX_GENERIC_ROWS = 5;

/**
 * The foods the app can search: generic foods from the small file first, then
 * products from `products` (docs/FOOD_SEARCH.md section 13). Rows keep their one
 * source's values and nothing is joined across sources. Either side can fail
 * without taking the other down.
 */
export class CombinedCatalog implements FoodCatalog {
  private index?: Promise<GenericIndex>;

  constructor(
    private readonly genericsUrl: string,
    private readonly products: FoodCatalog,
    private readonly licenceUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get label(): string {
    return `Generic foods + ${this.products.label}`;
  }

  get attributions() {
    return [
      { text: "Generic foods: FSANZ AFCD, USDA FNDDS", href: this.licenceUrl },
      ...(this.products.attributions ?? []),
    ];
  }

  /** Downloads the generic foods once. Safe to call early, so the first search doesn't wait for it. */
  load(): Promise<GenericIndex> {
    this.index ??= (async () => {
      const res = await this.fetchImpl(this.genericsUrl);
      if (!res.ok) throw new Error(`Generic foods request failed (${res.status})`);
      const file = (await res.json()) as GenericsFile;
      if (file.format !== GENERICS_FORMAT) throw new Error(`Generic foods format ${file.format} is not supported`);
      return new GenericIndex(file.foods);
    })();
    this.index.catch(() => (this.index = undefined));
    return this.index;
  }

  private async generics(query: string): Promise<GenericRow[]> {
    try {
      return (await this.load()).search(query);
    } catch (e) {
      log.warn("Generic foods are unavailable", { error: describeError(e) });
      return [];
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const q = parseQuery(query);
    const generics = isEmptyQuery(q) ? [] : await this.generics(query);
    const first = generics.slice(0, Math.min(MAX_GENERIC_ROWS, limit));
    let products: FoodSearchHit[] = [];
    if (first.length < limit) {
      try {
        // Asking only for the rows that will show saves fetching a summary file for each of the others.
        products = await this.products.search(query, { limit: limit - first.length, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (e) {
        if (options.signal?.aborted || first.length === 0) throw e;
        log.warn("Products are unavailable, showing generic foods only", { error: describeError(e) });
      }
    }
    options.signal?.throwIfAborted();
    // If products leave rows empty, more generic foods can fill them.
    const rest = generics.slice(first.length, limit - products.length);
    const toGeneric = (row: GenericRow) => toHit(summarise(genericToFoodItem(row)), q);
    return [...first.map(toGeneric), ...products, ...rest.map(toGeneric)];
  }

  async get(ref: FoodRef, options: { readonly signal?: AbortSignal } = {}): Promise<FoodItem | undefined> {
    if (isGenericSource(ref.source)) return (await this.load()).get(ref.source, ref.id);
    return this.products.get(ref, options);
  }
}
