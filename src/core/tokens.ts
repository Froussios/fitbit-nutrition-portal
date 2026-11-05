/**
 * Word handling for food search, shared by the index builder and the app so
 * both sides agree on what a "word" is (docs/FOOD_SEARCH.md section 4.1).
 *
 * Matching is on exact words (DR-13): no typo tolerance, every query word must
 * appear in the product's name or brand, in any order, and the last query word
 * may be a prefix while the user is still typing. Ordering follows DR-15.
 */

/** Words too common to search on. Mostly English, plus the most frequent ones in Open Food Facts' other big languages. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "and", "with", "of", "the", "in", "on", "for", "an", "or", "to", "from", "by",
  "de", "la", "le", "les", "du", "des", "et", "au", "aux", "en", "un", "une", "avec",
  "und", "mit", "der", "die", "das", "von",
  "con", "del", "los", "las", "di", "al", "il",
]);

/** Lower case with accents removed: "Crème Brûlée" → "creme brulee". */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Chunks separated by anything except letters, digits, hyphens and apostrophes. */
const CHUNK = /[\p{L}\p{N}'’-]+/gu;
/** Joiners inside a chunk: "weet-bix", "mcdonald's". */
const JOINER = /['’-]+/;

function keep(word: string): boolean {
  // Single letters carry no meaning on their own ("s" from "McDonald's"); single digits do ("7 up").
  return word.length > 0 && !STOP_WORDS.has(word) && (word.length > 1 || /\p{N}/u.test(word));
}

/** The words of a product name, in order, as counted for coverage (no joined forms). */
export function nameWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of fold(text).match(CHUNK) ?? []) {
    for (const part of chunk.split(JOINER)) if (keep(part)) out.push(part);
  }
  return out;
}

/**
 * What makes two product names the same name: every word in order, ignoring only
 * case, accents and punctuation. Stop words count: "Milk with chocolate" is not "Milk chocolate".
 */
export function sameNameKey(text: string): string {
  return (fold(text).match(CHUNK) ?? []).join(" ");
}

/**
 * The words a product is indexed under: every word, plus hyphenated and
 * apostrophe words joined ("Weet-Bix" → weet, bix, weetbix). Deduplicated.
 */
export function indexWords(text: string): string[] {
  const out = new Set<string>();
  for (const chunk of fold(text).match(CHUNK) ?? []) {
    const parts = chunk.split(JOINER).filter(Boolean);
    for (const part of parts) if (keep(part)) out.add(part);
    if (parts.length > 1) {
      const joined = parts.join("");
      if (keep(joined)) out.add(joined);
    }
  }
  return [...out];
}

/** Words after a food that only say which part or form of it this is: "Chicken Breast", "Oat Flour". */
const FORM_WORDS: ReadonlySet<string> = new Set([
  "breast", "breasts", "thigh", "thighs", "wing", "wings", "drumstick", "drumsticks", "tender", "tenders", "tenderloin", "tenderloins",
  "fillet", "fillets", "flour", "butter", "bean", "beans", "extract", "essence", "white", "whites", "flake", "flakes", "bran", "slice", "slices",
]);
/** Where the part of a name saying what the food is ends: "Bread sticks with vegemite", "Sardines in sauce", "Coke, large". */
const QUALIFIER = /\b(?:with|in|avec|mit|con|au|aux)\b|[,/(–—]|\s-\s/;
/** A size rather than a word: "455g", "2pk". */
const SIZE = /^\d+(?:g|kg|ml|l|oz|lb|pack|pk|x)?$/;

/**
 * The words of a name that say what the food is, as opposed to its flavour or an
 * ingredient (docs/FOOD_SEARCH.md section 4.3). English puts the food last, so
 * "Dark chocolate" is a chocolate and "Chocolate milk" is a milk; a form word
 * passes this on to the word before it. English word order only, for now.
 */
export function headWords(name: string): string[] {
  const folded = fold(name);
  const end = folded.search(QUALIFIER);
  const chunksOf = (text: string) =>
    (text.match(CHUNK) ?? []).filter((chunk) => {
      const parts = chunk.split(JOINER).filter(Boolean);
      return parts.some(keep) && !SIZE.test(chunk);
    });
  let chunks = end > 0 ? chunksOf(folded.slice(0, end)) : [];
  if (chunks.length === 0) chunks = chunksOf(folded);
  const heads: string[] = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    heads.push(...indexWords(chunks[i]!));
    if (!FORM_WORDS.has(chunks[i]!)) break;
  }
  return heads;
}

export interface ParsedQuery {
  /** Words that must match exactly. */
  readonly words: readonly string[];
  /** The last word while it is still being typed; matches any word that starts with it. */
  readonly prefix?: string;
}

/** Minimum length of a prefix before it is used; shorter last words are ignored until the next letter. */
export const MIN_PREFIX = 2;

/**
 * Splits a query into exact words and a trailing prefix. A trailing space (or
 * punctuation) marks the last word as complete. Hyphenated query words are
 * split, not joined, so "weet-bix" matches "Weet-Bix" and "weet bix".
 */
export function parseQuery(query: string): ParsedQuery {
  const folded = fold(query);
  const parts: string[] = [];
  for (const chunk of folded.match(CHUNK) ?? []) parts.push(...chunk.split(JOINER).filter(Boolean));
  const endsInWord = /[\p{L}\p{N}]$/u.test(folded);
  let prefix: string | undefined;
  if (endsInWord && parts.length > 0) {
    const last = parts.pop()!;
    if (last.length >= MIN_PREFIX) prefix = last;
  }
  const words = [...new Set(parts.filter(keep))];
  // A prefix that is already a complete word in the query adds nothing.
  if (prefix !== undefined && words.includes(prefix)) prefix = undefined;
  return prefix === undefined ? { words } : { words, prefix };
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.words.length === 0 && q.prefix === undefined;
}

/** Does a folded word satisfy the query word or prefix? */
export function wordMatches(word: string, q: ParsedQuery): boolean {
  return q.words.includes(word) || (q.prefix !== undefined && word.startsWith(q.prefix));
}

/** Whether a product (name and brand) satisfies every query word. */
export function productMatches(q: ParsedQuery, name: string, brand?: string): boolean {
  const words = indexWords(brand ? `${name} ${brand}` : name);
  return q.words.every((w) => words.includes(w)) && (q.prefix === undefined || words.some((w) => w.startsWith(q.prefix!)));
}

/** A piece of display text, marked when it matched a query word. */
export interface TextRun {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Splits display text into matched and unmatched runs for highlighting. A
 * hyphenated word is highlighted whole when its joined form matched.
 */
export function highlightRuns(text: string, q: ParsedQuery): TextRun[] {
  const runs: TextRun[] = [];
  const push = (t: string, match: boolean) => {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.match === match) runs[runs.length - 1] = { text: last.text + t, match };
    else runs.push({ text: t, match });
  };
  let pos = 0;
  for (const m of text.matchAll(CHUNK)) {
    push(text.slice(pos, m.index), false);
    const chunk = m[0];
    const parts = fold(chunk).split(JOINER).filter(Boolean);
    const joinedMatch = parts.length > 1 && wordMatches(parts.join(""), q);
    // Walk the original chunk so the highlighted text keeps its case and accents.
    let inner = 0;
    for (const piece of chunk.matchAll(/[\p{L}\p{N}]+/gu)) {
      push(chunk.slice(inner, piece.index), joinedMatch);
      push(piece[0], joinedMatch || wordMatches(fold(piece[0]), q));
      inner = piece.index + piece[0].length;
    }
    push(chunk.slice(inner), false);
    pos = m.index + chunk.length;
  }
  push(text.slice(pos), false);
  return runs;
}

/**
 * Popularity used to break ties between equally good matches: how often Open
 * Food Facts apps scanned the product, a boost for products sold in Australia,
 * and Open Food Facts' completeness score (0..1).
 */
export function popularity(uniqueScans: number | undefined, soldInAustralia: boolean, completeness: number | undefined): number {
  const scans = Number.isFinite(uniqueScans) && uniqueScans! > 0 ? uniqueScans! : 0;
  const complete = Number.isFinite(completeness) ? Math.min(1, Math.max(0, completeness!)) : 0;
  return Math.log10(1 + scans) + (soldInAustralia ? 2 : 0) + complete;
}

/**
 * The words of a name or brand as counted for ranking. A chunk with no searchable words ("O.G.",
 * "b&b", "M&M's", "L'Or") still counts, because it is something the query does not account for.
 * Stop words and the article "a" do not.
 */
function countedWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of fold(text).match(CHUNK) ?? []) {
    const parts = chunk.split(JOINER).filter(keep);
    if (parts.length > 0) out.push(...parts);
    else if (!STOP_WORDS.has(chunk) && chunk !== "a") out.push(chunk);
  }
  return out;
}

/** Words a product name counts as for ranking: each distinct word once, at least 1. */
export function nameWordCount(name: string): number {
  return Math.max(1, new Set(countedWords(name)).size);
}

/** Words a whole product counts as: each distinct word of its name and brand once, at least 1. */
export function productWordCount(name: string, brand?: string): number {
  return Math.max(1, new Set(countedWords(brand ? `${name} ${brand}` : name)).size);
}

/** What the fixed order looks at. */
export interface RankedProduct {
  readonly branded: boolean;
  readonly nameWordCount: number;
  readonly productWordCount: number;
  /** Entries of any brand with this exact name, weighted towards Australia: an estimate of how popular the food is. */
  readonly sameNameCount: number;
  readonly popularity: number;
  readonly key: string;
}

/**
 * The fixed order products are numbered in (docs/FOOD_SEARCH.md section 4.3):
 * unbranded before branded, then fewer words in the name, then fewer words in
 * the name and brand together, then more entries with the same name, then more
 * popular. It does not depend on the query, so the index can store every product
 * list in this order. matchRank() refines it for a particular query.
 */
export function compareRank(
  a: RankedProduct,
  b: RankedProduct,
): number {
  return (
    Number(a.branded) - Number(b.branded) ||
    a.nameWordCount - b.nameWordCount ||
    a.productWordCount - b.productWordCount ||
    b.sameNameCount - a.sameNameCount ||
    b.popularity - a.popularity ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** Words in a name or brand that no query word accounts for. A hyphenated word counts as accounted for if its joined form is. */
function extraWords(text: string, isTerm: (word: string) => boolean): number {
  const extras = new Set<string>();
  for (const chunk of fold(text).match(CHUNK) ?? []) {
    const parts = chunk.split(JOINER).filter(Boolean);
    if (parts.length > 1 && isTerm(parts.join(""))) continue;
    for (const word of countedWords(chunk)) if (!isTerm(word)) extras.add(word);
  }
  return extras.size;
}

/**
 * How well a product answers a query, for comparing with compareMatch; lower
 * is better (docs/FOOD_SEARCH.md section 4.3). In order of importance:
 *
 * 1. Tier. 0: every query word is a whole word in the name or brand, with at
 *    least one in the name. 1: the last word only matches as the start of a
 *    longer word ("coke" in "cokelat"). 2: nothing matched in the name.
 * 2. The query uses up the whole product, name and brand: it holds every query
 *    word and has no other words. There is nothing more to type to reach such a
 *    product, so it must not be pushed down by others: "vegemite" puts
 *    "Vegemite (Vegemite)" before "Vegemite pretzels". A hyphenated word counts as
 *    its parts here, as in the index: "weet bix" uses up "Weet-Bix", "weetbix" does not.
 * 3. A query word is the food, not its flavour or an ingredient (headWords):
 *    "chocolate" puts "Dark chocolate" before "Chocolate milk".
 * 4. Unbranded before branded: without evidence otherwise, assume the generic product.
 * 5. Fewer name words that are not query words.
 * 6. More query words in the name.
 * 7. More query words in the brand as well.
 */
export function matchRank(q: ParsedQuery, name: string, brand?: string): readonly number[] {
  const nameW = indexWords(name);
  const brandW = brand ? indexWords(brand) : [];
  const terms = q.prefix === undefined ? q.words : [...q.words, q.prefix];
  const found = (words: readonly string[], term: string) => words.includes(term) || (term === q.prefix && words.some((w) => w.startsWith(term)));
  const inName = terms.filter((t) => found(nameW, t)).length;
  const wholeInName = terms.some((t) => nameW.includes(t));
  const allWhole = terms.every((t) => nameW.includes(t) || brandW.includes(t));
  const tier = inName === 0 ? 2 : allWhole && wholeInName ? 0 : 1;
  const inBrand = terms.filter((t) => found(brandW, t)).length;
  const extras = extraWords(name, (w) => terms.includes(w));
  const usedUp = tier === 0 && productWordCount(name, brand) === terms.length;
  const heads = headWords(name);
  const isFood = terms.some((t) => found(heads, t));
  return [tier, usedUp ? 0 : 1, isFood ? 0 : 1, brand ? 1 : 0, extras, -inName, -inBrand];
}

/** Orders two matchRank() results, or any number lists of the same shape. */
export function compareMatch(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d) return d;
  }
  return 0;
}
