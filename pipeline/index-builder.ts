import { summarise } from "../src/core/food-summary";
import { fromOffProduct, type OffProduct } from "../src/core/off";
import { compareRank, headWords, indexWords, nameWordCount, popularity, productWordCount, sameNameKey } from "../src/core/tokens";
import {
  CHUNK_SIZE,
  chunkPath,
  codePath,
  deltas,
  detailPath,
  detailRow,
  dictPath,
  encodeIds,
  fnv1a,
  INDEX_FORMAT,
  INLINE_MAX,
  MAX_EXPANSIONS,
  MIN_SUMMARIES_PER_FILE,
  packPath,
  PREFIX_TOP,
  prefixPath,
  skipPath,
  summaryPath,
  summaryRow,
  toBase64,
  type DictEntry,
  type IndexMeta,
  type ListRef,
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
  /** Most files the index may have (Cloudflare Pages' free plan allows 20,000 per site). */
  readonly maxFiles?: number;
}

const MAX_NAME = 150;
/**
 * How much more an entry sold in Australia counts when estimating how popular a food is. Open Food
 * Facts leans American, so plain counts would rank "Whole milk" (350 entries) far above "Full cream
 * milk" (71) for Australian users. Not yet checked against the real data: see docs/FOOD_SEARCH.md section 12.
 * To come from the client's locale instead: #42.
 */
const AUSTRALIA_WEIGHT = 10;
const MAX_KCAL = 900;

interface Doc {
  readonly code: string;
  readonly sum: SummaryRow;
  /** The detail row, already serialised to save memory. */
  readonly det: string;
  readonly branded: boolean;
  readonly nameWordCount: number;
  readonly productWordCount: number;
  /** Filled in once every product has been read. */
  sameNameCount: number;
  readonly nameKey: string;
  readonly soldInAustralia: boolean;
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
    const sortedWords = [...words].sort().join(" ");
    this.docs.push({
      code,
      sum,
      det: JSON.stringify(detailRow(food)),
      branded: Boolean(food.brand),
      nameWordCount: nameWordCount(food.name),
      productWordCount: productWordCount(food.name, food.brand),
      sameNameCount: 0,
      nameKey: sameNameKey(food.name),
      soldInAustralia: raw.countries_tags?.includes("en:australia") ?? false,
      popularity: popularity(raw.unique_scans_n, raw.countries_tags?.includes("en:australia") ?? false, raw.completeness),
      // Unbranded products with the same name can't be told apart in the dropdown, whatever their energy.
      dedupeKey: food.brand ? `${sortedWords}|${Math.round(kcal)}` : sameNameKey(food.name),
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
    const codesPerBucket = o.codesPerBucket ?? 2048;
    const maxFiles = o.maxFiles ?? 19_000;
    let files = 0;

    // How common each exact name is, across all brands: an estimate of how popular the food is.
    const sameName = new Map<string, number>();
    for (const d of this.docs) sameName.set(d.nameKey, (sameName.get(d.nameKey) ?? 0) + (d.soldInAustralia ? AUSTRALIA_WEIGHT : 1));
    for (const d of this.docs) d.sameNameCount = sameName.get(d.nameKey)!;
    sameName.clear();

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

    // What a search needs to rank a product from its ID alone.
    const unbrandedFrom = searchable.findIndex((d) => !d.sum[2]);
    const bands: [number, number, number][] = [];
    searchable.forEach((d, id) => {
      const last = bands[bands.length - 1];
      if (!last || last[1] !== d.nameWordCount || last[2] !== d.productWordCount) bands.push([id, d.nameWordCount, d.productWordCount]);
    });

    // Product lists: built in ID order, so each list is already sorted by rank.
    const headLists = new Map<string, number[]>();
    const restLists = new Map<string, number[]>();
    const brandLists = new Map<string, number[]>();
    const addTo = (lists: Map<string, number[]>, word: string, id: number) => {
      let list = lists.get(word);
      if (!list) lists.set(word, (list = []));
      list.push(id);
    };
    searchable.forEach((d, id) => {
      const [, name, brand] = d.sum;
      const inName = indexWords(name);
      const heads = headWords(name);
      for (const w of inName) addTo(heads.includes(w) ? headLists : restLists, w, id);
      if (brand) for (const w of indexWords(brand)) if (!inName.includes(w)) addTo(brandLists, w, id);
    });
    const words = [...new Set([...headLists.keys(), ...restLists.keys(), ...brandLists.keys()])].sort();
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

    const writeList = function* (ids: readonly number[] | undefined): Generator<readonly [string, string | Uint8Array], ListRef | null> {
      if (!ids) return null;
      if (ids.length <= INLINE_MAX) return [ids.length, deltas(ids)];
      if (ids.length <= CHUNK_SIZE) {
        const bytes = encodeIds(ids);
        const ref: ListRef = [ids.length, packNo, packLength, bytes.length];
        pack.push(bytes);
        packLength += bytes.length;
        if (packLength >= packBytes) yield* flushPack();
        return ref;
      }
      const listId = bigLists++;
      const firsts: number[] = [];
      for (let k = 0; k * CHUNK_SIZE < ids.length; k++) {
        const chunk = ids.slice(k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
        firsts.push(chunk[0]!);
        yield [chunkPath(listId, k), encodeIds(chunk)];
        files++;
      }
      yield [skipPath(listId), JSON.stringify(firsts)];
      files++;
      return [ids.length, -1, listId, firsts.length];
    };

    for (const w of words) {
      const entry: DictEntry = [w, yield* writeList(headLists.get(w)), yield* writeList(restLists.get(w)), yield* writeList(brandLists.get(w))];
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
    // Only products where the word says what the food is get into the best IDs: the others rank lower.
    const prefixes = new Map<string, { n: number; top: number[] }>();
    for (const w of words) {
      const chars = Array.from(w);
      if (chars.length < 2) continue;
      const head = headLists.get(w)?.slice(0, PREFIX_TOP) ?? [];
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
    headLists.clear();
    restLists.clear();
    brandLists.clear();
    files += dictStarts.length + packNo + groups.size;

    // Barcode map.
    const codeBuckets = Math.max(1, Math.ceil(docs.length / codesPerBucket));
    const buckets: Record<string, number>[] = Array.from({ length: codeBuckets }, () => ({}));
    docs.forEach((d, id) => (buckets[fnv1a(d.code) % codeBuckets]![d.code] = id));
    for (let b = 0; b < codeBuckets; b++) yield [codePath(b), JSON.stringify(buckets[b])];
    buckets.length = 0;
    files += codeBuckets;

    // Summary and detail files, in ID order, as small as the file budget allows (details are only
    // fetched when a row is chosen, so they get twice as many products per file).
    const budget = maxFiles - files - 5; // meta.json, LICENSE.txt, current.json, _headers, food-index-owner.json
    let sumPerFile = MIN_SUMMARIES_PER_FILE;
    const fileCount = (per: number) => Math.ceil(docs.length / per) + Math.ceil(docs.length / (2 * per));
    while (fileCount(sumPerFile) > budget) {
      sumPerFile *= 2;
      if (sumPerFile > 16_384) throw new Error(`The index needs more than ${maxFiles} files`);
    }
    const detPerFile = 2 * sumPerFile;
    for (let f = 0; f * sumPerFile < docs.length; f++) {
      yield [summaryPath(f), JSON.stringify(docs.slice(f * sumPerFile, (f + 1) * sumPerFile).map((d) => d.sum))];
    }
    for (let f = 0; f * detPerFile < docs.length; f++) {
      yield [detailPath(f), `[${docs.slice(f * detPerFile, (f + 1) * detPerFile).map((d) => d.det).join(",")}]`];
    }
    files += fileCount(sumPerFile);
    this.counts.sumPerFile = sumPerFile;
    this.counts.files = files + 1;

    const meta: IndexMeta = {
      format: INDEX_FORMAT,
      version: o.version,
      builtAt: o.builtAt ?? new Date().toISOString(),
      source: o.source ?? {},
      counts: { ...this.counts },
      docs: docs.length,
      searchableDocs: searchable.length,
      codeBuckets,
      sumPerFile,
      detPerFile,
      dict: dictStarts,
      unbrandedFrom: unbrandedFrom < 0 ? searchable.length : unbrandedFrom,
      bands,
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
