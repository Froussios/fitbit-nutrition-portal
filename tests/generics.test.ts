import { afterEach, describe, expect, it, vi } from "vitest";
import { fromAfcd, fromFndds, type TableRow } from "../pipeline/generics-builder";
import { CombinedCatalog, GENERICS_WAIT_MS, MAX_GENERIC_ROWS } from "../src/food/combined-catalog";
import { LocalFoodCatalog, type FoodCatalog } from "../src/food/catalog";
import { genericToFoodItem, GENERICS_FORMAT, type GenericRow, type GenericsFile } from "../src/food/generics-format";
import { GenericIndex, MIN_PRIMARY_FOODS, queryVariants, singular } from "../src/food/generic-search";
import { parseQuery } from "../src/core/tokens";
import { fromOffProduct, type OffProduct } from "../src/core/off";
import { SOURCE_TAGS, type FoodSource } from "../src/core/food";

/** Values are made up; only the shape and the conversions matter here. */
const afcdRow = (key: string, name: string, kj: string, extra: Record<string, string> = {}): TableRow => ({
  "Public Food Key": key,
  "Food Name": name,
  "Energy with dietary fibre, equated (kJ)": kj,
  "Fat, total (g)": "3.5",
  "Total saturated fatty acids, equated (g)": "2",
  "Total trans fatty acids, imputed (mg)": "100",
  "Total monounsaturated fatty acids, equated (g)": "1",
  "Total polyunsaturated fatty acids, equated (g)": "0.1",
  "Cholesterol (mg)": "10",
  "Available carbohydrate, with sugar alcohols (g)": "5",
  "Total sugars (g)": "5",
  "Total dietary fibre (g)": "0",
  "Protein (g)": "3",
  "Sodium (Na) (mg)": "36",
  "Potassium (K) (mg)": "146",
  "Calcium (Ca) (mg)": "109",
  "Iron (Fe) (mg)": "0.02",
  "Caffeine (mg)": "0",
  "Vitamin C (mg)": "1",
  ...extra,
});

describe("generic foods builder", () => {
  it("converts AFCD to kcal and grams, using the per-100-ml row for liquids", () => {
    const solids = [afcdRow("F1", "Rice, white, uncooked", "1423"), afcdRow("F2", "Milk, cow, fluid", "290")];
    const liquids = [afcdRow("F2", "Milk, cow, fluid", "278")];
    const details = [{ "Public Food Key": "F1", "Specific Gravity": "0" }, { "Public Food Key": "F2", "Specific Gravity": "1.03" }];
    const [rice, milk] = fromAfcd(solids, liquids, details);
    expect(rice!.slice(0, 5)).toEqual(["afcd", "F1", "Rice, white, uncooked", "g", 340.1]);
    expect(rice![6]).toBeNull(); // 0 means no density here, not 0 g/ml
    expect(milk!.slice(3, 5)).toEqual(["ml", 66.4]);
    expect(milk![6]).toBe(1.03);
    const food = genericToFoodItem(milk!);
    expect(food.per100.nutrients).toMatchObject({ fat: 3.5, transFat: 0.1, sodium: 0.036, iron: 0.00002, vitaminC: 0.001 });
    expect(food.densityGPerMl).toBe(1.03);
  });

  it("fails rather than silently losing a nutrient if an AFCD column is renamed", () => {
    const { "Protein (g)": _gone, ...renamed } = afcdRow("F1", "Rice", "1423");
    expect(() => fromAfcd([renamed], [], [])).toThrow(/Protein/);
  });

  it("converts FNDDS, taking fibre out of carbohydrate to match the Australian definition", () => {
    const foods = [{ fdc_id: "1", description: "Banana, raw" }];
    const nutrient = (nutrient_id: string, amount: string) => ({ fdc_id: "1", nutrient_id, amount });
    const nutrients = [nutrient("208", "97"), nutrient("205", "22.7"), nutrient("291", "2.6"), nutrient("307", "1"), nutrient("9999", "5")];
    const portions = [
      { fdc_id: "1", seq_num: "2", portion_description: "1 medium", gram_weight: "118" },
      { fdc_id: "1", seq_num: "1", portion_description: "1 cup", gram_weight: "150" },
      { fdc_id: "1", seq_num: "3", portion_description: "Quantity not specified", gram_weight: "118" },
      { fdc_id: "1", seq_num: "4", portion_description: "Guideline amount per cup of hot cereal", gram_weight: "60" },
      { fdc_id: "1", seq_num: "5", portion_description: "1 oz", gram_weight: "28.35" },
    ];
    const [row] = fromFndds(foods, nutrients, portions);
    const food = genericToFoodItem(row!);
    expect(food).toMatchObject({ ref: { source: "fndds", id: "1" }, name: "Banana, raw", basis: "g" });
    expect(food.per100.energyKcal).toBe(97);
    expect(food.per100.nutrients.carbohydrates).toBeCloseTo(20.1, 5);
    expect(food.per100.nutrients.sodium).toBe(0.001);
    expect(food.portions).toEqual([{ name: "1 cup", amount: 150, unit: "g" }, { name: "1 medium", amount: 118, unit: "g" }]);
  });

  it("never lets carbohydrate go below zero, and leaves out foods with no energy, for infants, or human milk", () => {
    const foods = [
      { fdc_id: "1", description: "Bran" },
      { fdc_id: "2", description: "No energy" },
      { fdc_id: "3", description: "Milk, human" },
      { fdc_id: "4", description: "Infant formula, prepared" },
    ];
    const n = (fdc_id: string, nutrient_id: string, amount: string) => ({ fdc_id, nutrient_id, amount });
    const rows = fromFndds(foods, [n("1", "208", "200"), n("1", "205", "5"), n("1", "291", "9"), n("3", "208", "70"), n("4", "208", "70")], []);
    expect(rows.map((r) => r[2])).toEqual(["Bran"]);
    expect(genericToFoodItem(rows[0]!).per100.nutrients.carbohydrates).toBe(0);
  });
});

const row = (source: FoodSource, id: string, name: string, kcal = 100): GenericRow => [source, id, name, "g", kcal, [], null, []];

describe("generic search", () => {
  const names = (rows: readonly GenericRow[], query: string) => new GenericIndex(rows).search(query).map((r) => r[2]);

  it("treats the words before the first comma as the food", () => {
    const rows = [row("afcd", "1", "Bread, banana, commercial"), row("afcd", "2", "Chocolate, milk"), row("afcd", "3", "Milk, cow, fluid"), row("afcd", "4", "Banana, cavendish, peeled, raw")];
    expect(names(rows, "banana")).toEqual(["Banana, cavendish, peeled, raw", "Bread, banana, commercial"]);
    expect(names(rows, "milk")).toEqual(["Milk, cow, fluid", "Chocolate, milk"]);
  });

  it("prefers the plain form of a food", () => {
    const rows = [row("afcd", "1", "Milk, cow, canned, evaporated"), row("afcd", "2", "Milk, cow, fluid, regular fat (~3.5%)"), row("afcd", "3", "Banana, frozen"), row("afcd", "4", "Banana, cavendish, peeled, raw")];
    expect(names(rows, "milk")[0]).toBe("Milk, cow, fluid, regular fat (~3.5%)");
    expect(names(rows, "banana")[0]).toBe("Banana, cavendish, peeled, raw");
  });

  it("finds singular and plural alike, and half-typed words", () => {
    const rows = [row("afcd", "1", "Banana, raw"), row("afcd", "2", "Tomato, raw")];
    expect(singular("bananas")).toBe("banana");
    expect(singular("tomatoes")).toBe("tomato");
    expect(singular("berries")).toBe("berry");
    expect(singular("swiss")).toBe("swiss");
    expect(singular("pies")).toBe(singular("pie"));
    expect(singular("ties")).toBe(singular("tie"));
    expect(names(rows, "bananas")).toEqual(["Banana, raw"]);
    expect(names(rows, "tomatoes")).toEqual(["Tomato, raw"]);
    expect(names(rows, "bana")).toEqual(["Banana, raw"]);
  });

  it("puts a whole word before a longer word that starts the same", () => {
    expect(names([row("afcd", "1", "Pineapple juice"), row("afcd", "2", "Pine nut")], "pine")).toEqual(["Pine nut", "Pineapple juice"]);
    expect(names([row("afcd", "1", "Coke, flavoured"), row("afcd", "2", "Cokelat, bar")], "coke")).toEqual(["Coke, flavoured", "Cokelat, bar"]);
  });

  it("shows fallback sources only when the Australian foods are few", () => {
    const au = Array.from({ length: MIN_PRIMARY_FOODS }, (_, i) => row("afcd", `${i}`, `Yoghurt, kind ${"abc"[i]}`));
    expect(names([...au, row("fndds", "9", "Yogurt, Greek")], "yoghurt")).toHaveLength(MIN_PRIMARY_FOODS);
    expect(names([...au.slice(1), row("fndds", "9", "Yoghurt, Greek")], "yoghurt")).toContain("Yoghurt, Greek");
    expect(names([row("fndds", "9", "Pad thai")], "pad thai")).toEqual(["Pad thai"]);
  });

  it("ranks an Australian food above a US one", () => {
    expect(names([row("fndds", "1", "Honey, raw"), row("afcd", "2", "Honey, floral")], "honey")).toEqual(["Honey, floral", "Honey, raw"]);
  });

  it("drops a fallback food with exactly the same name, but never merges values", () => {
    const hits = new GenericIndex([row("fndds", "1", "Honey", 304), row("afcd", "2", "Honey", 278)]).search("honey");
    expect(hits.map((r) => [r[0], r[4]])).toEqual([["afcd", 278]]);
  });

  it("finds a food under either spelling convention", () => {
    const rows = [row("afcd", "1", "Yoghurt, natural"), row("afcd", "2", "Sauce, tomato, commercial"), row("afcd", "3", "Beef, mince, raw"), row("afcd", "4", "Milk, cow, fluid, regular fat")];
    expect(names(rows, "yogurt")).toEqual(["Yoghurt, natural"]);
    expect(names(rows, "ketchup")).toEqual(["Sauce, tomato, commercial"]);
    expect(names(rows, "ground beef")).toEqual(["Beef, mince, raw"]);
    expect(names(rows, "full cream milk")).toEqual(["Milk, cow, fluid, regular fat"]);
    expect(names([row("fndds", "1", "Yogurt, plain")], "yoghurt")).toEqual(["Yogurt, plain"]);
    expect(queryVariants(parseQuery("rice"))).toHaveLength(1);
  });

  it("finds a food again from the lower-case ID stored in a diary entry", () => {
    const index = new GenericIndex([row("afcd", "F005634", "Milk")]);
    expect(index.get("afcd", "f005634")?.name).toBe("Milk");
    expect(index.get("fndds", "f005634")).toBeUndefined();
  });
});

describe("CombinedCatalog", () => {
  const file = (foods: readonly GenericRow[]): GenericsFile => ({ format: GENERICS_FORMAT, sources: [], notice: "", foods });
  const serve = (f: GenericsFile) => (async () => new Response(JSON.stringify(f))) as unknown as typeof fetch;
  const product = (code: string, name: string, brands?: string): OffProduct => ({ code, product_name: name, ...(brands ? { brands } : {}), nutriments: { "energy-kcal_100g": 100 } });
  const products = (list: readonly OffProduct[]) => new LocalFoodCatalog(list.map(fromOffProduct));
  const combined = (foods: readonly GenericRow[], p: FoodCatalog) => new CombinedCatalog("generics", p, "licence", serve(file(foods)));
  const label = (s: { name: string; brand?: string }) => (s.brand ? `${s.name} (${s.brand})` : s.name);

  it("gives the owner's vanilla example in the owner's order", async () => {
    const catalog = combined(
      [row("afcd", "1", "Vanilla extract"), row("afcd", "2", "Vanilla bean")],
      products([product("3", "Yogurt", "Vanilla Queen"), product("4", "Vanilla extract", "Queen"), product("5", "Vanilla", "Queen"), product("6", "Vanilla", "Vanilla Queen")]),
    );
    const hits = await catalog.search("vanilla");
    expect(hits.map((h) => label(h.summary))).toEqual(["Vanilla extract", "Vanilla bean", "Vanilla (Vanilla Queen)", "Vanilla (Queen)", "Vanilla extract (Queen)", "Yogurt (Vanilla Queen)"]);
  });

  it("gives the owner's vegemite example in the owner's order", async () => {
    const catalog = combined(
      [row("afcd", "1", "Spread, yeast, vegemite")],
      products([product("2", "Vegemite pretzels", "Other"), product("3", "Vegemite", "Other"), product("4", "Vegemite", "Vegemite")]),
    );
    const hits = await catalog.search("vegemite");
    expect(hits.map((h) => label(h.summary))).toEqual(["Spread, yeast, vegemite", "Vegemite (Vegemite)", "Vegemite (Other)", "Vegemite pretzels (Other)"]);
  });

  it("keeps branded products in view however many generic foods match, and asks only for the rows it can show", async () => {
    const asked: (number | undefined)[] = [];
    const inner = products([product("x", "Milk", "Pura")]);
    const spy: FoodCatalog = { label: "spy", search: (q, o) => (asked.push(o?.limit), inner.search(q, o)), get: (r) => inner.get(r) };
    const hits = await combined(Array.from({ length: 12 }, (_, i) => row("afcd", `${i}`, `Milk, kind ${i}`)), spy).search("milk");
    expect(asked).toEqual([10 - MAX_GENERIC_ROWS]);
    expect(hits.slice(0, MAX_GENERIC_ROWS).every((h) => h.summary.ref.source === "afcd")).toBe(true);
    expect(hits[MAX_GENERIC_ROWS]!.summary.brand).toBe("Pura");
    // Products left rows empty, so more generic foods fill them.
    expect(hits).toHaveLength(10);
    expect(hits.slice(MAX_GENERIC_ROWS + 1).every((h) => h.summary.ref.source === "afcd")).toBe(true);
  });

  it("returns the full food from the right source", async () => {
    const catalog = combined([["afcd", "F1", "Milk, cow", "ml", 66, [3.5], 1.03, []]], products([product("x", "Milk", "Pura")]));
    expect(await catalog.get({ source: "afcd", id: "f1" })).toMatchObject({ name: "Milk, cow", basis: "ml", densityGPerMl: 1.03 });
    expect(await catalog.get({ source: "off", id: "x" })).toMatchObject({ brand: "Pura" });
  });

  it("still shows generic foods when products fail, and products when generic foods fail", async () => {
    const failing: FoodCatalog = { label: "down", search: async () => { throw new Error("index down"); }, get: async () => undefined };
    expect((await combined([row("afcd", "1", "Milk, cow")], failing).search("milk")).map((h) => h.summary.name)).toEqual(["Milk, cow"]);
    const noFile = new CombinedCatalog("generics", products([product("x", "Milk", "Pura")]), "licence", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    expect((await noFile.search("milk")).map((h) => h.summary.brand)).toEqual(["Pura"]);
  });

  describe("when the generic file is slow", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const stalled = () => {
      let deliver = (_: Response) => {};
      const fetchImpl = (() => new Promise<Response>((resolve) => (deliver = resolve))) as unknown as typeof fetch;
      return { fetchImpl, deliver: (f: GenericsFile) => deliver(new Response(JSON.stringify(f))) };
    };
    const inner = () => products([product("x", "Milk", "Pura")]);
    const brands = (hits: readonly { summary: { brand?: string; name: string } }[]) => hits.map((h) => h.summary.brand ?? h.summary.name);

    it("shows products without it after a short wait, then doesn't wait again", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = stalled();
      const catalog = new CombinedCatalog("generics", inner(), "licence", fetchImpl);
      const first = catalog.search("milk");
      await vi.advanceTimersByTimeAsync(GENERICS_WAIT_MS);
      expect(brands(await first)).toEqual(["Pura"]);
      // No timers advance here: a later search answers straight away.
      expect(brands(await catalog.search("milk"))).toEqual(["Pura"]);
    });

    it("uses the generic file as soon as it arrives", async () => {
      vi.useFakeTimers();
      const { fetchImpl, deliver } = stalled();
      const catalog = new CombinedCatalog("generics", inner(), "licence", fetchImpl);
      const first = catalog.search("milk");
      await vi.advanceTimersByTimeAsync(GENERICS_WAIT_MS);
      await first;
      deliver(file([row("afcd", "1", "Milk, cow")]));
      await vi.advanceTimersByTimeAsync(0);
      expect(brands(await catalog.search("milk"))).toEqual(["Milk, cow", "Pura"]);
    });

    it("doesn't hold up a cancelled search", async () => {
      const { fetchImpl } = stalled();
      const catalog = new CombinedCatalog("generics", inner(), "licence", fetchImpl);
      const abort = new AbortController();
      const search = catalog.search("milk", { signal: abort.signal });
      abort.abort();
      await expect(search).rejects.toThrow();
    });

    it("doesn't hold up a cancelled lookup of a generic food", async () => {
      const { fetchImpl } = stalled();
      const catalog = new CombinedCatalog("generics", inner(), "licence", fetchImpl);
      const abort = new AbortController();
      const lookup = catalog.get({ source: "afcd", id: "1" }, { signal: abort.signal });
      abort.abort();
      await expect(lookup).rejects.toThrow();
    });

    it("tries again after a failed download, and waits for that attempt too", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        if (calls === 1) throw new Error("network down");
        return new Response(JSON.stringify(file([row("afcd", "1", "Milk, cow")])));
      }) as unknown as typeof fetch;
      const catalog = new CombinedCatalog("generics", inner(), "licence", fetchImpl);
      expect(brands(await catalog.search("milk"))).toEqual(["Pura"]);
      expect(brands(await catalog.search("milk"))).toEqual(["Milk, cow", "Pura"]);
    });
  });

  it("reports a failure when nothing can answer, and doesn't swallow a cancelled search", async () => {
    const failing: FoodCatalog = { label: "down", search: async () => { throw new Error("index down"); }, get: async () => undefined };
    await expect(combined([], failing).search("milk")).rejects.toThrow("index down");
    const abort = new AbortController();
    abort.abort();
    await expect(combined([row("afcd", "1", "Milk")], failing).search("milk", { signal: abort.signal })).rejects.toThrow();
  });

  it("names both generic sources' licence and the products' attribution", () => {
    const withAttribution: FoodCatalog = { ...products([]), label: "p", search: async () => [], get: async () => undefined, attributions: [{ text: "Products: OFF", href: "off" }] };
    expect(combined([], withAttribution).attributions).toEqual([{ text: "Generic foods: FSANZ AFCD, USDA FNDDS", href: "licence" }, { text: "Products: OFF", href: "off" }]);
  });
});

describe("the committed generic foods file", () => {
  it("holds both sources, with the licence notice, and usable values", async () => {
    const { readFile } = await import("node:fs/promises");
    const f = JSON.parse(await readFile("src/food/data/generics.json", "utf8")) as GenericsFile;
    expect(f.format).toBe(GENERICS_FORMAT);
    expect(f.notice).toContain("There are limitations associated with food composition databases.");
    expect(f.notice).toContain("may not be appropriate for use in other countries");
    const count = (s: FoodSource) => f.foods.filter((r) => r[0] === s).length;
    expect(count("afcd")).toBeGreaterThan(1500);
    expect(count("fndds")).toBeGreaterThan(5000);
    expect(f.foods.every((r) => r[4] >= 0 && r[4] <= 950 && r[2].length > 0)).toBe(true);
    expect(new Set(f.foods.map((r) => `${r[0]}:${r[1]}`)).size).toBe(f.foods.length);
    const milk = new GenericIndex(f.foods).search("milk")[0]!;
    expect(milk[2]).toMatch(/^Milk, cow, fluid, regular fat/);
    expect(milk[4]).toBeGreaterThan(55);
    expect(milk[4]).toBeLessThan(75);
  });
});

describe("source tags", () => {
  it("spell out Open Food Facts, because \"OFF\" reads as the word", () => {
    expect(SOURCE_TAGS.off).toBe("Open Food Facts");
    expect(SOURCE_TAGS.afcd).toBe("AFCD");
    expect(SOURCE_TAGS.fndds).toBe("FNDDS");
  });
});
