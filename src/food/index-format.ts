import type { FoodItem } from "../core/food";
import type { FoodSummary } from "../core/food-summary";
import { NUTRIENT_KEYS, type NutrientKey } from "../core/nutrients";
import { isRescaledUnit, usefulPortions } from "../core/portions";
import type { BaseUnit, Portion } from "../core/units";

/**
 * The static food index: file layout and encodings shared by the builder
 * (`pipeline/`) and the query engine that runs in the browser. Layout and
 * reasoning: docs/FOOD_SEARCH.md section 6.1.
 *
 *   current.json                 { version }
 *   <version>/meta.json          IndexMeta (the manifest)
 *   <version>/dict/<n>.json      DictEntry[]: a run of consecutive words in sorted order
 *   <version>/post/<n>.bin       medium product lists, packed in dictionary order
 *   <version>/big/<id>/<k>.bin   chunk k of a long product list; skip.json holds each chunk's first ID
 *   <version>/pfx/<hex>.json     top IDs for 2- and 3-letter prefixes (PrefixGroup)
 *   <version>/sum/<n>.json       SummaryRow[], meta.sumPerFile per file, by product ID
 *   <version>/det/<n>.json       DetailRow[], meta.detPerFile per file, by product ID
 *   <version>/code/<n>.json      barcode → product ID, bucketed by fnv1a(barcode)
 *
 * Product IDs follow the fixed ranking (section 4.3), so every product list is
 * in that order and a search can stop soon after the first matches. Each word
 * has three lists, products where it says what the food is, products with it
 * elsewhere in the name, and products with it only in the brand, so a search can
 * rank matches without fetching their text.
 */

export const INDEX_FORMAT = 3;
/** The previous format, which the engine still reads until the first format 3 index is live. Remove with LegacyDictEntry. */
export const LEGACY_INDEX_FORMAT = 2;
/** Smallest number of products per summary file; the builder raises it to stay under the host's file limit. */
export const MIN_SUMMARIES_PER_FILE = 256;
/** Lists up to this length are stored inline in the dictionary. */
export const INLINE_MAX = 16;
/** Lists longer than this are split into chunks of this size. */
export const CHUNK_SIZE = 4096;
/** Prefix expansions used before falling back to the precomputed prefix lists. */
export const MAX_EXPANSIONS = 16;
/** Precomputed prefix lists keep this many of the best product IDs. */
export const PREFIX_TOP = 200;

export interface IndexMeta {
  readonly format: number;
  readonly version: string;
  readonly builtAt: string;
  readonly source: { readonly url?: string; readonly lastModified?: string };
  readonly counts: Readonly<Record<string, number>>;
  readonly docs: number;
  readonly searchableDocs: number;
  readonly codeBuckets: number;
  /** Products per summary file and per detail file. */
  readonly sumPerFile: number;
  readonly detPerFile: number;
  /** First word of each dictionary shard; shard i holds words >= dict[i] and < dict[i + 1]. */
  readonly dict: readonly string[];
  /** First ID of a product with no brand; lower IDs are branded. Missing in indexes built before that order. */
  readonly unbrandedFrom?: number;
  /** The same boundary in earlier format 3 indexes, where products with no brand came first. Remove with the format 2 code. */
  readonly brandedFrom?: number;
  /** Runs of IDs with the same word counts, as [first ID, words in the name, words in the name and brand], in ID order. Missing in format 2. */
  readonly bands?: readonly (readonly [firstId: number, nameWords: number, productWords: number])[];
  readonly licence: string;
}

/**
 * A sorted list of product IDs. Second element: delta-encoded IDs (inline list),
 * a pack number (medium list, with byte offset and length), or -1 (long list,
 * with its list number and chunk count).
 */
export type ListRef =
  | readonly [count: number, ids: readonly number[]]
  | readonly [count: number, pack: number, offset: number, length: number]
  | readonly [count: number, big: -1, listId: number, chunks: number];

/**
 * One dictionary entry: products where the word says what the food is ("Dark chocolate" for
 * "chocolate"), products with it elsewhere in the name ("Chocolate milk"), and products with it
 * only in the brand.
 */
export type DictEntry = readonly [word: string, head: ListRef | null, rest: ListRef | null, brand: ListRef | null];

/** A format 2 entry: one list of every product with the word in its name or brand. */
export type LegacyDictEntry = readonly [word: string, ...ListRef];

/** For each 2- or 3-letter prefix: how many words start with it, and if more than MAX_EXPANSIONS, its best IDs (base64 varint deltas). */
export type PrefixGroup = Readonly<Record<string, readonly [expansions: number, ids?: string]>>;

/** [code, name, brand, packSize, basis, kcalPer100, servingLabel, servingAmount, servingUnit] */
export type SummaryRow = readonly [string, string, string | null, string | null, BaseUnit, number, string | null, number | null, BaseUnit | null];

/** [nutrients in NUTRIENT_KEYS order, portions as [name, amount, unit], density] */
export type DetailRow = readonly [readonly (number | null)[], readonly (readonly [string, number, BaseUnit])[], number | null];

export const dictPath = (n: number) => `dict/${n}.json`;
export const packPath = (n: number) => `post/${n}.bin`;
export const chunkPath = (list: number, k: number) => `big/${list}/${k}.bin`;
export const skipPath = (list: number) => `big/${list}/skip.json`;
export const prefixPath = (twoLetters: string) => `pfx/${hex(twoLetters)}.json`;
export const summaryPath = (file: number) => `sum/${file}.json`;
export const detailPath = (file: number) => `det/${file}.json`;
export const codePath = (bucket: number) => `code/${bucket}.json`;

/** UTF-8 bytes as hex: a file name that is safe on every host whatever the script. */
export function hex(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32-bit FNV-1a, used to bucket barcodes. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sorted IDs as varint deltas (the first ID is stored as is). */
export function encodeIds(ids: readonly number[]): Uint8Array {
  const out: number[] = [];
  let prev = 0;
  for (const id of ids) {
    let v = id - prev;
    prev = id;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  }
  return Uint8Array.from(out);
}

export function decodeIds(bytes: Uint8Array, start = 0, end = bytes.length): number[] {
  const ids: number[] = [];
  let prev = 0;
  let i = start;
  while (i < end) {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[i++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    prev += v;
    ids.push(prev);
  }
  return ids;
}

export function deltas(ids: readonly number[]): number[] {
  return ids.map((id, i) => (i === 0 ? id : id - ids[i - 1]!));
}

export function undeltas(d: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const v of d) out.push((prev += v));
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function summaryRow(s: FoodSummary): SummaryRow {
  return [
    s.ref.id,
    s.name,
    s.brand ?? null,
    s.packSize ?? null,
    s.basis,
    round(s.kcalPer100),
    s.serving && s.serving.unit === s.basis ? s.serving.label : null,
    s.serving && s.serving.unit === s.basis ? round(s.serving.amount) : null,
    s.serving && s.serving.unit === s.basis ? s.serving.unit : null,
  ];
}

export function fromSummaryRow(r: SummaryRow): FoodSummary {
  const [code, name, brand, packSize, basis, kcal, servingLabel, servingAmount, servingUnit] = r;
  return {
    ref: { source: "off", id: code },
    name,
    ...(brand ? { brand } : {}),
    ...(packSize ? { packSize } : {}),
    basis,
    kcalPer100: kcal,
    // The builder only stores servings in the food's own basis (no density in Open Food Facts). Older indexes also
    // stored servings that are only a weight, such as "100 g" (DR-28).
    ...(servingLabel && servingAmount && servingUnit === basis && !isRescaledUnit({ name: servingLabel, amount: servingAmount, unit: servingUnit })
      ? { serving: { label: servingLabel, amount: servingAmount, unit: servingUnit, kcal: (kcal * servingAmount) / 100 } }
      : {}),
  };
}

export function detailRow(f: FoodItem): DetailRow {
  const nutrients = NUTRIENT_KEYS.map((k) => {
    const v = f.per100.nutrients[k];
    return v === undefined ? null : round(v);
  });
  while (nutrients.length > 0 && nutrients[nutrients.length - 1] === null) nutrients.pop();
  return [nutrients, f.portions.map((p) => [p.name, round(p.amount), p.unit] as const), f.densityGPerMl ?? null];
}

/** Rebuilds the full food from its summary and detail rows. */
export function toFoodItem(s: SummaryRow, d: DetailRow): FoodItem {
  const [code, name, brand, packSize, basis, kcal] = s;
  const [values, portions, density] = d;
  const nutrients: Partial<Record<NutrientKey, number>> = {};
  NUTRIENT_KEYS.forEach((k, i) => {
    const v = values[i];
    if (v !== null && v !== undefined) nutrients[k] = v;
  });
  return {
    ref: { source: "off", id: code },
    name,
    ...(brand ? { brand } : {}),
    ...(packSize ? { packSize } : {}),
    basis,
    per100: { energyKcal: kcal, nutrients },
    // Indexes built before DR-28 still list plain weights as portions.
    portions: usefulPortions(portions.map(([n, amount, unit]): Portion => ({ name: n, amount, unit }))),
    ...(density ? { densityGPerMl: density } : {}),
  };
}

/** Barcode forms to try: Open Food Facts stores some products as UPC-A (12 digits), some as EAN-13 with a leading 0. */
export function barcodeVariants(code: string): string[] {
  const out = [code];
  if (/^\d{12}$/.test(code)) out.push(`0${code}`);
  if (/^0\d{12}$/.test(code)) out.push(code.slice(1));
  return out;
}

export const isBarcode = (text: string) => /^(\d{8}|\d{12,14})$/.test(text.trim());
