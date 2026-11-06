import type { FoodItem, FoodRef } from "../core/food";
import { summarise, type FoodSummary } from "../core/food-summary";
import { boostedFoods, foodKey, type LoggedFood } from "../core/logged-foods";
import { isEmptyQuery, parseQuery } from "../core/tokens";
import { describeError, logger } from "../debug/log";
import { DEFAULT_LIMIT, toHit, type FoodCatalog, type FoodSearchHit, type SearchOptions } from "./catalog";

const log = logger("search");

/** How long a search waits for the summaries of logged foods. One that arrives later is added to the open list. */
export const LOGGED_WAIT_MS = 300;

/**
 * Puts foods the user logged before ahead of another catalogue's results
 * (docs/FOOD_SEARCH.md section 14). History only ever adds rows: without it, or
 * when a lookup fails, searches answer as the other catalogue does.
 */
export class LoggedFoodsCatalog implements FoodCatalog {
  private entries: readonly LoggedFood[] = [];
  /** Entries the user deleted, so that a diary read already under way does not bring them back. */
  private readonly deleted = new Set<string>();
  /** By food. Null when the catalogue no longer has the food. */
  private readonly summaries = new Map<string, FoodSummary | null>();
  private readonly lookups = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly inner: FoodCatalog,
    private readonly now: () => number = Date.now,
  ) {}

  get label(): string {
    return this.inner.label;
  }

  get attributions() {
    return this.inner.attributions;
  }

  /** Adds entries from the diary. Entries already known stay, so one logged while the diary was loading is kept. */
  merge(entries: readonly LoggedFood[]): void {
    const known = new Set(this.entries.map((e) => e.id));
    const added = entries.filter((e) => !known.has(e.id) && !this.deleted.has(e.id));
    if (added.length === 0) return;
    this.entries = [...this.entries, ...added];
    this.changed();
  }

  /** The user just logged `food`. Its full details are at hand, so a search needs no lookup. */
  add(entry: LoggedFood, food: FoodItem): void {
    this.summaries.set(foodKey(entry.ref), summarise(food));
    this.merge([entry]);
  }

  /** The user deleted this diary entry. */
  remove(id: string): void {
    this.deleted.add(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.changed();
  }

  /** The user signed out. */
  clear(): void {
    this.entries = [];
    this.deleted.clear();
    this.summaries.clear();
    this.changed();
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Fetches a food's summary once. Never rejects; a failed lookup is tried again by a later search. */
  private lookUp(ref: FoodRef): Promise<void> {
    const key = foodKey(ref);
    let lookup = this.lookups.get(key);
    if (!lookup) {
      lookup = this.inner
        .get(ref)
        .then(
          (food) => void this.summaries.set(key, food ? summarise(food) : null),
          (e: unknown) => log.warn("Could not load a logged food", { ref, error: describeError(e) }),
        )
        .finally(() => this.lookups.delete(key));
      this.lookups.set(key, lookup);
    }
    return lookup;
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodSearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const q = parseQuery(query);
    const boosted = isEmptyQuery(q) ? [] : boostedFoods(q, this.entries, this.now(), limit);
    const unknown = boosted.filter((f) => !this.summaries.has(foodKey(f.ref)));
    const lookups = Promise.all(unknown.map((f) => this.lookUp(f.ref)));

    // Asks for every row, because the foods above may be among the ones it returns.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [found] = await Promise.allSettled([
      this.inner.search(query, options),
      unknown.length > 0 ? Promise.race([lookups, new Promise((resolve) => (timer = setTimeout(resolve, LOGGED_WAIT_MS)))]) : undefined,
    ]);
    clearTimeout(timer);
    options.signal?.throwIfAborted();

    const late = unknown.filter((f) => !this.summaries.has(foodKey(f.ref)));
    if (late.length > 0) {
      void lookups.then(() => {
        if (late.some((f) => this.summaries.get(foodKey(f.ref)))) this.changed();
      });
    }

    const first = boosted.flatMap((f) => this.summaries.get(foodKey(f.ref)) ?? []);
    if (found.status === "rejected") {
      if (first.length === 0) throw found.reason;
      log.warn("Food search failed, showing logged foods only", { error: describeError(found.reason) });
    }
    const shown = new Set(first.map((s) => foodKey(s.ref)));
    const rest = found.status === "fulfilled" ? found.value.filter((hit) => !shown.has(foodKey(hit.summary.ref))) : [];
    return [...first.map((s) => toHit(s, q)), ...rest].slice(0, limit);
  }

  get(ref: FoodRef, options?: { readonly signal?: AbortSignal }): Promise<FoodItem | undefined> {
    return this.inner.get(ref, options);
  }
}
