import { summarise } from "../src/core/food-summary";
import { fromOffProduct, type OffProduct } from "../src/core/off";
import { compareRank, indexWords, nameWords, popularity } from "../src/core/tokens";
import {
  CHUNK_SIZE,
  chunkPath,
  codePath,
  deltas,
  detailPath,
  detailRow,
  dictPath,
  DOCS_PER_FILE,
  encodeIds,
  fnv1a,
  INDEX_FORMAT,
  INLINE_MAX,
  MAX_EXPANSIONS,
  packPath,
  PREFIX_TOP,
  prefixPath,
  skipPath,
  summaryPath,
  summaryRow,
  toBase64,
  type IndexMeta,
  type PrefixGroup,
  type SummaryRow,
} from "../src/food/index-format";

/**
 * Builds the static food index from Open Food Facts product records
 * (docs/FOOD_SEARCH.md sections 5.3 and 7). Pure: it never touches the file
 * system. `add()` takes records one at a time (streamed from the export), and
 * `files()` yields [path, contents] pairs for the caller to write.
 */

/** The fields of an Open Food Facts export record the builder reads, beyond what the normaliser reads. */
export interface RawProduct extends OffProduct {
  product_name_en?: string;
  lang?: string;
  countries_tags?: string[];
  unique_scans_n?: number;
  completeness?: number;
  obsolete?: boolean | string;
  [key: string]: unknown;
}

export interface BuildOptions {
  readonly version: string;
  readonly builtAt?: string;
  readonly source?: IndexMeta["source"];
  /** Target size of a dictionary shard, uncompressed. */
  readonly dictShardBytes?: number;
  /** Target size of a pack of medium product lists. */
  readonly packBytes?: number;
  /** Barcodes per barcode-map file, on average. */
  readonly codesPerBucket?: number;
}

const MAX_NAME = 150;
const MAX_KCAL = 900;

interface Doc {
  readonly code: string;
  readonly sum: SummaryRow;
  /** The detail row, already serialised to save memory. */
  readonly det: string;
  readonly nameWordCount: number;
  readonly popularity: number;
  readonly dedupeKey: string;
  /** Sort key tie-break, for a deterministic order. */
  readonly key: string;
}

export type DropReason = "obsolete" | "noCode" | "noName" | "noEnergy" | "implausibleEnergy" | "noWords" | "duplicateCode";

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export class IndexBuilder {
  private readonly docs: Doc[] = [];
  private readonly seenCodes = new Set<string>();
  readonly counts: Record<string, number> = { read: 0, kept: 0 };

  constructor(private readonly options: BuildOptions) {}

  private bump(key: string): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }

  private drop(reason: DropReason): false {
    this.bump(`dropped.${reason}`);
    return false;
  }

  /** Filters and slims one export record; returns whether it was kept. */
  add(raw: RawProduct): boolean {
    this.bump("read");
    if (raw.obsolete === true || raw.obsolete === "on" || raw.obsolete === "1") return this.drop("obsolete");
    const code = text(raw.code);
    if (!code) return this.drop("noCode");
    const langName = raw.lang ? raw[`product_name_${raw.lang}`] : undefined;
    const name = text(raw.product_name) ?? text(raw.product_name_en) ?? text(langName);
    if (!name) return this.drop("noName");

    let food;
    try {
      food = fromOffProduct({ ...raw, code, product_name: name.slice(0, MAX_NAME) });
    } catch {
      return this.drop("noEnergy");
    }
    const kcal = food.per100.energyKcal;
    if (!(kcal >= 0 && kcal <= MAX_KCAL)) return this.drop("implausibleEnergy");
    const words = indexWords(food.brand ? `${food.name} ${food.brand}` : food.name);
    if (words.length === 0) return this.drop("noWords");
    if (this.seenCodes.has(code)) return this.drop("duplicateCode");
    this.seenCodes.add(code);

    const sum = summaryRow(summarise(food));
    this.docs.push({
      code,
      sum,
      det: JSON.stringify(detailRow(food)),
      nameWordCount: Math.max(1, nameWords(food.name).length),
      popularity: popularity(raw.unique_scans_n, raw.countries_tags?.includes("en:australia") ?? false, raw.completeness),
      dedupeKey: `${[...words].sort().join(" ")}|${Math.round(kcal)}`,
      key: code,
    });
    this.bump("kept");
    return true;
  }

  /** Yields every index file. Call once, after the last `add()`. */
  *files(): Generator<readonly [path: string, contents: string | Uint8Array]> {
    const o = this.options;
    const dictShardBytes = o.dictShardBytes ?? 24_000;
    const packBytes = o.packBytes ?? 16_000;
    const codesPerBucket = o.codesPerBucket ?? 1024;

    // Rank, then collapse duplicates: the best of each group is searchable, the rest only by barcode.
    const ranked = [...this.docs].sort(compareRank);
    this.docs.length = 0;
    const seen = new Set<string>();
    const searchable: Doc[] = [];
    const duplicates: Doc[] = [];
    for (const d of ranked) {
      if (seen.has(d.dedupeKey)) duplicates.push(d);
      else {
        seen.add(d.dedupeKey);
        searchable.push(d);
      }
    }
    seen.clear();
    const docs = [...searchable, ...duplicates];
    this.counts.searchable = searchable.length;
    this.counts.duplicates = duplicates.length;

    // Summary and detail files, in ID order.
    for (let f = 0; f * DOCS_PER_FILE < docs.length; f++) {
      const slice = docs.slice(f * DOCS_PER_FILE, (f + 1) * DOCS_PER_FILE);
      yield [summaryPath(f), JSON.stringify(slice.map((d) => d.sum))];
      yield [detailPath(f), `[${slice.map((d) => d.det).join(",")}]`];
    }

    // Barcode map.
    const codeBuckets = Math.max(1, Math.ceil(docs.length / codesPerBucket));
    const buckets: Record<string, number>[] = Array.from({ length: codeBuckets }, () => ({}));
    docs.forEach((d, id) => (buckets[fnv1a(d.code) % codeBuckets]![d.code] = id));
    for (let b = 0; b < codeBuckets; b++) yield [codePath(b), JSON.stringify(buckets[b])];
    buckets.length = 0;

    // Product lists: built in ID order, so each list is already sorted by rank.
    const lists = new Map<string, number[]>();
    searchable.forEach((d, id) => {
      const [, name, brand] = d.sum;
      for (const w of indexWords(brand ? `${name} ${brand}` : name)) {
        let list = lists.get(w);
        if (!list) lists.set(w, (list = []));
        list.push(id);
      }
    });
    const words = [...lists.keys()].sort();
    this.counts.words = words.length;

    // Dictionary shards, packs of medium lists, chunked long lists.
    const dictStarts: string[] = [];
    let shard: string[] = [];
    let shardBytes = 0;
    let pack: Uint8Array[] = [];
    let packLength = 0;
    let packNo = 0;
    let bigLists = 0;
    const flushShard = function* (): Generator<readonly [string, string]> {
      if (shard.length === 0) return;
      yield [dictPath(dictStarts.length - 1), `[${shard.join(",")}]`];
      shard = [];
      shardBytes = 0;
    };
    const flushPack = function* (): Generator<readonly [string, Uint8Array]> {
      if (packLength === 0) return;
      const out = new Uint8Array(packLength);
      let at = 0;
      for (const p of pack) out.set(p, (at += p.length) - p.length);
      yield [packPath(packNo++), out];
      pack = [];
      packLength = 0;
    };

    for (const w of words) {
      const ids = lists.get(w)!;
      let entry: unknown[];
      if (ids.length <= INLINE_MAX) {
        entry = [w, ids.length, deltas(ids)];
      } else if (ids.length <= CHUNK_SIZE) {
        const bytes = encodeIds(ids);
        entry = [w, ids.length, packNo, packLength, bytes.length];
        pack.push(bytes);
        packLength += bytes.length;
        if (packLength >= packBytes) yield* flushPack();
      } else {
        const listId = bigLists++;
        const firsts: number[] = [];
        for (let k = 0; k * CHUNK_SIZE < ids.length; k++) {
          const chunk = ids.slice(k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
          firsts.push(chunk[0]!);
          yield [chunkPath(listId, k), encodeIds(chunk)];
        }
        yield [skipPath(listId), JSON.stringify(firsts)];
        entry = [w, ids.length, -1, listId, firsts.length];
      }
      const json = JSON.stringify(entry);
      if (shard.length === 0) dictStarts.push(dictStarts.length === 0 ? "" : w);
      shard.push(json);
      shardBytes += json.length + 1;
      if (shardBytes >= dictShardBytes) yield* flushShard();
    }
    yield* flushShard();
    yield* flushPack();
    this.counts.packs = packNo;
    this.counts.longLists = bigLists;
    this.counts.dictShards = dictStarts.length;

    // Prefix groups: for each 2-letter prefix, the counts and best IDs of it and its 3-letter extensions.
    const prefixes = new Map<string, { n: number; top: number[] }>();
    for (const w of words) {
      const chars = Array.from(w);
      if (chars.length < 2) continue;
      const head = lists.get(w)!.slice(0, PREFIX_TOP);
      for (const len of [2, 3]) {
        if (chars.length < len) break;
        const p = chars.slice(0, len).join("");
        let acc = prefixes.get(p);
        if (!acc) prefixes.set(p, (acc = { n: 0, top: [] }));
        acc.n++;
        acc.top = mergeTop(acc.top, head, PREFIX_TOP);
      }
    }
    const groups = new Map<string, Record<string, readonly [number, string?]>>();
    for (const [p, { n, top }] of prefixes) {
      const two = Array.from(p).slice(0, 2).join("");
      let g = groups.get(two);
      if (!g) groups.set(two, (g = {}));
      g[p] = n > MAX_EXPANSIONS ? [n, toBase64(encodeIds(top))] : [n];
    }
    for (const [two, g] of groups) yield [prefixPath(two), JSON.stringify(g satisfies PrefixGroup)];
    this.counts.prefixGroups = groups.size;
    lists.clear();

    const meta: IndexMeta = {
      format: INDEX_FORMAT,
      version: o.version,
      builtAt: o.builtAt ?? new Date().toISOString(),
      source: o.source ?? {},
      counts: { ...this.counts },
      docs: docs.length,
      searchableDocs: searchable.length,
      codeBuckets,
      dict: dictStarts,
      licence:
        "Contains information from Open Food Facts (https://world.openfoodfacts.org), made available under the Open Database License (ODbL) 1.0.",
    };
    yield ["meta.json", JSON.stringify(meta)];
  }
}

/** The `max` smallest IDs of two sorted lists, merged. */
function mergeTop(a: number[], b: readonly number[], max: number): number[] {
  if (a.length >= max && b.length > 0 && b[0]! > a[a.length - 1]!) return a;
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (out.length < max && (i < a.length || j < b.length)) {
    const x = i < a.length ? a[i]! : Infinity;
    const y = j < b.length ? b[j]! : Infinity;
    if (x === y) {
      out.push(x);
      i++;
      j++;
    } else if (x < y) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}
