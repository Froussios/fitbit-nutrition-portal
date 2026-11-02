import type { FoodItem } from "../core/food";
import type { ParsedQuery } from "../core/tokens";
import {
  barcodeVariants,
  chunkPath,
  codePath,
  decodeIds,
  detailPath,
  dictPath,
  fnv1a,
  fromBase64,
  INDEX_FORMAT,
  MAX_EXPANSIONS,
  packPath,
  prefixPath,
  skipPath,
  summaryPath,
  toFoodItem,
  undeltas,
  type DetailRow,
  type DictEntry,
  type IndexMeta,
  type PrefixGroup,
  type SummaryRow,
} from "./index-format";

/**
 * Query engine over the static food index (docs/FOOD_SEARCH.md section 6.2).
 * It fetches only the few small files a query needs: dictionary shards, the
 * head of each word's product list, and the summary files of the hits. Pure
 * TypeScript over an `IndexReader`, so the same code runs in the browser
 * (fetch), in Node (builder tests) or in a Worker.
 */

export interface IndexReader {
  json<T>(path: string): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
}

/** A file the index should have is missing, e.g. a new version was published mid-session. */
export class IndexNotFoundError extends Error {
  override name = "IndexNotFoundError";
}

/** Product IDs decoded by one search before it gives up and returns what it found. */
export const MAX_SCAN = 200_000;
/** Dictionary shards read to expand one prefix. */
const MAX_PREFIX_SHARDS = 3;

const END = Number.POSITIVE_INFINITY;

interface Budget {
  scanned: number;
}

/** A position in a sorted list of product IDs. `current` is END once exhausted. */
interface Cursor {
  readonly size: number;
  current: number;
  /** Moves to the first ID >= target. */
  seek(target: number): Promise<void>;
}

function lowerBound(a: readonly number[], target: number, from = 0): number {
  let lo = from;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A list loaded in one piece (inline, packed or precomputed). */
class ListCursor implements Cursor {
  current = -1;
  private ids?: number[];
  private pos = 0;
  constructor(
    readonly size: number,
    private readonly load: () => Promise<number[]>,
    private readonly budget: Budget,
  ) {}
  async seek(target: number): Promise<void> {
    if (this.current >= target) return;
    if (!this.ids) {
      this.ids = await this.load();
      this.budget.scanned += this.ids.length;
    }
    this.pos = lowerBound(this.ids, target, this.pos);
    this.current = this.pos < this.ids.length ? this.ids[this.pos]! : END;
  }
}

/** A long list stored in chunks; fetches a chunk only when the walk reaches it. */
class ChunkedCursor implements Cursor {
  current = -1;
  private k = -1;
  private ids: number[] = [];
  private pos = 0;
  private firsts?: Promise<number[]>;
  constructor(
    private readonly index: FoodIndex,
    readonly size: number,
    private readonly listId: number,
    private readonly chunks: number,
    private readonly budget: Budget,
  ) {}
  private async load(k: number): Promise<void> {
    this.ids = decodeIds(await this.index.read("bytes", chunkPath(this.listId, k)));
    this.budget.scanned += this.ids.length;
    this.k = k;
    this.pos = 0;
  }
  async seek(target: number): Promise<void> {
    if (this.current >= target) return;
    if (this.k < 0) await this.load(0);
    for (;;) {
      if (this.ids.length > 0 && this.ids[this.ids.length - 1]! >= target) {
        this.pos = lowerBound(this.ids, target, this.pos);
        this.current = this.ids[this.pos]!;
        return;
      }
      if (this.k + 1 >= this.chunks || this.budget.scanned > MAX_SCAN) {
        this.current = END;
        return;
      }
      // Jump straight to the chunk that can hold the target.
      this.firsts ??= this.index.read<number[]>("json", skipPath(this.listId));
      const firsts = await this.firsts;
      await this.load(Math.max(this.k + 1, lowerBound(firsts, target + 1) - 1));
    }
  }
}

/** Products matching any of several words (a prefix's expansions). */
class UnionCursor implements Cursor {
  current = -1;
  readonly size: number;
  constructor(private readonly parts: readonly Cursor[]) {
    this.size = parts.reduce((n, c) => n + c.size, 0);
  }
  async seek(target: number): Promise<void> {
    if (this.current >= target) return;
    await Promise.all(this.parts.map((c) => c.seek(target)));
    this.current = Math.min(...this.parts.map((c) => c.current));
  }
}

const entryCount = (e: DictEntry) => e[1];

export class FoodIndex {
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly reader: IndexReader,
    readonly meta: IndexMeta,
  ) {}

  static async open(reader: IndexReader): Promise<FoodIndex> {
    const meta = await reader.json<IndexMeta>("meta.json");
    if (meta.format !== INDEX_FORMAT) throw new Error(`Food index format ${meta.format} is not supported (expected ${INDEX_FORMAT})`);
    return new FoodIndex(reader, meta);
  }

  /** Reads a file once per session; failed reads are retried next time. */
  read<T>(kind: "json", path: string): Promise<T>;
  read(kind: "bytes", path: string): Promise<Uint8Array>;
  read(kind: "json" | "bytes", path: string): Promise<unknown> {
    let p = this.cache.get(path);
    if (!p) {
      p = kind === "json" ? this.reader.json(path) : this.reader.bytes(path);
      p.catch(() => this.cache.delete(path));
      this.cache.set(path, p);
    }
    return p;
  }

  /** Dictionary shard that holds `word` (or would). */
  private shardOf(word: string): number {
    const starts = this.meta.dict;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= word) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private shard(n: number): Promise<DictEntry[]> {
    return this.read<DictEntry[]>("json", dictPath(n));
  }

  async lookup(word: string): Promise<DictEntry | undefined> {
    const entries = await this.shard(this.shardOf(word));
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const w = entries[mid]![0];
      if (w === word) return entries[mid];
      if (w < word) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  private cursorFor(e: DictEntry, budget: Budget): Cursor {
    if (e.length === 3) return new ListCursor(e[1], async () => undeltas(e[2]), budget);
    const [, count, where, a, b] = e;
    if (where === -1) return new ChunkedCursor(this, count, a, b, budget);
    return new ListCursor(count, async () => decodeIds(await this.read("bytes", packPath(where)), a, a + b), budget);
  }

  /** Dictionary entries for words starting with `prefix`, most common first, at most `max`. */
  private async expansions(prefix: string, max: number): Promise<DictEntry[]> {
    const found: DictEntry[] = [];
    const first = this.shardOf(prefix);
    for (let n = first; n < Math.min(this.meta.dict.length, first + MAX_PREFIX_SHARDS); n++) {
      if (n > first && !this.meta.dict[n]!.startsWith(prefix)) break;
      for (const e of await this.shard(n)) if (e[0].startsWith(prefix)) found.push(e);
    }
    return found.sort((x, y) => entryCount(y) - entryCount(x)).slice(0, max);
  }

  /** A cursor over every product with a word starting with `prefix`, or undefined if there is none. */
  private async prefixCursor(prefix: string, budget: Budget): Promise<Cursor | undefined> {
    const chars = Array.from(prefix);
    if (chars.length <= 3) {
      let group: PrefixGroup;
      try {
        group = await this.read<PrefixGroup>("json", prefixPath(chars.slice(0, 2).join("")));
      } catch (e) {
        if (e instanceof IndexNotFoundError) return undefined; // no word starts with these letters
        throw e;
      }
      const g = group[prefix];
      if (!g) return undefined;
      const [n, top] = g;
      if (n > MAX_EXPANSIONS && top) {
        const ids = decodeIds(fromBase64(top));
        return new ListCursor(ids.length, async () => ids, budget);
      }
    }
    const words = await this.expansions(prefix, MAX_EXPANSIONS);
    if (words.length === 0) return undefined;
    const cursors = words.map((e) => this.cursorFor(e, budget));
    return cursors.length === 1 ? cursors[0] : new UnionCursor(cursors);
  }

  /**
   * IDs of the best `limit` products matching the query, best first. Every
   * word must match; IDs are in ranking order, so the first matches found
   * are the best ones.
   */
  async search(q: ParsedQuery, limit = 10): Promise<number[]> {
    const budget: Budget = { scanned: 0 };
    const entries = await Promise.all(q.words.map((w) => this.lookup(w)));
    if (entries.some((e) => !e)) return [];
    const cursors = entries.map((e) => this.cursorFor(e!, budget));
    if (q.prefix !== undefined) {
      const c = await this.prefixCursor(q.prefix, budget);
      if (!c) return [];
      cursors.push(c);
    }
    if (cursors.length === 0) return [];
    cursors.sort((a, b) => a.size - b.size);

    // Leapfrog intersection: advance every cursor to the largest current ID until all agree.
    const hits: number[] = [];
    let target = 0;
    outer: while (hits.length < limit && budget.scanned <= MAX_SCAN) {
      for (const c of cursors) {
        await c.seek(target);
        if (c.current === END) break outer;
        if (c.current > target) {
          target = c.current;
          continue outer;
        }
      }
      hits.push(target);
      target++;
    }
    return hits;
  }

  async summaries(ids: readonly number[]): Promise<SummaryRow[]> {
    const per = this.meta.sumPerFile;
    const files = await Promise.all(ids.map((id) => this.read<SummaryRow[]>("json", summaryPath(Math.floor(id / per)))));
    return ids.map((id, i) => files[i]![id % per]!);
  }

  async food(id: number): Promise<FoodItem> {
    const [sums, dets] = await Promise.all([
      this.read<SummaryRow[]>("json", summaryPath(Math.floor(id / this.meta.sumPerFile))),
      this.read<DetailRow[]>("json", detailPath(Math.floor(id / this.meta.detPerFile))),
    ]);
    const s = sums[id % this.meta.sumPerFile];
    const d = dets[id % this.meta.detPerFile];
    if (!s || !d) throw new IndexNotFoundError(`Product ${id} is not in the index`);
    return toFoodItem(s, d);
  }

  async findBarcode(code: string): Promise<number | undefined> {
    for (const c of barcodeVariants(code.trim())) {
      const map = await this.read<Record<string, number>>("json", codePath(fnv1a(c) % this.meta.codeBuckets));
      const id = map[c];
      if (id !== undefined) return id;
    }
    return undefined;
  }
}
