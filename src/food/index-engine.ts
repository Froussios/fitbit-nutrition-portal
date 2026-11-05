import type { FoodItem } from "../core/food";
import { compareMatch, matchRank, productMatches, type ParsedQuery } from "../core/tokens";
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
  LEGACY_INDEX_FORMAT,
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
  type LegacyDictEntry,
  type ListRef,
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
/**
 * A short prefix (2-3 letters) after other words is checked against the candidates' names instead of
 * intersected with its precomputed list, which only holds the best IDs across the whole index. At most
 * this many candidates are checked, in batches.
 */
const MAX_VERIFIED = 100;
const VERIFY_BATCH = 25;

const END = Number.POSITIVE_INFINITY;

/** How much of the product lists one search has read. A list read again by a later pass costs nothing more. */
export interface Budget {
  scanned: number;
  readonly counted: Set<unknown>;
}

export const newBudget = (): Budget => ({ scanned: 0, counted: new Set() });

function countOnce(budget: Budget, list: unknown, ids: number): void {
  if (budget.counted.has(list)) return;
  budget.counted.add(list);
  budget.scanned += ids;
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
    /** Identifies the list across passes. */
    private readonly list: unknown,
  ) {}
  async seek(target: number): Promise<void> {
    if (this.current >= target) return;
    if (!this.ids) {
      this.ids = await this.load();
      countOnce(this.budget, this.list, this.ids.length);
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
    const path = chunkPath(this.listId, k);
    this.ids = decodeIds(await this.index.read("bytes", path));
    countOnce(this.budget, path, this.ids.length);
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

/** One query word: where it is found. */
interface Term {
  /** Products where it says what the food is. */
  readonly head?: Cursor | undefined;
  /** Products with it elsewhere in the name. */
  readonly rest?: Cursor | undefined;
  /** Products with it only in the brand. */
  readonly brand?: Cursor | undefined;
  /** Whether a hit is the whole word, rather than a longer word starting with it. */
  readonly whole: boolean;
}

const either = (cursors: readonly (Cursor | undefined)[]): Cursor | undefined => {
  const present = cursors.filter((c) => c !== undefined);
  return present.length > 1 ? new UnionCursor(present) : present[0];
};

/** The list of each format 2 entry, kept so that it is the same object in every pass (see countOnce). */
const legacyLists = new WeakMap<object, ListRef>();

/** A format 2 entry holds one list, read here as food matches; a format 3 entry holds three. */
function refsOf(e: DictEntry | LegacyDictEntry): readonly [ListRef | null, ListRef | null, ListRef | null] {
  if (typeof e[1] === "number") {
    let list = legacyLists.get(e);
    if (!list) legacyLists.set(e, (list = e.slice(1) as unknown as ListRef));
    return [list, null, null];
  }
  return [e[1] as ListRef | null, e[2] as ListRef | null, e[3] as ListRef | null];
}

const entryCount = (e: DictEntry) => refsOf(e).reduce((n, ref) => n + (ref?.[0] ?? 0), 0);

export class FoodIndex {
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly reader: IndexReader,
    readonly meta: IndexMeta,
  ) {}

  static async open(reader: IndexReader): Promise<FoodIndex> {
    const meta = await reader.json<IndexMeta>("meta.json");
    if (meta.format !== INDEX_FORMAT && meta.format !== LEGACY_INDEX_FORMAT) {
      throw new Error(`Food index format ${meta.format} is not supported (expected ${INDEX_FORMAT})`);
    }
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

  private cursorFor(ref: ListRef, budget: Budget): Cursor {
    if (ref.length === 2) return new ListCursor(ref[0], async () => undeltas(ref[1]), budget, ref);
    const [count, where, a, b] = ref;
    if (where === -1) return new ChunkedCursor(this, count, a, b, budget);
    return new ListCursor(count, async () => decodeIds(await this.read("bytes", packPath(where)), a, a + b), budget, ref);
  }

  private termFor(entries: readonly DictEntry[], whole: boolean, budget: Budget): Term {
    const refs = entries.map(refsOf);
    const cursors = (i: 0 | 1 | 2) => either(refs.map((r) => (r[i] ? this.cursorFor(r[i]!, budget) : undefined)));
    return { head: cursors(0), rest: cursors(1), brand: cursors(2), whole };
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

  /**
   * Where the words starting with `prefix` are found; undefined if there is none; or "verify" when the
   * prefix is short and common and `alone` is false, so candidates found through the other words are
   * checked against the prefix instead.
   */
  private async prefixTerm(prefix: string, budget: Budget, alone: boolean): Promise<Term | "verify" | undefined> {
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
      if (n > MAX_EXPANSIONS) {
        // The precomputed list holds only the best IDs overall, so it rarely meets other words' lists.
        if (!alone) return "verify";
        // It is empty when none of these words is the food in any product name.
        if (top) {
          const ids = decodeIds(fromBase64(top));
          return { head: new ListCursor(ids.length, async () => ids, budget, g), whole: false };
        }
      }
    }
    const words = await this.expansions(prefix, MAX_EXPANSIONS);
    return words.length === 0 ? undefined : this.termFor(words, false, budget);
  }

  /**
   * IDs of the best `limit` products matching the query, best first (ranking:
   * matchRank). Every word must match. The ranking's top levels are each a pass
   * over the product lists, in order, so a search stops as soon as better levels
   * have filled the results.
   */
  async search(q: ParsedQuery, limit = 10, budget: Budget = newBudget()): Promise<number[]> {
    const entries = await Promise.all(q.words.map((w) => this.lookup(w)));
    if (entries.some((e) => !e)) return [];
    const wordTerms = () => entries.map((e) => this.termFor([e!], true, budget));
    const hits: number[] = [];
    const room = () => limit - hits.length;

    // Tier 0: every word whole, in the name or brand, at least one in the name.
    const lastWord = q.prefix === undefined ? undefined : await this.lookup(q.prefix);
    if (q.prefix === undefined || lastWord) {
      const terms = () => [...wordTerms(), ...(lastWord ? [this.termFor([lastWord], true, budget)] : [])];
      hits.push(...(await this.usedUpMatches(terms(), room(), budget)));
      hits.push(...(await this.nameMatches(terms(), "head", room(), hits, budget)));
      hits.push(...(await this.nameMatches(terms(), "name", room(), hits, budget)));
    }

    // Tier 1: the last word only as the start of a longer word.
    if (q.prefix !== undefined && room() > 0) {
      const term = await this.prefixTerm(q.prefix, budget, entries.length === 0);
      if (term === "verify") {
        // A 3-letter word tries its commonest expansions first, which fetches no text, and checks candidates
        // only for what is left. Checking alone costs far more; expansions alone miss rarer words.
        if (Array.from(q.prefix).length === 3) {
          const words = await this.expansions(q.prefix, MAX_EXPANSIONS);
          for (const scope of ["head", "name"] as const) {
            hits.push(...(await this.nameMatches([...wordTerms(), this.termFor(words, false, budget)], scope, room(), hits, budget)));
          }
        }
        hits.push(...(await this.verified(wordTerms(), q.prefix, room(), hits, budget)));
        return this.inRankOrder(hits, q);
      }
      if (!term) return this.inRankOrder(hits, q);
      hits.push(...(await this.nameMatches([...wordTerms(), term], "head", room(), hits, budget)));
      if (room() > 0) {
        const again = await this.prefixTerm(q.prefix, budget, entries.length === 0);
        if (again && again !== "verify") hits.push(...(await this.nameMatches([...wordTerms(), again], "name", room(), hits, budget)));
      }
    }

    // Tier 2: nothing in the name, so every word is in the brand.
    if (room() > 0) {
      const last = q.prefix === undefined ? undefined : await this.prefixTerm(q.prefix, budget, entries.length === 0);
      const brands = [...wordTerms(), ...(last && last !== "verify" ? [last] : [])].map((t) => t.brand);
      if (brands.length > 0 && brands.every((c) => c !== undefined)) {
        for await (const id of this.intersect(brands, budget)) {
          if (hits.includes(id)) continue;
          hits.push(id);
          if (room() === 0) break;
        }
      }
    }
    return this.inRankOrder(hits, q);
  }

  /** The text-based ranking of the chosen products: it also sees brand matches of words that are in the name. */
  private async inRankOrder(ids: readonly number[], q: ParsedQuery): Promise<number[]> {
    const rows = await this.summaries(ids);
    return ids
      .map((id, i) => ({ id, rank: matchRank(q, rows[i]![1], rows[i]![2] ?? undefined) }))
      .sort((a, b) => compareMatch(a.rank, b.rank) || a.id - b.id)
      .map((h) => h.id);
  }

  /**
   * Products with no words beyond the query, wherever their IDs fall: a product holding every term with
   * as many words in total as there are terms has nothing else in its name or brand. The bands say which
   * IDs have that word count, so the walk jumps straight to them.
   */
  private async usedUpMatches(terms: readonly Term[], want: number, budget: Budget): Promise<number[]> {
    const cursors = terms.map((t) => either([t.head, t.rest, t.brand]));
    const bands = this.meta.bands;
    if (!bands || want <= 0 || cursors.length === 0 || cursors.some((c) => !c)) return [];
    const hits: number[] = [];
    for (let b = 0; b < bands.length; b++) {
      if (bands[b]![2] !== terms.length) continue;
      // Only branded products count as used up.
      if (this.meta.unbrandedFrom !== undefined && bands[b]![0] >= this.meta.unbrandedFrom) continue;
      const end = bands[b + 1]?.[0] ?? this.meta.searchableDocs;
      for await (const id of this.intersect(cursors, budget, bands[b]![0], end)) {
        hits.push(id);
        if (hits.length === want) return hits;
      }
    }
    return hits;
  }

  /** Word count of a product's name, from its ID. Undefined in a format 2 index. */
  private wordCount(id: number): number | undefined {
    const bands = this.meta.bands;
    if (!bands) return undefined;
    let lo = 0;
    let hi = bands.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (bands[mid]![0] <= id) lo = mid;
      else hi = mid - 1;
    }
    return bands[lo]![1];
  }

  /**
   * The best `want` products, not in `skip`, with every term in the name or brand and at least one
   * in the name ("name"), or at least one saying what the food is ("head"). Ranks them from their ID
   * and the lists they are in, so nothing else is fetched, and stops when no later product could beat
   * the ones found.
   */
  private async nameMatches(terms: readonly Term[], scope: "head" | "name", want: number, skip: readonly number[], budget: Budget): Promise<number[]> {
    if (want <= 0 || terms.length === 0) return [];
    const inScope = either(terms.flatMap((t) => (scope === "head" ? [t.head] : [t.head, t.rest])));
    if (!inScope) return [];
    const anywhere = terms.map((t) => either([t.head, t.rest, t.brand]));
    if (anywhere.some((c) => !c)) return [];
    // With one term, being in scope already says it all.
    const cursors = terms.length === 1 ? [inScope] : [inScope, ...(anywhere as Cursor[])];
    cursors.sort((a, b) => a.size - b.size);

    const wholeTerms = terms.filter((t) => t.whole).length;
    // The ID where the second group starts, whichever group that is: word counts restart there.
    const secondGroup = this.meta.unbrandedFrom ?? this.meta.brandedFrom ?? 0;
    const best: { id: number; key: readonly number[] }[] = [];
    for await (const id of this.intersect(cursors, budget)) {
      const words = this.wordCount(id);
      if (best.length === want) {
        // Without word counts (format 2), the first matches are the best we can tell.
        if (words === undefined) break;
        const atBest = [Number(id >= secondGroup), Math.max(0, words - wholeTerms), -terms.length, id];
        if (compareMatch(best[want - 1]!.key, atBest) < 0) break;
      }
      if (skip.includes(id)) continue;
      const inName = terms.filter((t) => t.head?.current === id || t.rest?.current === id);
      const key = [Number(id >= secondGroup), Math.max(0, (words ?? 0) - inName.filter((t) => t.whole).length), -inName.length, id];
      const at = best.findIndex((b) => compareMatch(key, b.key) < 0);
      best.splice(at < 0 ? best.length : at, 0, { id, key });
      if (best.length > want) best.pop();
    }
    return best.map((b) => b.id);
  }

  /**
   * For a short, common prefix: candidates from the other words, in ID order, kept if a word in their
   * name or brand starts with the prefix. At most MAX_VERIFIED candidates are checked.
   */
  private async verified(terms: readonly Term[], prefix: string, want: number, skip: readonly number[], budget: Budget): Promise<number[]> {
    const cursors = terms.map((t) => either([t.head, t.rest, t.brand]));
    if (want <= 0 || cursors.length === 0 || cursors.some((c) => !c)) return [];
    cursors.sort((a, b) => a!.size - b!.size);
    const prefixOnly: ParsedQuery = { words: [], prefix };
    const hits: number[] = [];
    let batch: number[] = [];
    let checked = 0;
    const check = async () => {
      const rows = await this.summaries(batch);
      rows.forEach((r, i) => {
        if (hits.length < want && productMatches(prefixOnly, r[1], r[2] ?? undefined)) hits.push(batch[i]!);
      });
      batch = [];
    };
    for await (const id of this.intersect(cursors as Cursor[], budget)) {
      if (skip.includes(id)) continue;
      batch.push(id);
      checked++;
      if (batch.length === VERIFY_BATCH || checked >= MAX_VERIFIED) {
        await check();
        if (hits.length >= want || checked >= MAX_VERIFIED) return hits;
      }
    }
    if (batch.length > 0) await check();
    return hits;
  }

  /** Leapfrog intersection: advances every cursor to the largest current ID until all agree, yielding IDs in ranking order. */
  private async *intersect(cursors: readonly (Cursor | undefined)[], budget: Budget, from = 0, to = END): AsyncGenerator<number> {
    let target = from;
    outer: while (target < to && budget.scanned <= MAX_SCAN) {
      for (const c of cursors) {
        if (!c) return;
        await c.seek(target);
        if (c.current === END) return;
        if (c.current > target) {
          target = c.current;
          continue outer;
        }
      }
      yield target;
      target++;
    }
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
