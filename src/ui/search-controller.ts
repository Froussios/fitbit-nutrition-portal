import { isBarcode } from "../food/index-format";
import { searchWithFallback, type FoodCatalog, type FoodSearchHit } from "../food/catalog";
import { MIN_QUERY } from "./combobox-state";

export type SearchUpdate =
  | { readonly status: "idle"; readonly query: string }
  | { readonly status: "searching"; readonly query: string }
  | { readonly status: "done"; readonly query: string; readonly hits: readonly FoodSearchHit[] }
  | { readonly status: "error"; readonly query: string; readonly error: unknown };

/**
 * Sits between the search field and the catalogue (docs/FOOD_SEARCH.md
 * section 8.2): debounces keystrokes, cancels the previous search, drops
 * results for a query the field no longer shows, and caches recent queries.
 */
export class SearchController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current = "";
  private abort: AbortController | undefined;
  private readonly cache = new Map<string, readonly FoodSearchHit[]>();
  /** Goes up when the catalogue's answers change, so a search already running does not fill the cache. */
  private generation = 0;

  constructor(
    private readonly catalog: FoodCatalog,
    private readonly onUpdate: (u: SearchUpdate) => void,
    private readonly delayMs = 100,
    private readonly cacheSize = 50,
  ) {}

  /** Normalised so "Dark  Choc" and "dark choc" share a cache entry; a trailing space still matters. */
  private static key(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trimStart();
  }

  private static searchable(text: string): boolean {
    return SearchController.key(text).trim().length >= MIN_QUERY || isBarcode(text);
  }

  setQuery(text: string): void {
    clearTimeout(this.timer);
    this.current = text;
    const key = SearchController.key(text);
    if (!SearchController.searchable(text)) {
      this.abort?.abort();
      this.onUpdate({ status: "idle", query: text });
      return;
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.abort?.abort();
      this.cache.delete(key);
      this.cache.set(key, cached); // most recently used
      this.onUpdate({ status: "done", query: text, hits: cached });
      return;
    }
    this.onUpdate({ status: "searching", query: text });
    this.timer = setTimeout(() => void this.run(text, key), this.delayMs);
  }

  /**
   * The catalogue's answers changed, so forget the cached ones. With `searchAgain`, also
   * updates the results of what the field shows, with no "searching" state in between.
   */
  invalidate(searchAgain: boolean): void {
    this.generation++;
    this.cache.clear();
    if (searchAgain && SearchController.searchable(this.current)) {
      clearTimeout(this.timer);
      void this.run(this.current, SearchController.key(this.current));
    }
  }

  private async run(text: string, key: string): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const generation = this.generation;
    try {
      const hits = await searchWithFallback(this.catalog, text, { signal: abort.signal });
      if (generation === this.generation) {
        this.cache.set(key, hits);
        if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      }
      if (text === this.current && !abort.signal.aborted) this.onUpdate({ status: "done", query: text, hits });
    } catch (error) {
      if (text === this.current && !abort.signal.aborted) this.onUpdate({ status: "error", query: text, error });
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.abort?.abort();
  }
}
