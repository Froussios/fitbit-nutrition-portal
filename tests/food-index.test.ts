import { describe, expect, it } from "vitest";
import { IndexBuilder, type BuildOptions, type RawProduct } from "../pipeline/index-builder";
import { compareMatch, matchRank, parseQuery, productMatches } from "../src/core/tokens";
import { FoodIndex, IndexNotFoundError, type IndexReader } from "../src/food/index-engine";
import { CHUNK_SIZE, deltas, fromSummaryRow, undeltas, type DictEntry, type SummaryRow } from "../src/food/index-format";
import { StaticFoodCatalog } from "../src/food/static-catalog";

/**
 * Builds a small index from made-up Open Food Facts-shaped records (codes and
 * values are fake) and queries it with the real engine.
 */

function product(code: string, name: string, extra: Partial<RawProduct> = {}): RawProduct {
  return { code, product_name: name, nutriments: { "energy-kcal_100g": 100 }, ...extra };
}

const FIXTURE: RawProduct[] = [
  // Same words as 1001: unbranded, so collapsed whatever the energy.
  product("1008", "chocolate", { nutriments: { "energy-kcal_100g": 300 } }),
  product("1001", "Chocolate", { unique_scans_n: 1 }),
  product("1002", "Dark Chocolate", { brands: "Alpha", unique_scans_n: 50 }),
  product("1003", "Milk Chocolate", { brands: "Beta", unique_scans_n: 500, countries_tags: ["en:australia"] }),
  product("1004", "Dark chocolate with almonds", { unique_scans_n: 9000 }),
  product("1005", "Weet-Bix", { brands: "Sanitarium", quantity: "575 g", serving_size: "2 biscuits (30 g)", serving_quantity: 30, serving_quantity_unit: "g", nutriments: { "energy-kcal_100g": 358, proteins_100g: 12 } }),
  product("9300000000006", "Dairy Milk", { brands: "Cadbury", nutriments: { "energy-kcal_100g": 530 } }),
  // Same words and energy as 1003: collapsed in search, still found by barcode.
  product("1007", "Milk chocolate", { brands: "Beta", unique_scans_n: 1 }),
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

function build(records: RawProduct[], options: Partial<BuildOptions> = {}) {
  const b = new IndexBuilder({ version: "test", builtAt: "2026-11-02T00:00:00Z", dictShardBytes: 2000, packBytes: 500, ...options });
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
      read: 13,
      kept: 9,
      "dropped.noName": 1,
      "dropped.noEnergy": 1,
      "dropped.implausibleEnergy": 1,
      "dropped.obsolete": 1,
      duplicates: 2,
    });
  });

  it("ranks generic products first, then by coverage, then popularity", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "chocolate")).toEqual(["Chocolate", "Dark chocolate with almonds", "Milk Chocolate", "Dark Chocolate"]);
  });

  it("gives the owner's examples in the owner's order", async () => {
    const queen = (code: string, name: string, brands: string | undefined, kcal: number) =>
      product(code, name, { ...(brands ? { brands } : {}), nutriments: { "energy-kcal_100g": kcal } });
    const index = await FoodIndex.open(
      build([
        queen("3001", "Yogurt", "Vanilla Queen", 80),
        queen("3002", "Vanilla extract", "Queen", 200),
        queen("3003", "Vanilla", "Queen", 100),
        queen("3004", "Vanilla", "Vanilla Queen", 101),
        queen("3005", "Vanilla bean", undefined, 300),
        queen("3006", "Vanilla extract", undefined, 290),
        queen("3007", "Vanilla queen", "Other", 110),
        queen("3008", "Vanilla queen flavour", "Other", 120),
      ]).reader,
    );
    const labels = async (query: string) => {
      const rows = await index.summaries(await index.search(parseQuery(query)));
      return rows.map((r) => (r[2] ? `${r[1]} (${r[2]})` : r[1]));
    };
    expect((await labels("vanilla")).filter((l) => !l.includes("queen"))).toEqual([
      "Vanilla extract",
      "Vanilla bean",
      "Vanilla (Vanilla Queen)",
      "Vanilla (Queen)",
      "Vanilla extract (Queen)",
      "Yogurt (Vanilla Queen)",
    ]);
    expect(await labels("vanilla queen")).toEqual([
      "Vanilla (Vanilla Queen)",
      "Vanilla (Queen)",
      "Vanilla queen (Other)",
      "Vanilla extract (Queen)",
      "Vanilla queen flavour (Other)",
      "Yogurt (Vanilla Queen)",
    ]);
  });

  it("collapses unbranded products by name, keeping word order", async () => {
    const index = await FoodIndex.open(
      build([
        product("8001", "Milk chocolate", { nutriments: { "energy-kcal_100g": 540 } }),
        product("8002", "Milk Chocolate", { nutriments: { "energy-kcal_100g": 500 } }),
        product("8003", "Chocolate milk", { nutriments: { "energy-kcal_100g": 70 } }),
        product("8004", "Milk with chocolate", { nutriments: { "energy-kcal_100g": 150 } }),
      ]).reader,
    );
    const rows = await index.summaries(await index.search(parseQuery("chocolate")));
    expect(rows.map((r) => r[1].toLowerCase()).sort()).toEqual(["chocolate milk", "milk chocolate", "milk with chocolate"]);
  });

  it("ranks more entries with the same name above fewer, across brands", async () => {
    const index = await FoodIndex.open(
      build([
        product("8101", "Probiotic chocolate", { unique_scans_n: 9000, nutriments: { "energy-kcal_100g": 450 } }),
        product("8102", "Milk chocolate", { nutriments: { "energy-kcal_100g": 540 } }),
        product("8103", "Milk chocolate", { brands: "Brand A", nutriments: { "energy-kcal_100g": 530 } }),
        product("8104", "Milk chocolate", { brands: "Brand B", nutriments: { "energy-kcal_100g": 550 } }),
      ]).reader,
    );
    expect((await names(index, "chocolate")).slice(0, 2)).toEqual(["Milk chocolate", "Probiotic chocolate"]);
  });

  it("counts entries sold in Australia for more", async () => {
    const american = Array.from({ length: 5 }, (_, i) => product(`830${i}`, "Whole milk", { brands: `Brand ${i}`, nutriments: { "energy-kcal_100g": 60 + i } }));
    const index = await FoodIndex.open(build([...american, product("8310", "Full cream milk", { countries_tags: ["en:australia"], nutriments: { "energy-kcal_100g": 64 } })]).reader);
    expect((await names(index, "milk"))[0]).toBe("Full cream milk");
  });

  it("puts food matches before flavour matches, even generic ones", async () => {
    const index = await FoodIndex.open(
      build([
        product("8201", "Vegemite pressed pretzels", { nutriments: { "energy-kcal_100g": 439 } }),
        product("8202", "Vegemite", { brands: "Mondelez", nutriments: { "energy-kcal_100g": 191 } }),
        product("8203", "Vegemite", { nutriments: { "energy-kcal_100g": 180 } }),
      ]).reader,
    );
    const rows = await index.summaries(await index.search(parseQuery("vegemite")));
    expect(rows.map((r) => [r[1], r[2]])).toEqual([["Vegemite", null], ["Vegemite", "Mondelez"], ["Vegemite pressed pretzels", null]]);
  });

  it("finds a product the query uses up, however many generic matches come first", async () => {
    const generics = Array.from({ length: 30 }, (_, i) => product(`4${String(i).padStart(4, "0")}`, `Vegemite thing${i}`));
    const index = await FoodIndex.open(
      build([
        ...generics,
        product("4100", "Vegemite", { nutriments: { "energy-kcal_100g": 9 } }),
        product("4101", "Vegemite", { brands: "Vegemite", nutriments: { "energy-kcal_100g": 191 } }),
        product("4102", "Vegemite", { brands: "Bega", nutriments: { "energy-kcal_100g": 190 } }),
      ]).reader,
    );
    const rows = await index.summaries(await index.search(parseQuery("vegemite")));
    expect(rows.slice(0, 2).map((r) => [r[1], r[2]])).toEqual([["Vegemite", null], ["Vegemite", "Vegemite"]]);
    expect(rows).toHaveLength(10);
  });

  it("ranks without fetching text beyond the rows it returns", async () => {
    // Many brand-only matches that would come first in ID order: the name match must still win.
    const crowd = Array.from({ length: 300 }, (_, i) => product(`5${String(i).padStart(4, "0")}`, `Crowd${i}`, { brands: "Vanilla House" }));
    const { reader, read } = build([...crowd, product("6000", "Vanilla yogurt drink", { brands: "Other" })]);
    const index = await FoodIndex.open(reader);
    const before = read.length;
    const [first] = await names(index, "vanilla ");
    expect(first).toBe("Vanilla yogurt drink");
    expect(read.slice(before).filter((p) => p.startsWith("sum/")).length).toBeLessThanOrEqual(2);
  });

  it("agrees with ranking every product by brute force", async () => {
    const words = ["vanilla", "queen", "yogurt", "extract", "bean", "cream", "cola"];
    let seed = 42;
    const pick = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const phrase = (max: number) => Array.from({ length: 1 + pick(max) }, () => words[pick(words.length)]).join(" ");
    const records = Array.from({ length: 2000 }, (_, i) =>
      product(`7${String(i).padStart(5, "0")}`, phrase(4), {
        ...(pick(3) > 0 ? { brands: phrase(2) } : {}),
        unique_scans_n: pick(1000),
        nutriments: { "energy-kcal_100g": 1 + i / 10 },
      }),
    );
    const { files } = build(records);
    const index = await FoodIndex.open(build(records).reader);
    const rows: SummaryRow[] = [];
    for (let n = 0; files.has(`sum/${n}.json`); n++) rows.push(...(JSON.parse(files.get(`sum/${n}.json`) as string) as SummaryRow[]));
    const searchable = rows.slice(0, index.meta.searchableDocs);

    for (const query of ["vanilla", "vanilla ", "queen", "vanilla queen", "queen vanilla ", "cola bean", "yogurt cream extract", "van", "vanilla qu", "cream co"]) {
      const q = parseQuery(query);
      // Without the last rule (query words also in the brand), which only orders the chosen rows: the lists can't see it.
      const rankOf = (r: SummaryRow) => matchRank(q, r[1], r[2] ?? undefined).slice(0, 6).map((n) => n + 0);
      const ranks = searchable
        .filter((r) => productMatches(q, r[1], r[2] ?? undefined))
        .map(rankOf)
        .sort(compareMatch)
        .slice(0, 10);
      const found = (await index.summaries(await index.search(q))).map(rankOf);
      expect(found, query).toEqual(ranks);
    }
  });

  it("still reads a format 2 index, in which a word has one list", async () => {
    const small = FIXTURE.slice(0, 8);
    const { files } = build(small, { dictShardBytes: 1_000_000 });
    const legacy = new Map(files);
    const meta = JSON.parse(files.get("meta.json") as string) as Record<string, unknown>;
    delete meta["bands"];
    delete meta["brandedFrom"];
    legacy.set("meta.json", JSON.stringify({ ...meta, format: 2 }));
    const inline = (ref: DictEntry[1]) => (ref ? undeltas(ref[1] as number[]) : []);
    const entries = JSON.parse(files.get("dict/0.json") as string) as DictEntry[];
    legacy.set(
      "dict/0.json",
      JSON.stringify(
        entries.map(([w, head, rest, brand]) => {
          const ids = [...new Set([...inline(head), ...inline(rest), ...inline(brand)])].sort((a, b) => a - b);
          return [w, ids.length, deltas(ids)];
        }),
      ),
    );
    const reader: IndexReader = {
      json: async <T>(path: string) => {
        if (!legacy.has(path)) throw new IndexNotFoundError(path);
        return JSON.parse(legacy.get(path) as string) as T;
      },
      bytes: async (path: string) => legacy.get(path) as Uint8Array,
    };
    const index = await FoodIndex.open(reader);
    expect(await names(index, "chocolate")).toEqual(["Chocolate", "Dark chocolate with almonds", "Milk Chocolate", "Dark Chocolate"]);
    expect(await names(index, "cadbury")).toEqual(["Dairy Milk"]);
  });

  it("needs every word, in any order, with the last one as a prefix", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "chocolate dark")).toEqual(["Dark chocolate with almonds", "Dark Chocolate"]);
    expect(await names(index, "dark choc")).toEqual(["Dark chocolate with almonds", "Dark Chocolate"]);
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

  it("packs more products per file to stay under the file limit", async () => {
    const { files, reader } = build([...FIXTURE, ...MANY], { maxFiles: 40, dictShardBytes: 50_000 });
    expect(files.size + 2).toBeLessThanOrEqual(40); // plus current.json and LICENSE.txt, written by the CLI
    const index = await FoodIndex.open(reader);
    expect(index.meta.sumPerFile).toBeGreaterThan(256);
    expect(await names(index, "snack special")).toEqual([`Snack bar flavour${CHUNK_SIZE + 400} special`]);
    expect((await index.food((await index.findBarcode("1005"))!)).name).toBe("Weet-Bix");
  });

  it("checks a short, common last word against the other words' matches", async () => {
    // "fl" starts thousands of words, so its precomputed list holds only the best IDs overall,
    // which misses this low-ranked product; candidates for "special" are checked instead.
    const index = await FoodIndex.open(build([...FIXTURE, ...MANY]).reader);
    expect(await names(index, "special fl")).toEqual([`Snack bar flavour${CHUNK_SIZE + 400} special`]);
    expect(await names(index, "special zz")).toEqual([]);
    expect(await names(index, "fl")).toHaveLength(10);
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
    expect(hits.map((h) => h.summary.name)).toEqual(["Dark chocolate with almonds", "Dark Chocolate"]);
    expect(hits[1]!.name).toEqual([
      { text: "Dark", match: true },
      { text: " ", match: false },
      { text: "Chocolate", match: true },
    ]);
    expect(await catalog.get(hits[1]!.summary.ref)).toMatchObject({ name: "Dark Chocolate", brand: "Alpha" });
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
