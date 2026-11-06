import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoodItem, FoodRef } from "../src/core/food";
import { boostedFoods, foodKey, MAX_MINOR_ROWS, RECENT_FOODS, RECENT_MS, type LoggedFood } from "../src/core/logged-foods";
import { parseQuery } from "../src/core/tokens";
import { LocalFoodCatalog, type FoodCatalog } from "../src/food/catalog";
import { LOGGED_WAIT_MS, LoggedFoodsCatalog } from "../src/food/logged-catalog";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const DAY = 24 * 60 * 60_000;

let nextId = 0;
const logged = (label: string, daysAgo: number, id = label.toLowerCase().replace(/\W+/g, "-")): LoggedFood => ({
  id: `entry-${nextId++}`,
  ref: { source: "off", id },
  label,
  at: NOW - daysAgo * DAY,
});
/** Pushes older foods out of the major boost: RECENT_FOODS foods from the last 15+ days, older than 2 weeks but newer than the food under test. */
const filler = () => Array.from({ length: RECENT_FOODS }, (_, i) => logged(`Filler ${i}`, 15 + i / 100, `filler-${i}`));
const labels = (foods: readonly LoggedFood[]) => foods.map((f) => f.label);
const boosted = (query: string, foods: readonly LoggedFood[], limit = 10) => labels(boostedFoods(parseQuery(query), foods, NOW, limit));

describe("boostedFoods", () => {
  it("gives the major boost to a food logged in the last 2 weeks, even as a flavour or brand match", () => {
    expect(boosted("chocolate", [logged("Chocolate milk", 13)])).toEqual(["Chocolate milk"]);
    expect(boosted("vanilla", [logged("Yogurt (Vanilla Queen)", 13)])).toEqual(["Yogurt (Vanilla Queen)"]);
    expect(boosted("ch", [logged("Chocolate milk", 13)])).toEqual(["Chocolate milk"]);
  });

  it("gives the major boost to the last 20 foods, however old", () => {
    const foods = Array.from({ length: RECENT_FOODS }, (_, i) => logged(`Oat flakes ${i}`, 100 + i, `oats-${i}`));
    expect(boosted("flakes", foods, 100)).toHaveLength(RECENT_FOODS);
    // The 21st food loses the major boost: a flavour match is no longer enough.
    expect(boosted("chocolate", [...foods, logged("Chocolate milk", 200)])).toEqual([]);
    // One of the 20 keeps it, flavour match or not.
    expect(boosted("chocolate", [...foods.slice(1), logged("Chocolate milk", 200)])).toEqual(["Chocolate milk"]);
  });

  it("counts a food once towards the last 20, at its latest entry", () => {
    const repeats = Array.from({ length: RECENT_FOODS + 5 }, (_, i) => logged("Oats", 20 + i, "oats"));
    expect(boosted("chocolate", [...repeats, logged("Chocolate milk", 90)])).toEqual(["Chocolate milk"]);
    expect(boosted("oats", repeats)).toEqual(["Oats"]);
  });

  it("gives an older food the minor boost only if it is a good match", () => {
    const older = (label: string) => [...filler(), logged(label, 90)];
    expect(boosted("chocolate", older("Dark chocolate"))).toEqual(["Dark chocolate"]);
    expect(boosted("choco", older("Dark chocolate"))).toEqual(["Dark chocolate"]);
    expect(boosted("dark ch", older("Dark chocolate"))).toEqual([]);
    expect(boosted("ch", older("Dark chocolate"))).toEqual([]);
    expect(boosted("chocolate", older("Chocolate milk"))).toEqual([]);
    expect(boosted("vanilla", older("Yogurt (Vanilla Queen)"))).toEqual([]);
    expect(boosted("chocolate milk", older("Chocolate milk"))).toEqual(["Chocolate milk"]);
  });

  it("puts major foods first, then at most a few minor foods", () => {
    const minor = Array.from({ length: MAX_MINOR_ROWS + 2 }, (_, i) => logged(`Old milk ${i}`, 100 + i, `old-${i}`));
    const got = boosted("old milk", [...minor, ...filler(), logged("Chocolate milk old", 1)]);
    expect(got[0]).toBe("Chocolate milk old");
    expect(got).toHaveLength(1 + MAX_MINOR_ROWS);
  });

  it("orders by whole words, then the food before its flavour, then the most recent", () => {
    expect(boosted("milk", [logged("Milky bar", 1), logged("Milk chocolate", 2), logged("Chocolate milk", 3), logged("Skim milk", 4)])).toEqual([
      "Chocolate milk",
      "Skim milk",
      "Milk chocolate",
      "Milky bar",
    ]);
  });

  it("stays within the limit, and ignores foods that do not match", () => {
    expect(boosted("milk", [logged("Skim milk", 1), logged("Whole milk", 2), logged("Oats", 1)], 1)).toEqual(["Skim milk"]);
  });

  it("does not boost anything just past the two weeks when 20 newer foods exist", () => {
    const justOver = { ...logged("Chocolate milk", 0), at: NOW - RECENT_MS - 1 };
    const within = { ...logged("Chocolate milk", 0), at: NOW - RECENT_MS };
    const newer = Array.from({ length: RECENT_FOODS }, (_, i) => logged(`Filler ${i}`, 1, `filler-${i}`));
    expect(boosted("chocolate", [...newer, justOver])).toEqual([]);
    expect(boosted("chocolate", [...newer, within])).toEqual(["Chocolate milk"]);
  });

  it("treats entry IDs, which are lower case, as the catalogue's mixed-case IDs", () => {
    expect(foodKey({ source: "afcd", id: "F005634" })).toBe(foodKey({ source: "afcd", id: "f005634" }));
  });
});

const food = (id: string, name: string, brand?: string): FoodItem => ({
  ref: { source: "off", id },
  name,
  ...(brand ? { brand } : {}),
  basis: "g",
  per100: { energyKcal: 100, nutrients: {} },
  portions: [],
});

const entry = (f: FoodItem, daysAgo = 1): LoggedFood => ({
  id: `entry-${f.ref.id}-${daysAgo}`,
  ref: { ...f.ref, id: f.ref.id.toLowerCase() },
  label: f.brand ? `${f.name} (${f.brand})` : f.name,
  at: NOW - daysAgo * DAY,
});

const dark = food("1", "Dark chocolate", "Lindt");
const milk = food("2", "Chocolate milk");
const biscuit = food("3", "Chocolate biscuit");

function catalog(foods: readonly FoodItem[] = [dark, milk, biscuit]) {
  const inner = new LocalFoodCatalog(foods);
  const get = vi.spyOn(inner, "get");
  const search = vi.spyOn(inner, "search");
  return { c: new LoggedFoodsCatalog(inner, () => NOW), inner, get, search };
}
const names = async (c: FoodCatalog, query: string) => (await c.search(query)).map((h) => h.summary.name);

describe("LoggedFoodsCatalog", () => {
  afterEach(() => vi.useRealTimers());

  it("answers as the other catalogue does with no history", async () => {
    const { c, inner } = catalog();
    expect(await c.search("chocolate")).toEqual(await inner.search("chocolate"));
  });

  it("puts a recent food first and does not repeat it", async () => {
    const { c } = catalog();
    c.merge([entry(biscuit)]);
    const got = await names(c, "chocolate");
    expect(got[0]).toBe("Chocolate biscuit");
    expect(got.filter((n) => n === "Chocolate biscuit")).toHaveLength(1);
    expect(got).toHaveLength(3);
  });

  it("marks the matched words in a logged food's row", async () => {
    const { c } = catalog();
    c.merge([entry(biscuit)]);
    expect((await c.search("chocolate"))[0]!.name).toEqual([
      { text: "Chocolate", match: true },
      { text: " biscuit", match: false },
    ]);
  });

  it("shows a logged food the other catalogue did not return", async () => {
    const inner: FoodCatalog = { label: "x", search: async () => [], get: async () => biscuit };
    const c = new LoggedFoodsCatalog(inner, () => NOW);
    c.merge([entry(biscuit)]);
    expect(await names(c, "chocolate")).toEqual(["Chocolate biscuit"]);
  });

  it("treats a mixed-case catalogue ID and a lower-case entry ID as one food", async () => {
    const mixed = food("F005634", "Chocolate spread");
    const { c } = catalog([mixed]);
    c.merge([entry(mixed)]);
    expect(await names(c, "chocolate")).toEqual(["Chocolate spread"]);
  });

  it("looks up only foods that match, once each", async () => {
    const { c, get } = catalog();
    c.merge([entry(biscuit), entry(food("9", "Oats"))]);
    await c.search("chocolate");
    await c.search("chocolate b");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toEqual(biscuit.ref);
  });

  it("does not look up a food the user just logged", async () => {
    const { c, get } = catalog();
    c.add(entry(biscuit), biscuit);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate biscuit");
    expect(get).not.toHaveBeenCalled();
  });

  it("drops a food the catalogue no longer has", async () => {
    const { c, get } = catalog();
    c.merge([entry(food("9", "Chocolate gone"))]);
    expect(await names(c, "chocolate gone")).toEqual([]);
    await c.search("chocolate gone");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("still shows logged foods if the other catalogue fails, and fails if there are none", async () => {
    const inner: FoodCatalog = { label: "x", search: async () => Promise.reject(new Error("offline")), get: async () => biscuit };
    const c = new LoggedFoodsCatalog(inner, () => NOW);
    await expect(c.search("chocolate")).rejects.toThrow("offline");
    c.merge([entry(biscuit)]);
    expect(await names(c, "chocolate")).toEqual(["Chocolate biscuit"]);
  });

  it("still answers if a lookup fails, tries it again later, and reports no change", async () => {
    let fail = true;
    const inner = new LocalFoodCatalog([dark]);
    const get = vi.spyOn(inner, "get").mockImplementation(async () => {
      if (fail) throw new Error("offline");
      return biscuit;
    });
    const c = new LoggedFoodsCatalog(inner, () => NOW);
    const changed = vi.fn();
    c.merge([entry(biscuit)]);
    c.onChange(changed);
    expect(await names(c, "chocolate")).toEqual(["Dark chocolate"]);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    fail = false;
    expect(await names(c, "chocolate")).toEqual(["Chocolate biscuit", "Dark chocolate"]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not hold up a search for a slow lookup, and says when the food arrives", async () => {
    vi.useFakeTimers();
    let arrive: (f: FoodItem) => void = () => {};
    const inner = new LocalFoodCatalog([dark]);
    vi.spyOn(inner, "get").mockImplementation(() => new Promise((resolve) => (arrive = resolve)));
    const c = new LoggedFoodsCatalog(inner, () => NOW);
    c.merge([entry(biscuit)]);
    const changed = vi.fn();
    c.onChange(changed);

    const search = names(c, "chocolate");
    await vi.advanceTimersByTimeAsync(LOGGED_WAIT_MS);
    expect(await search).toEqual(["Dark chocolate"]);
    expect(changed).not.toHaveBeenCalled();

    arrive(biscuit);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await names(c, "chocolate")).toEqual(["Chocolate biscuit", "Dark chocolate"]);
  });

  it("reports no change when a lookup finishes in time", async () => {
    const { c } = catalog();
    c.merge([entry(biscuit)]);
    const changed = vi.fn();
    c.onChange(changed);
    await c.search("chocolate");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps an entry logged while the diary loads, and does not count one twice", async () => {
    const { c } = catalog();
    const logged = entry(biscuit);
    c.add(logged, biscuit);
    c.merge([entry(milk), logged]);
    const got = await names(c, "chocolate");
    expect(got.slice(0, 2).sort()).toEqual(["Chocolate biscuit", "Chocolate milk"]);
  });

  it("stops boosting a food when its entry is deleted", async () => {
    const { c } = catalog([milk, biscuit]);
    const e = entry(biscuit);
    c.merge([e, entry(milk, 2)]);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate biscuit");
    c.remove(e.id);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate milk");
  });

  it("does not bring back a deleted entry from a diary read already under way", async () => {
    const { c } = catalog([milk, biscuit]);
    const e = entry(biscuit);
    c.merge([e]);
    c.remove(e.id);
    c.merge([e, entry(milk)]);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate milk");
    expect(await names(c, "chocolate")).toHaveLength(2);
    c.clear();
    c.merge([e]);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate biscuit");
  });

  it("leaves no timer behind once a search has answered", async () => {
    vi.useFakeTimers();
    const { c } = catalog();
    c.merge([entry(biscuit)]);
    const search = c.search("chocolate");
    await vi.advanceTimersByTimeAsync(0);
    await search;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a food boosted while it has another entry", async () => {
    const { c } = catalog([biscuit, milk]);
    const newest = entry(biscuit, 1);
    c.merge([newest, entry(biscuit, 3), entry(milk, 2)]);
    c.remove(newest.id);
    expect((await names(c, "chocolate"))[0]).toBe("Chocolate milk");
    expect(await names(c, "chocolate biscuit")).toEqual(["Chocolate biscuit"]);
  });

  it("forgets everything on sign-out", async () => {
    const { c, inner } = catalog();
    c.merge([entry(biscuit)]);
    await c.search("chocolate");
    c.clear();
    expect(await c.search("chocolate")).toEqual(await inner.search("chocolate"));
  });

  it("reports no change when the diary brings nothing new", () => {
    const { c } = catalog();
    const e = entry(biscuit);
    c.merge([e]);
    const changed = vi.fn();
    c.onChange(changed);
    c.merge([e]);
    c.merge([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("reports each change to the history", () => {
    const { c } = catalog();
    const changed = vi.fn();
    c.onChange(changed);
    const e = entry(biscuit);
    c.merge([e]);
    c.add(entry(milk), milk);
    c.remove(e.id);
    c.clear();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("passes get, label and attributions through", async () => {
    const ref: FoodRef = dark.ref;
    const attributions = [{ text: "Source", href: "https://example.com" }];
    const c = new LoggedFoodsCatalog({ label: "Inner", attributions, search: async () => [], get: async () => dark });
    expect(await c.get(ref)).toBe(dark);
    expect(c.label).toBe("Inner");
    expect(c.attributions).toBe(attributions);
  });
});
