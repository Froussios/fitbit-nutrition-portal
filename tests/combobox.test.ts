import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarise } from "../src/core/food-summary";
import { LocalFoodCatalog, type FoodCatalog, type FoodSearchHit } from "../src/food/catalog";
import { SAMPLE_FOODS } from "../src/food/sample-foods";
import { fieldText, INITIAL, reduce, type ComboEvent, type ComboState } from "../src/ui/combobox-state";
import { SearchController, type SearchUpdate } from "../src/ui/search-controller";

const run = (...events: ComboEvent[]): ComboState => events.reduce(reduce, INITIAL);
const typed = (text: string, hits: number) => run({ type: "input", text }, { type: "results", hits });

describe("combobox keyboard model", () => {
  it("opens from 2 characters", () => {
    expect(run({ type: "input", text: "c" }).open).toBe(false);
    expect(run({ type: "input", text: "ch" }).open).toBe(true);
  });

  it("moves through the hits and the custom row, then back to the typed query", () => {
    let s = typed("choc", 2);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push((s = reduce(s, { type: "down" })).active);
    expect(seen).toEqual([0, 1, 2, -1]); // two hits, the custom row, back to the query
    expect(reduce(typed("choc", 2), { type: "up" }).active).toBe(2); // up from the query wraps to the last row
  });

  it("writes the active hit's label into the field, and the typed query otherwise", () => {
    const label = (row: number) => ["Dark Chocolate", "Milk Chocolate"][row]!;
    const s = reduce(typed("choc", 2), { type: "down" });
    expect(fieldText(s, label)).toBe("Dark Chocolate");
    expect(fieldText(reduce(s, { type: "escape" }), label)).toBe("choc");
    expect(fieldText(reduce(reduce(s, { type: "down" }), { type: "down" }), label)).toBe("choc"); // custom row
  });

  it("escape restores the query, then closes, then clears", () => {
    let s = reduce(typed("choc", 2), { type: "down" });
    s = reduce(s, { type: "escape" });
    expect(s).toMatchObject({ open: true, active: -1, query: "choc" });
    s = reduce(s, { type: "escape" });
    expect(s).toMatchObject({ open: false, query: "choc" });
    expect(reduce(s, { type: "escape" }).query).toBe("");
  });

  it("typing clears the active row", () => {
    const s = reduce(reduce(typed("choc", 2), { type: "down" }), { type: "input", text: "choco" });
    expect(s.active).toBe(-1);
  });

  it("skips the custom row when there is none", () => {
    let s = run({ type: "input", text: "choc" }, { type: "results", hits: 2, custom: false });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((s = reduce(s, { type: "down" })).active);
    expect(seen).toEqual([0, 1, -1]);
  });

  it("drops an active row that no longer exists when results shrink", () => {
    const s = reduce(reduce(reduce(typed("choc", 3), { type: "down" }), { type: "down" }), { type: "down" });
    expect(reduce(s, { type: "results", hits: 1 }).active).toBe(-1);
  });
});

describe("SearchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(catalog: FoodCatalog = new LocalFoodCatalog(SAMPLE_FOODS)) {
    const updates: SearchUpdate[] = [];
    const search = vi.spyOn(catalog, "search");
    return { c: new SearchController(catalog, (u) => updates.push(u), 100), updates, search };
  }

  it("debounces keystrokes into one search", async () => {
    const { c, updates, search } = setup();
    c.setQuery("mi");
    c.setQuery("mil");
    c.setQuery("milk");
    await vi.advanceTimersByTimeAsync(150);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe("milk");
    const done = updates.at(-1)!;
    expect(done.status).toBe("done");
    expect(done.status === "done" && done.hits.map((h) => h.summary.name)).toEqual(["Full cream milk"]);
  });

  it("serves repeated queries from the cache", async () => {
    const { c, search } = setup();
    c.setQuery("milk");
    await vi.advanceTimersByTimeAsync(150);
    c.setQuery("milk ");
    c.setQuery("milk");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow answer for a query the field no longer shows", async () => {
    let release!: (hits: FoodSearchHit[]) => void;
    const slow: FoodCatalog = {
      label: "slow",
      search: (q) => (q === "oats" ? new Promise((r) => (release = r)) : Promise.resolve([])),
      get: async () => undefined,
    };
    const { c, updates } = setup(slow);
    c.setQuery("oats");
    await vi.advanceTimersByTimeAsync(150);
    c.setQuery("milk");
    await vi.advanceTimersByTimeAsync(150);
    release([{ summary: summarise(SAMPLE_FOODS[0]!), name: [] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.filter((u) => u.status === "done").map((u) => u.query)).toEqual(["milk"]);
  });

  it("reports errors without throwing", async () => {
    const failing: FoodCatalog = { label: "x", search: async () => Promise.reject(new Error("offline")), get: async () => undefined };
    const { c, updates } = setup(failing);
    c.setQuery("milk");
    await vi.advanceTimersByTimeAsync(150);
    expect(updates.at(-1)!.status).toBe("error");
  });

  it("does not search below 2 characters", () => {
    const { c, updates, search } = setup();
    c.setQuery("m");
    expect(search).not.toHaveBeenCalled();
    expect(updates.at(-1)!.status).toBe("idle");
  });

  describe("when the catalogue's answers change", () => {
    it("forgets cached results", async () => {
      const { c, search } = setup();
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      c.invalidate(false);
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      expect(search).toHaveBeenCalledTimes(2);
    });

    it("updates what the field shows straight away, with no searching state", async () => {
      const { c, updates, search } = setup();
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      updates.length = 0;
      c.invalidate(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(search).toHaveBeenCalledTimes(2);
      expect(updates.map((u) => u.status)).toEqual(["done"]);
    });

    it("searches only once if a keystroke is still waiting", async () => {
      const { c, search } = setup();
      c.setQuery("milk");
      c.invalidate(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("does not search when asked not to, or when the field has too little text", async () => {
      const { c, search } = setup();
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      c.invalidate(false);
      c.setQuery("m");
      c.invalidate(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("does not cache an answer from before the change", async () => {
      let release: (hits: FoodSearchHit[]) => void = () => {};
      const slow: FoodCatalog = { label: "x", search: () => new Promise((resolve) => (release = resolve)), get: async () => undefined };
      const { c, search } = setup(slow);
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      c.invalidate(false);
      release([]);
      await vi.advanceTimersByTimeAsync(0);
      c.setQuery("milk");
      await vi.advanceTimersByTimeAsync(150);
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});
