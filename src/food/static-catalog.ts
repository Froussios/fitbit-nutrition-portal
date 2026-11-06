import type { FoodItem, FoodRef } from "../core/food";
import { isEmptyQuery, parseQuery } from "../core/tokens";
import { DEFAULT_LIMIT, toHit, type FoodCatalog, type FoodSearchHit, type SearchOptions } from "./catalog";
import { FoodIndex, IndexNotFoundError, type IndexReader } from "./index-engine";
import { fromSummaryRow, isBarcode } from "./index-format";

/**
 * FoodCatalog over the static Open Food Facts index served next to the app
 * (`public/food-index/`, built by `pipeline/`). Search runs here in the
 * browser, fetching only the few small index files each query needs.
 */
export class StaticFoodCatalog implements FoodCatalog {
  readonly attributions = [{ text: "Products: Open Food Facts (ODbL)", href: "https://world.openfoodfacts.org" }];
  private index?: Promise<FoodIndex>;
  /** Product IDs of recent search hits, so choosing one skips the barcode lookup. */
  private readonly idByCode = new Map<string, number>();
  private version = "";

  /** @param baseUrl folder holding `current.json`, ending in "/". */
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get label(): string {
    return `Open Food Facts index ${this.version || "(not loaded)"}`;
  }

  /** Loads the current index version. Rejects if there is no index. */
  open(): Promise<FoodIndex> {
    this.index ??= (async () => {
      const current = (await this.fetchJson<{ version: string }>(`${this.baseUrl}current.json`, true)).version;
      this.version = current;
      const base = `${this.baseUrl}${encodeURIComponent(current)}/`;
      const reader: IndexReader = {
        json: (path) => this.fetchJson(base + path),
        bytes: async (path) => new Uint8Array(await (await this.fetchOk(base + path)).arrayBuffer()),
      };
      return FoodIndex.open(reader);
    })();
    this.index.catch(() => (this.index = undefined));
    return this.index;
  }

  private async fetchOk(url: string, fresh = false): Promise<Response> {
    const res = await this.fetchImpl(url, fresh ? { cache: "no-cache" } : {});
    if (res.status === 404) throw new IndexNotFoundError(`Not in the food index: ${url}`);
    if (!res.ok) throw new Error(`Food index request failed (${res.status}): ${url}`);
    return res;
  }

  private async fetchJson<T>(url: string, fresh = false): Promise<T> {
    return (await (await this.fetchOk(url, fresh)).json()) as T;
  }

  /** Runs `fn` on the index; if a file has gone (a new version was published), reloads once and retries. */
  private async withIndex<T>(fn: (index: FoodIndex) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.open());
    } catch (e) {
      if (!(e instanceof IndexNotFoundError) || !this.index) throw e;
      this.index = undefined;
      this.idByCode.clear();
      return fn(await this.open());
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const q = parseQuery(query);
    const barcode = isBarcode(query) ? query.trim() : undefined;
    if (isEmptyQuery(q) && !barcode) return [];
    const limit = options.limit ?? DEFAULT_LIMIT;
    const hits = await this.withIndex(async (index) => {
      const ids = await index.search(q, limit);
      if (barcode) {
        const id = await index.findBarcode(barcode);
        if (id !== undefined && !ids.includes(id)) ids.unshift(id);
      }
      const rows = await index.summaries(ids.slice(0, limit));
      return rows.map((row, i) => {
        this.idByCode.set(row[0], ids[i]!);
        return toHit(fromSummaryRow(row), q);
      });
    });
    options.signal?.throwIfAborted();
    return hits;
  }

  async get(ref: FoodRef, options: { readonly signal?: AbortSignal } = {}): Promise<FoodItem | undefined> {
    if (ref.source !== "off") return undefined;
    const food = await this.withIndex(async (index) => {
      const id = this.idByCode.get(ref.id) ?? (await index.findBarcode(ref.id));
      return id === undefined ? undefined : index.food(id);
    });
    options.signal?.throwIfAborted();
    return food;
  }
}
