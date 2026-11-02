import { foodLabel, type FoodItem, type FoodRef } from "../core/food";

/**
 * Where food definitions come from. The UI only talks to this interface.
 *
 * The app never queries Open Food Facts' public API directly: its rate limits
 * (about 10 searches/min per IP) are far too low for interactive search. A
 * later milestone puts a mirror of the Open Food Facts data (plus generic foods)
 * behind this interface. Until then the catalogue is local fake data.
 */
export interface FoodCatalog {
  /** Foods whose name or brand contains every word of `query`. An empty query lists everything. */
  search(query: string, limit?: number): Promise<FoodItem[]>;
  get(ref: FoodRef): Promise<FoodItem | undefined>;
}

/** In-memory catalogue for the proof of concept and tests. */
export class LocalFoodCatalog implements FoodCatalog {
  constructor(private readonly items: readonly FoodItem[]) {}

  async search(query: string, limit = 50): Promise<FoodItem[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((f) => words.every((w) => foodLabel(f).toLowerCase().includes(w))).slice(0, limit);
  }

  async get(ref: FoodRef): Promise<FoodItem | undefined> {
    return this.items.find((f) => f.ref.source === ref.source && f.ref.id === ref.id);
  }
}
