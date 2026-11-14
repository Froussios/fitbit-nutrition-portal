import { describe, expect, it } from "vitest";
import { IndexBuilder, type BuildOptions, type RawProduct } from "../pipeline/index-builder";
import { MAX_FOOD_ID, MAX_LABEL, MAX_UNIT } from "../src/core/prep";
import { compareMatch, matchRank, parseQuery, productMatches } from "../src/core/tokens";
import { FoodIndex, IndexNotFoundError, newBudget, type IndexReader } from "../src/food/index-engine";
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

  it("skips products too long to save as an ingredient, and lists the first ones for the report", () => {
    const name = "Toasted muesli with almonds and honey ".repeat(4).slice(0, 150);
    const serving = (text: string) => ({ serving_size: text, serving_quantity: 45, serving_quantity_unit: "g" });
    const { builder } = build([
      // At the limits: kept.
      product("3001", name, { brands: "b".repeat(MAX_LABEL - name.length - 3), ...serving("s".repeat(MAX_UNIT - "portion:".length)) }),
      product("3002", name, { brands: "b".repeat(MAX_LABEL - name.length - 2) }),
      product("3003", "Muesli", serving("1 bowl ".repeat(30))),
      product("4".repeat(MAX_FOOD_ID + 1), "Muesli"),
    ]);
    expect(builder.counts).toMatchObject({ read: 4, kept: 1, "dropped.tooLongForIngredient": 3 });
    expect(builder.tooLong.map((t) => t.code)).toEqual(["3002", "3003", "4".repeat(40)]);
    expect(builder.tooLong[0]!.problem).toContain(`over ${MAX_LABEL}`);
    expect(builder.tooLong[1]!.problem).toContain(`over ${MAX_UNIT}`);
    expect(builder.tooLong[2]!.problem).toContain(`over ${MAX_FOOD_ID}`);
  });

  it("ranks branded products first, then by coverage, then popularity", async () => {
    const index = await FoodIndex.open(build(FIXTURE).reader);
    expect(await names(index, "chocolate")).toEqual(["Milk Chocolate", "Dark Chocolate", "Chocolate", "Dark chocolate with almonds"]);
  });

  it("orders products as the owner's examples do, with generic foods left to the generic file", async () => {
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
      "Vanilla (Vanilla Queen)",
      "Vanilla (Queen)",
      "Vanilla extract (Queen)",
      "Vanilla extract",
      "Vanilla bean",
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
        product("8101", "Probiotic chocolate", { brands: "Gamma", unique_scans_n: 9000, nutriments: { "energy-kcal_100g": 450 } }),
        product("8102", "Milk chocolate", { nutriments: { "energy-kcal_100g": 540 } }),
        product("8103", "Milk chocolate", { brands: "Alpha", nutriments: { "energy-kcal_100g": 530 } }),
        product("8104", "Milk chocolate", { brands: "Beta", nutriments: { "energy-kcal_100g": 550 } }),
      ]).reader,
    );
    expect(await names(index, "chocolate")).toEqual(["Milk chocolate", "Milk chocolate", "Probiotic chocolate", "Milk chocolate"]);
  });

  it("counts entries sold in Australia for more", async () => {
    const american = Array.from({ length: 5 }, (_, i) => product(`830${i}`, "Whole milk", { brands: `Maker${i}`, nutriments: { "energy-kcal_100g": 60 + i } }));
    const index = await FoodIndex.open(build([...american, product("8310", "Lite milk", { brands: "Aussie", countries_tags: ["en:australia"], nutriments: { "energy-kcal_100g": 64 } })]).reader);
    expect((await names(index, "milk"))[0]).toBe("Lite milk");
  });

  it("puts food matches before flavour matches, even with no brand listed", async () => {
    const index = await FoodIndex.open(
      build([
        product("8201", "Vegemite pressed pretzels", { nutriments: { "energy-kcal_100g": 439 } }),
        product("8202", "Vegemite", { brands: "Mondelez", nutriments: { "energy-kcal_100g": 191 } }),
        product("8203", "Vegemite", { nutriments: { "energy-kcal_100g": 180 } }),
      ]).reader,
    );
    const rows = await index.summaries(await index.search(parseQuery("vegemite")));
    expect(rows.map((r) => [r[1], r[2]])).toEqual([["Vegemite", "Mondelez"], ["Vegemite", null], ["Vegemite pressed pretzels", null]]);
  });

  it("starts a new word-count range where products with no brand start", async () => {
    // The last branded product and the first with no brand have the same word counts.
    const { files } = build([product("8401", "Vegemite", { brands: "Vegemite" }), product("8402", "Vegemite", { nutriments: { "energy-kcal_100g": 9 } })]);
    const meta = JSON.parse(files.get("meta.json") as string) as { unbrandedFrom: number; bands: [number, number, number][] };
    expect(meta.unbrandedFrom).toBe(1);
    expect(meta.bands.map((b) => b[0])).toEqual([0, 1]);
  });

  it("puts a branded product the query uses up first, and not one with no brand", async () => {
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
    expect(rows.slice(0, 3).map((r) => [r[1], r[2]])).toEqual([["Vegemite", "Vegemite"], ["Vegemite", "Bega"], ["Vegemite", null]]);
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

    const queries = ["vanilla", "vanilla ", "queen", "vanilla queen", "queen vanilla ", "cola bean", "yogurt cream extract", "van", "vanilla qu", "cream co"];
    const loose = ["van que ", "beans", "colas creams ", "yog extracted"];
    for (const [query, isLoose] of [...queries.map((t) => [t, false] as const), ...loose.map((t) => [t, true] as const)]) {
      const q = parseQuery(query, isLoose);
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
    expect(await names(index, "chocolate")).toEqual(["Milk Chocolate", "Dark Chocolate", "Chocolate", "Dark chocolate with almonds"]);
    expect(await names(index, "cadbury")).toEqual(["Dairy Milk"]);
    // Its lists count once against the scan budget too, however many passes read them.
    const budget = newBudget();
    await index.search(parseQuery("chocolate"), 10, budget);
    expect(budget.scanned).toBe(4);
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

  it("offers a serving that is only a weight as the serving, in the food and its search row (DR-31)", async () => {
    const yoghurt = product("1009", "Plain yoghurt", { quantity: "1 kg", product_quantity: 1000, product_quantity_unit: "g", serving_size: "100g", serving_quantity: 100, serving_quantity_unit: "g" });
    const index = await FoodIndex.open(build([yoghurt]).reader);
    const id = await index.findBarcode("1009");
    expect((await index.food(id!)).portions).toEqual([{ name: "serving (100g)", amount: 100, unit: "g" }, { name: "pack (1 kg)", amount: 1000, unit: "g" }]);
    expect(fromSummaryRow((await index.summaries([id!]))[0]!).serving).toMatchObject({ label: "serving (100g)", amount: 100, unit: "g" });
  });

  it("reads per-serving values with a serving that is only a weight", async () => {
    const meal = product("1010", "Takeaway curry", { serving_size: "350 g", serving_quantity: 350, serving_quantity_unit: "g", nutrition_data_per: "serving", nutriments: { "energy-kcal_serving": 700, proteins_serving: 35 } });
    const index = await FoodIndex.open(build([meal]).reader);
    const food = await index.food((await index.findBarcode("1010"))!);
    expect(food.per100).toEqual({ energyKcal: 200, nutrients: { protein: 10 } });
    expect(food.portions).toEqual([{ name: "serving (350 g)", amount: 350, unit: "g" }]);
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

  it("counts a list once against the scan budget, however many passes read it", async () => {
    const index = await FoodIndex.open(build([...FIXTURE, ...MANY]).reader);
    const budget = newBudget();
    expect(await names(index, "snack")).toHaveLength(10);
    await index.search(parseQuery("snack"), 10, budget);
    // Several passes walk this list, but only its first chunk is ever read.
    expect(budget.scanned).toBe(CHUNK_SIZE);
    await index.search(parseQuery("snack"), 10, budget);
    expect(budget.scanned).toBe(CHUNK_SIZE);
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

  it("finds a 3-letter last word through its common expansions, beyond the candidates it would check", async () => {
    const records = [
      // More words starting "mac" than a short prefix expands to.
      ...Array.from({ length: 20 }, (_, i) => product(`61${String(i).padStart(3, "0")}`, `Mac${"abcdefghijklmnopqrst"[i]}x dish`)),
      // More candidates for "big" than get checked, all ranking ahead of the match.
      ...Array.from({ length: 150 }, (_, i) => product(`62${String(i).padStart(3, "0")}`, `Big thing${i}`)),
      product("63000", "Big macaroni cheese bake"),
      product("63001", "Macaroni", { unique_scans_n: 100 }),
      product("63002", "Macaroni", { brands: "Other", unique_scans_n: 100 }),
    ];
    const index = await FoodIndex.open(build(records).reader);
    expect(await names(index, "big mac")).toEqual(["Big macaroni cheese bake"]);
  });

  it("falls back to checking candidates for a rare word beyond the common expansions", async () => {
    // "fla" starts thousands of words here, each on one product, so this one isn't among the commonest.
    const index = await FoodIndex.open(build([...FIXTURE, ...MANY]).reader);
    expect(await names(index, "special fla")).toEqual([`Snack bar flavour${CHUNK_SIZE + 400} special`]);
  });

  it("doesn't let products already found use up the candidates it checks", async () => {
    const records = [
      // 20 words on two products each, so "macz" on one product is clearly not among the commonest expansions.
      ...Array.from({ length: 20 }, (_, i) => product(`640${String(i).padStart(3, "0")}`, `Mac${"abcdefghijklmnopqrst"[i]}x dish`)),
      ...Array.from({ length: 20 }, (_, i) => product(`641${String(i).padStart(3, "0")}`, `Mac${"abcdefghijklmnopqrst"[i]}x side`)),
      // 97 candidates that don't match, then 5 found through the expansions, then the one only checking can find.
      ...Array.from({ length: 97 }, (_, i) => product(`65${String(i).padStart(3, "0")}`, `Big thing${i}`)),
      ...Array.from({ length: 5 }, (_, i) => product(`66${String(i).padStart(3, "0")}`, `Big macaroni v${i}`)),
      product("67000", "Big macz one two"),
    ];
    const index = await FoodIndex.open(build(records).reader);
    expect(await names(index, "big mac")).toContain("Big macz one two");
  });

  it("finds prefixes and variants of every word in a loose search, and nothing else", async () => {
    const index = await FoodIndex.open(
      build([
        product("5001", "Tall Iced Americano", { brands: "Starbucks" }),
        product("5002", "Baked Beans", { brands: "Heinz" }),
        product("5003", "Ice cream", { brands: "Peters" }),
        product("5004", "Rice", { brands: "SunRice" }),
      ]).reader,
    );
    const loose = async (query: string) => (await index.summaries(await index.search(parseQuery(query, true)))).map((r) => r[1]);
    expect(await names(index, "tall ice americano")).toEqual([]);
    expect(await loose("tall ice americano")).toEqual(["Tall Iced Americano"]);
    expect(await loose("talls iced americano ")).toEqual(["Tall Iced Americano"]);
    expect(await loose("bake bean ")).toEqual(["Baked Beans"]);
    expect(await loose("ice")).toEqual(["Ice cream", "Tall Iced Americano"]);
    // Brand words too.
    expect(await loose("starbuck americanos ")).toEqual(["Tall Iced Americano"]);
    expect(await loose("grande ice americano")).toEqual([]);
  });

  it("keeps a loose word itself when longer words starting with it are commoner", async () => {
    // 20 commoner words starting with "tea", each in more products than "tea" itself.
    const longer = Array.from({ length: 20 }, (_, i) => `tea${"abcdefghijklmnopqrst"[i]}x`);
    const records = longer.flatMap((w, i) => [product(`61${i}0`, `${w} one`, { brands: "B" }), product(`61${i}1`, `${w} two`, { brands: "B" })]);
    const index = await FoodIndex.open(build([...records, product("6999", "Tea Mug", { brands: "Cups" })]).reader);
    const hits = await index.summaries(await index.search(parseQuery("tea mugs", true)));
    expect(hits.map((r) => r[1])).toEqual(["Tea Mug"]);
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
    expect(await catalog.get(hits[0]!.summary.ref)).toMatchObject({ name: "Dark Chocolate", brand: "Alpha" });
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
