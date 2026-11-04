/**
 * Word handling for food search, shared by the index builder and the app so
 * both sides agree on what a "word" is (docs/FOOD_SEARCH.md section 4.1).
 *
 * Matching is on exact words (DR-13): no typo tolerance, every query word must
 * appear in the product's name or brand, in any order, and the last query word
 * may be a prefix while the user is still typing.
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
 * Ranking order (docs/FOOD_SEARCH.md section 4.3): higher coverage first, i.e.
 * fewer words in the name, then more popular. When every query word is in the
 * name this equals ordering by coverage = query words in name / name words.
 */
export function compareRank(
  a: { readonly nameWordCount: number; readonly popularity: number; readonly key: string },
  b: { readonly nameWordCount: number; readonly popularity: number; readonly key: string },
): number {
  return a.nameWordCount - b.nameWordCount || b.popularity - a.popularity || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
