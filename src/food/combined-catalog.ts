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
/** How long the first search waits for the generic file before showing products without it. */
export const GENERICS_WAIT_MS = 1500;
/** When a download of the generic file is given up, so that a later search can try again. */
const GENERICS_TIMEOUT_MS = 60_000;

/**
 * The foods the app can search: generic foods from the small file first, then
 * products from `products` (docs/FOOD_SEARCH.md section 13). Rows keep their one
 * source's values and nothing is joined across sources. Either side can fail
 * without taking the other down.
 */
export class CombinedCatalog implements FoodCatalog {
  private index?: Promise<GenericIndex>;
  /** The generic foods once they have arrived. Until then a search must not depend on them. */
  private ready?: GenericIndex;
  /** A search has already waited for this download, so later ones go ahead without it. */
  private waited = false;

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
      const res = await this.fetchImpl(this.genericsUrl, { signal: AbortSignal.timeout(GENERICS_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Generic foods request failed (${res.status})`);
      const file = (await res.json()) as GenericsFile;
      if (file.format !== GENERICS_FORMAT) throw new Error(`Generic foods format ${file.format} is not supported`);
      this.ready = new GenericIndex(file.foods);
      return this.ready;
    })();
    this.index.catch(() => {
      this.index = undefined;
      this.waited = false;
    });
    return this.index;
  }

  /**
   * The generic foods for a query, if they can be had without holding up the search. Only the
   * first search waits for the download, and only briefly: a slow or stalled file costs a few
   * generic rows, never the products. A cancelled search stops waiting straight away.
   */
  private async generics(query: string, signal: AbortSignal | undefined): Promise<GenericRow[]> {
    if (this.ready) return this.ready.search(query);
    const loading = this.load();
    if (this.waited) {
      loading.catch(() => {});
      return [];
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        loading,
        new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), GENERICS_WAIT_MS))),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal!.reason);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (outcome === "late") {
        this.waited = true;
        return [];
      }
      return outcome.search(query);
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn("Generic foods are unavailable", { error: describeError(e) });
      return [];
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const q = parseQuery(query);
    const generics = isEmptyQuery(q) ? [] : await this.generics(query, options.signal);
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
