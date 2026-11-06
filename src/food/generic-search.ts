import { CHUNK_FOR_WORDS, fold, parseQuery, sameNameKey, STOP_WORDS, type ParsedQuery } from "../core/tokens";
import { genericToFoodItem, type GenericRow } from "./generics-format";

/**
 * Searches the generic foods in the browser (docs/FOOD_SEARCH.md section 13).
 * These names put the food first, "Milk, cow, fluid", the opposite of product
 * names, so they get their own rule for which word is the food: the words
 * before the first comma.
 */

/** Australian sources come first; these show only when the Australian ones have too little. */
const FALLBACK_SOURCES: ReadonlySet<string> = new Set(["fndds", "usda"]);
/** Below this many Australian foods where a query word is the food, foods from the fallback sources are shown too. */
export const MIN_PRIMARY_FOODS = 3;

/** Words that describe the plain form of a food, so they don't count against a match, and a name with one wins a tie. */
const PLAIN_WORDS: ReadonlySet<string> = new Set(["raw", "plain", "fresh", "regular", "fat", "fluid", "whole", "natural", "commercial", "cow", "nfs", "unflavoured", "flesh", "lean", "peeled", "unpeeled"].map(singular));

/** Same word whatever the spelling convention. Applied to the query only: nothing is ever joined on these. */
const SYNONYMS: readonly (readonly string[])[] = [
  ["yoghurt", "yogurt"],
  ["prawn", "shrimp"],
  ["capsicum", "bell pepper"],
  ["mince", "ground"],
  ["biscuit", "cookie"],
  ["crisps", "chips"],
  ["eggplant", "aubergine"],
  ["zucchini", "courgette"],
  ["coriander", "cilantro"],
  ["rockmelon", "cantaloupe"],
  ["beetroot", "beet"],
  ["ketchup", "tomato sauce"],
  ["soft drink", "soda"],
  ["lollies", "candy"],
  ["skim", "nonfat"],
  ["full cream", "regular fat", "whole"],
  ["almond milk", "almond beverage"],
  ["soy milk", "soy beverage"],
  ["oat milk", "oat beverage"],
];

/** A simple singular, enough to make "bananas" find "Banana" and "tomatoes" find "Tomato". */
export function singular(word: string): string {
  if (word.length <= 3 || word.endsWith("ss")) return word;
  // "berries" is "berry", but "pies" is "pie".
  if (word.endsWith("ies")) return word.length > 4 ? `${word.slice(0, -3)}y` : word.slice(0, -1);
  if (word.endsWith("oes")) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const wordsOf = (text: string) =>
  (fold(text).match(CHUNK_FOR_WORDS) ?? []).filter((w) => !STOP_WORDS.has(w) && (w.length > 1 || /\d/.test(w))).map(singular);

interface Term {
  readonly word: string;
  /** Still being typed: matches any word starting with it. */
  readonly open: boolean;
}

/** The query as typed, plus the same query in each other spelling convention. */
export function queryVariants(q: ParsedQuery): readonly (readonly Term[])[] {
  const typed: Term[] = [...q.words.map((w) => ({ word: singular(w), open: false })), ...(q.prefix === undefined ? [] : [{ word: singular(q.prefix), open: true }])];
  const variants: Term[][] = [typed];
  const words = typed.map((t) => t.word);
  for (const group of SYNONYMS) {
    for (const from of group) {
      const phrase = from.split(" ").map(singular);
      const at = words.findIndex((_, i) => phrase.every((p, j) => words[i + j] === p));
      if (at < 0) continue;
      for (const to of group) {
        if (to === from) continue;
        const replacement = to.split(" ").map((w) => ({ word: singular(w), open: false }));
        variants.push([...typed.slice(0, at), ...replacement, ...typed.slice(at + phrase.length)]);
      }
    }
  }
  return variants;
}

interface Indexed {
  readonly row: GenericRow;
  readonly words: readonly string[];
  /** The words before the first comma: what the food is. */
  readonly head: ReadonlySet<string>;
  readonly fallback: boolean;
}

function indexRow(row: GenericRow): Indexed {
  const name = row[2];
  return { row, words: wordsOf(name), head: new Set(wordsOf(name.split(/[,(]/)[0] ?? "")), fallback: FALLBACK_SOURCES.has(row[0]) };
}

/** How well a food answers one version of the query; lower is better. Undefined if it doesn't match. */
function rankFood(food: Indexed, terms: readonly Term[]): readonly number[] | undefined {
  let partial = 0;
  let isFood = false;
  for (const t of terms) {
    const whole = food.words.includes(t.word);
    if (!whole && !(t.open && food.words.some((w) => w.startsWith(t.word)))) return undefined;
    if (!whole) partial = 1;
    if (food.head.has(t.word) || (t.open && [...food.head].some((w) => w.startsWith(t.word)))) isFood = true;
  }
  const taken = new Set(terms.map((t) => t.word));
  const other = food.words.filter((w) => !taken.has(w));
  const extras = other.filter((w) => !PLAIN_WORDS.has(w) && !/^\d/.test(w)).length;
  const plain = other.some((w) => PLAIN_WORDS.has(w));
  return [partial, isFood ? 0 : 1, food.fallback ? 1 : 0, extras, plain ? 0 : 1, other.length];
}

const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d) return d;
  }
  return 0;
};

export class GenericIndex {
  private readonly foods: readonly Indexed[];
  private readonly byId = new Map<string, GenericRow>();

  constructor(rows: readonly GenericRow[]) {
    this.foods = rows.map(indexRow);
    for (const r of rows) this.byId.set(`${r[0]}:${r[1].toLowerCase()}`, r);
  }

  /** The best foods for a query. Australian foods first; fallback ones only when few Australian foods are what was asked for. */
  search(query: string | ParsedQuery): GenericRow[] {
    const q = typeof query === "string" ? parseQuery(query) : query;
    const variants = queryVariants(q);
    if (variants[0]!.length === 0) return [];
    const found: { food: Indexed; rank: readonly number[] }[] = [];
    for (const food of this.foods) {
      let best: readonly number[] | undefined;
      for (const terms of variants) {
        const rank = rankFood(food, terms);
        if (rank && (!best || compare(rank, best) < 0)) best = rank;
      }
      if (best) found.push({ food, rank: best });
    }
    const primaryFoods = found.filter((f) => !f.food.fallback && f.rank[1] === 0).length;
    const seen = new Set<string>();
    const out: GenericRow[] = [];
    for (const { food } of found.filter((f) => !f.food.fallback || primaryFoods < MIN_PRIMARY_FOODS).sort((a, b) => compare(a.rank, b.rank))) {
      // A lower-priority source's row with exactly the same name adds nothing to choose between.
      const key = sameNameKey(food.row[2]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(food.row);
    }
    return out;
  }

  /** IDs are matched without case, because a diary entry's ID stores them in lower case. */
  get(source: string, id: string) {
    const row = this.byId.get(`${source}:${id.toLowerCase()}`);
    return row && genericToFoodItem(row);
  }
}
