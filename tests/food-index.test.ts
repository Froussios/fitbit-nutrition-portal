import { describe, expect, it } from "vitest";
import { IndexBuilder, type RawProduct } from "../pipeline/index-builder";
import { parseQuery } from "../src/core/tokens";
import { FoodIndex, IndexNotFoundError, type IndexReader } from "../src/food/index-engine";
import { CHUNK_SIZE, fromSummaryRow } from "../src/food/index-format";
import { StaticFoodCatalog } from "../src/food/static-catalog";

/**
 * Builds a small index from made-up Open Food Facts-shaped records (codes and
 * values are fake) and queries it with the real engine.
 */

function product(code: string, name: string, extra: Partial<RawProduct> = {}): RawProduct {
  return { code, product_name: name, nutriments: { "energy-kcal_100g": 100 }, ...extra };
}

const FIXTURE: RawProduct[] = [
  product("1001", "Chocolate", { unique_scans_n: 1 }),
  product("1002", "Dark Chocolate", { brands: "Brand A", unique_scans_n: 50 }),
  product("1003", "Milk Chocolate", { brands: "Brand B", unique_scans_n: 500, countries_tags: ["en:australia"] }),
  product("1004", "Dark chocolate with almonds", { unique_scans_n: 9000 }),
  product("1005", "Weet-Bix", { brands: "Sanitarium", quantity: "575 g", serving_size: "2 biscuits (30 g)", serving_quantity: 30, serving_quantity_unit: "g", nutriments: { "energy-kcal_100g": 358, proteins_100g: 12 } }),
  product("9300000000006", "Dairy Milk", { brands: "Cadbury", nutriments: { "energy-kcal_100g": 530 } }),
  // Same words and energy as 1003: collapsed in search, still found by barcode.
  product("1007", "Milk chocolate", { brands: "Brand B", unique_scans_n: 1 }),
  product("012345678905", "Peanut butter", { nutriments: { "energy-kcal_100g": 620 } }),
  // Dropped: no name, no energy, implausible energy, obsolete.
  product("2001", ""),
  { code: "2002", product_name: "Mystery", nutriments: {} },
  product("2003", "Too much", { nutriments: { "energy-kcal_100g": 5000 } }),
  product("2004", "Gone", { obsolete: "on" }),
];

/** Many products sharing a word, so its list is split into chunks. */
const MANY = Array.from({ length: CHUNK_SIZE + 500 }, (_, i) =>
  product(`9${String(i).padStart(6, "0")}`, `Snack bar flavour${i}${i === CHUNK_SIZE + 400 ? " special" : ""}`),
);

function build(records: RawProduct[]) {
  const b = new IndexBuilder({ version: "test", builtAt: "2026-11-02T00:00:00Z", dictShardBytes: 2000, packBytes: 500 });
  for (const r of records) b.add(r);
  const files = new Map<string, string | Uint8Array>(b.files());
  const read: string[] = [];
  const get = (path: string) => {
    const f = files.get(path);
    if (f === undefined) throw new IndexNotFoundError(path);
    read.push(path);
    return f;
  };
  const reader: IndexReader = {
    json: async <T>(path: string) => JSON.parse(get(path) as string) as T,
    bytes: async (path: string) => get(path) as Uint8Array,
  };
  return { builder: b, files, reader, read };
}

async function names(index: FoodIndex, query: string): Promise<string[]> {
  const ids = await index.search(parseQuery(query));
  return (await index.summaries(ids)).map((r) => r[1]);
}

describe("food index", () => {
  it("keeps only usable products and counts why the rest were dropped", () => {
    const { builder } = build(FIXTURE);
    expect(builder.counts).toMatchObject({
      read: 12,
      kept: 8,
      "dropped.noName": 1,
      "dropped.noEnergy": 1,
      "dropped.implausibleEnergy": 1,
      "dropped.obsolete": 1,
      duplicates: 1,
    });
  });

  it("ranks by coverage, then popularity", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "chocolate")).toEqual(["Chocolate", "Milk Chocolate", "Dark Chocolate", "Dark chocolate with almonds"]);
  });

  it("needs every word, in any order, with the last one as a prefix", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "chocolate dark")).toEqual(["Dark Chocolate", "Dark chocolate with almonds"]);
    expect(await names(index, "dark choc")).toEqual(["Dark Chocolate", "Dark chocolate with almonds"]);
    expect(await names(index, "white chocolate ")).toEqual([]);
    expect(await names(index, "chocolat ")).toEqual([]); // complete word, no typo tolerance
  });

  it("matches brands and joined words", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "cadbury")).toEqual(["Dairy Milk"]);
    expect(await names(index, "weetbix")).toEqual(["Weet-Bix"]);
    expect(await names(index, "weet bix")).toEqual(["Weet-Bix"]);
    expect(await names(index, "sanitarium weet")).toEqual(["Weet-Bix"]);
  });

  it("returns the full food and finds barcodes in both UPC-A and EAN-13 form", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    const id = await index.findBarcode("1005");
    const food = await index.food(id!);
    expect(food).toMatchObject({ name: "Weet-Bix", brand: "Sanitarium", packSize: "575 g", basis: "g", per100: { energyKcal: 358, nutrients: { protein: 12 } } });
    expect(food.portions).toContainEqual({ name: "2 biscuits (30 g)", amount: 30, unit: "g" });
    expect(fromSummaryRow((await index.summaries([id!]))[0]!).serving).toEqual({ label: "2 biscuits (30 g)", amount: 30, unit: "g", kcal: 107.4 });
    expect(await index.findBarcode("0012345678905")).toBeDefined();
    expect(await index.findBarcode("1007")).toBeDefined(); // a collapsed duplicate
    expect(await index.findBarcode("4242")).toBeUndefined();
  });

  it("walks long lists chunk by chunk and stops early", async () => {
    const { reader, read } = build([...FIXTURE, ...MANY]);
    const index = await FoodIndex.open(reader);
    expect(await names(index, "snack")).toHaveLength(10);
    // Only the first chunk of the long "snack" list is read.
    const big = () => read.filter((p) => p.startsWith("big/")).map((p) => p.replace(/^big\/\d+\//, "big/L/"));
    expect(big()).toEqual(["big/L/0.bin"]);
    // A rare word jumps straight to the chunk that holds its product, via the skip list.
    expect(await names(index, "snack special")).toEqual([`Snack bar flavour${CHUNK_SIZE + 400} special`]);
    expect(big()).toEqual(["big/L/0.bin", "big/L/skip.json", "big/L/1.bin"]);
    expect(await names(index, "sn")).toHaveLength(10);
  });

  it("answers no-match prefixes without errors", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "zz")).toEqual([]);
    expect(await names(index, "zzz")).toEqual([]);
    expect(await names(index, "zzzz")).toEqual([]);
  });
});

describe("StaticFoodCatalog", () => {
  function serve(files: Map<string, string | Uint8Array>, version = "test") {
    const all = new Map<string, string | Uint8Array>([["idx/current.json", JSON.stringify({ version })]]);
    for (const [p, f] of files) all.set(`idx/${version}/${p}`, f);
    return async (url: RequestInfo | URL) => {
      const f = all.get(String(url));
      return f === undefined ? new Response("nope", { status: 404 }) : new Response(f as BodyInit);
    };
  }

  it("searches with highlights and returns the chosen food", async () => {
    const catalog = new StaticFoodCatalog("idx/", serve(build(FIXTURE).files));
    const hits = await catalog.search("dark choc");
    expect(hits.map((h) => h.summary.name)).toEqual(["Dark Chocolate", "Dark chocolate with almonds"]);
    expect(hits[0]!.name).toEqual([
      { text: "Dark", match: true },
      { text: " ", match: false },
      { text: "Chocolate", match: true },
    ]);
    expect(await catalog.get(hits[0]!.summary.ref)).toMatchObject({ name: "Dark Chocolate", brand: "Brand A" });
    expect(catalog.label).toBe("Open Food Facts index test");
  });

  it("puts an exact barcode hit first", async () => {
    const catalog = new StaticFoodCatalog("idx/", serve(build(FIXTURE).files));
    expect((await catalog.search("9300000000006")).map((h) => h.summary.name)).toEqual(["Dairy Milk"]);
  });

  it("fails clearly when there is no index", async () => {
    const catalog = new StaticFoodCatalog("missing/", serve(new Map()));
    await expect(catalog.open()).rejects.toBeInstanceOf(IndexNotFoundError);
  });
});
