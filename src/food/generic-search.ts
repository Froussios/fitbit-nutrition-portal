import { sourceCountry } from "../core/countries";
import { CHUNK_FOR_WORDS, fold, looseForms, parseQuery, sameNameKey, STOP_WORDS, type ParsedQuery } from "../core/tokens";
import { genericToFoodItem, type GenericRow } from "./generics-format";

/**
 * Searches the generic foods in the browser (docs/FOOD_SEARCH.md section 13).
 * These names say what the food is before the first comma and how it is
 * prepared after it: "Milk, cow, fluid". Before the comma, English puts the
 * food last, as in product names: "Peanut butter" is a butter (DR-34).
 */

/**
 * Class words that a name can put before the food itself: AFCD writes peanuts as "Nut, peanut" and chia as
 * "Seed, chia", where FNDDS writes "Peanuts". Only classes where the word after the comma names the food on
 * its own: in "Oil, peanut" or "Bread, banana" it names what the food is made from, so those are not here.
 */
const KIND_CLASSES: ReadonlySet<string> = new Set(["nut", "seed", "melon"]);

/**
 * Words ending in "ie" whose plural keeps it: "cookies" is "cookie", not "cooky". The ones in the generic food
 * names; "pattie" is left out, so that "patties" still finds the "Patty" rows.
 */
const IE_WORDS: ReadonlySet<string> = new Set(["brie", "brownie", "calorie", "cookie", "hoagie", "movie", "rotisserie", "smoothie", "veggie"]);

/** Plurals that name another food than their singular: potato "crisps" are a snack, an apple "crisp" a dessert. */
const OWN_PLURALS: ReadonlySet<string> = new Set(["crisps"]);

/** A simple singular, enough to make "bananas" find "Banana" and "tomatoes" find "Tomato". */
export function singular(word: string): string {
  if (word.length <= 3 || word.endsWith("ss") || OWN_PLURALS.has(word)) return word;
  // "berries" is "berry", but "pies" is "pie" and "cookies" is "cookie".
  if (word.endsWith("ies")) return word.length > 4 && !IE_WORDS.has(word.slice(0, -1)) ? `${word.slice(0, -3)}y` : word.slice(0, -1);
  if (word.endsWith("oes")) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * Words after a food that only say which part or form of it this is, so the word before them is the food:
 * "Chicken breast", "Egg white", "Cocoa powder", "Margarine spread". Not "butter" or "oil": peanut butter is not peanuts.
 */
const FORM_WORDS: ReadonlySet<string> = new Set(["breast", "thigh", "drumstick", "wing", "leg", "fillet", "white", "yolk", "powder", "extract", "essence", "spread"]);

/** Words that describe the plain form of a food, so they don't count against a match, and a name with one wins a tie. */
const PLAIN_WORDS: ReadonlySet<string> = new Set(["raw", "plain", "fresh", "regular", "fat", "fluid", "whole", "natural", "commercial", "cow", "nfs", "unflavoured", "flesh", "lean", "peeled", "unpeeled"].map(singular));
/** Words a match need not account for: plain words and numbers ("~3.5%"). */
const isMinor = (w: string) => PLAIN_WORDS.has(w) || /^\d/.test(w);

/**
 * Same food whatever the spelling or regional name. Applied to the query only: nothing is ever joined on these.
 * A pair belongs here only if the words name the same food in every source's region (DR-32), so not
 * biscuit/cookie: an Australian biscuit is also a cracker.
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ["yoghurt", "yogurt"],
  ["prawn", "shrimp"],
  ["capsicum", "bell pepper"],
  ["mince", "ground"],
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

const wordsOf = (text: string) =>
  (fold(text).match(CHUNK_FOR_WORDS) ?? []).filter((w) => !STOP_WORDS.has(w) && (w.length > 1 || /\d/.test(w))).map(singular);

interface Term {
  readonly word: string;
  /** Still being typed, or a loose search: matches any word starting with it. */
  readonly open: boolean;
  /** In a loose search, other words it matches whole: its variants without an ending (DR-30). */
  readonly forms?: readonly string[];
}

function termOf(word: string, open: boolean, loose: boolean): Term {
  if (!loose) return { word: singular(word), open };
  const forms = [...new Set([word, ...looseForms(word)].map(singular))];
  return { word: singular(word), open: true, forms };
}

/** Whether a food's word satisfies a term: whole, as its start while open, or as one of its variants. */
const termMatches = (t: Term, w: string) => w === t.word || (t.open && w.startsWith(t.word)) || (t.forms?.includes(w) ?? false);

/** The query as typed, plus the same query in each other spelling convention. */
export function queryVariants(q: ParsedQuery): readonly (readonly Term[])[] {
  const loose = Boolean(q.loose);
  const typed: Term[] = [...q.words.map((w) => termOf(w, false, loose)), ...(q.prefix === undefined ? [] : [termOf(q.prefix, true, loose)])];
  const variants: Term[][] = [typed];
  const words = typed.map((t) => t.word);
  for (const group of SYNONYMS) {
    for (const from of group) {
      const phrase = from.split(" ").map(singular);
      const at = words.findIndex((_, i) => phrase.every((p, j) => words[i + j] === p));
      if (at < 0) continue;
      for (const to of group) {
        if (to === from) continue;
        const replacement = to.split(" ").map((w) => termOf(w, false, loose));
        variants.push([...typed.slice(0, at), ...replacement, ...typed.slice(at + phrase.length)]);
      }
    }
  }
  return variants;
}

interface Indexed {
  readonly row: GenericRow;
  readonly words: readonly string[];
  /**
   * What the food is, from the words before the first comma: the words of each name it goes by. "Potato crisps
   * or chips" is [potato, crisps] or [potato, chips], "Nut, peanut" is [nut] or [peanut].
   */
  readonly head: readonly (readonly string[])[];
  /** The words that say what the food is: "butter" in "Peanut butter", both in "Steak & onions". */
  readonly nouns: readonly string[];
  /** The other words: how the food is prepared, or which variety it is. */
  readonly rest: readonly string[];
  /** From a source outside the user's country, when another source is from it (DR-35). */
  readonly overseas: boolean;
  /**
   * Its words apart from plain words and numbers, in order, before and after the first comma: two sources' rows
   * with the same key are the same food. The comma counts: "Chocolate, milk" is a bar, "Chocolate milk" a drink.
   */
  readonly key: string;
}

/** What each source's names start with ("Honey", "Pumpkin" from "Pumpkin, butternut, raw"), to tell "Nut, peanut" from "Seed, pumpkin". */
type HeadsBySource = ReadonlyMap<string, ReadonlySet<string>>;

/** Where a name's head ends and its qualifiers begin: "Milk, cow", "Bread (pita)". */
const SEGMENT = /[,(]/;
/** Where the food's own name ends inside the head: "Spaghetti in tomato & cheese sauce", "Pasta with tomato-based sauce". */
const QUALIFIED = /\s(?:with|in|on|from|for)\s/i;
/** Between alternatives, either of which the food is: "Potato crisps or chips", "Hot chocolate / cocoa". */
const ALTERNATIVE = /\sor\s|\//i;
/** Between foods that are both in it: "Braised steak & onions", "Macaroni and cheese". */
const BOTH = /\s(?:and|&)\s/i;

/** The words of a food's name that say what it is: the last, and the one before a form word ("Cocoa powder"). */
function nounsOf(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    out.push(words[i]!);
    if (!FORM_WORDS.has(words[i]!)) break;
  }
  return out;
}

/**
 * Joined names share their other words: "Ham or pork salad" is a ham salad or a pork salad, and "Potato crisps or
 * chips" potato crisps or potato chips.
 */
function distribute(names: readonly (readonly string[])[]): (readonly string[])[] {
  const first = names[0]!;
  const last = names[names.length - 1]!;
  return names.map((n, i) => {
    if (n.length !== 1) return n;
    if (i < names.length - 1 && last.length > 1) return [n[0]!, ...last.slice(1)];
    if (i > 0 && first.length > 1) return [...first.slice(0, -1), n[0]!];
    return n;
  });
}

/** Splits text on a joining word and gives the words of each part, leaving out empty ones. */
const partsOf = (text: string, joiner: RegExp) => text.split(joiner).map(wordsOf).filter((p) => p.length > 0);

const firstSegment = (name: string) => wordsOf(name.split(SEGMENT)[0] ?? "");

function indexRow(row: GenericRow, heads: HeadsBySource, overseas: boolean): Indexed {
  const name = row[2];
  const [headText = "", ...after] = name.split(SEGMENT);
  const words = wordsOf(name);
  const keyOf = (text: string) => wordsOf(text).filter((w) => !isMinor(w)).join(" ");
  const key = `${keyOf(headText)}|${keyOf(after.join(","))}`;
  const base = { row, words, overseas, key };
  const first = wordsOf(headText);
  const second = wordsOf(after[0] ?? "");
  // "Nut, peanut" is a nut and a peanut, unless the source also has a food named by that word alone: AFCD's
  // "Seed, pumpkin" is not a pumpkin, because AFCD has "Pumpkin, butternut, raw", and "Melon, honey dew" is not honey.
  const own = heads.get(row[0]);
  if (first.length === 1 && KIND_CLASSES.has(first[0]!) && second.length > 0 && !second.some((w) => own?.has(w))) {
    // Searching "nuts", the kind says which nut it is, as a variety does: "Apple, fuji".
    return { ...base, head: [first, second], nouns: [...first, ...nounsOf(second)], rest: after.flatMap(wordsOf) };
  }
  const cut = headText.search(QUALIFIED);
  const food = cut > 0 ? headText.slice(0, cut) : headText;
  const alternatives = food.split(ALTERNATIVE).filter((alt) => wordsOf(alt).length > 0);
  const names = distribute(alternatives.map(wordsOf));
  // An alternative can hold several foods, all in it: "Steak & vegetables", "Macaroni and cheese".
  const foods = alternatives.flatMap((alt, i) => {
    const parts = distribute(partsOf(alt, BOTH));
    return parts.length > 1 ? parts : [names[i]!];
  });
  return {
    ...base,
    head: names.length > 0 ? names : [first],
    nouns: foods.flatMap(nounsOf),
    rest: [...(cut > 0 ? wordsOf(headText.slice(cut)) : []), ...after.flatMap(wordsOf)],
  };
}

const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d) return d;
  }
  return 0;
};

/**
 * How well a food answers one version of the query; lower is better. Undefined if it doesn't match. In order:
 *
 * 1. What the food is: a query word is the noun that names it (English puts it last, so "Peanut butter" is a
 *    butter and "Potato crisps" are crisps), then a word that modifies it (the peanut of "Peanut butter"),
 *    then neither ("Bread, banana" is a bread).
 * 2. Every query word is whole, rather than the start of a longer word: "Coke" before "Cokelat". A half-typed
 *    word that names the food still comes before a whole word that only modifies it: "tom" finds tomatoes
 *    before a Tom Collins.
 * 3. The user's country before overseas (DR-35). This only chooses between foods that are equally what was asked for: it can't
 *    put "Peanut butter" above "Peanuts" for "peanuts", but it can put potato crisps above apple crisp.
 * 4. The query's own noun, its last word, is the food's: "chocolate milk" finds the milk drink before the bar
 *    "Chocolate, milk". Only after region: AFCD often names the cut after the comma ("Pork, loin chop"), so as the
 *    first rule it would put US names above every Australian one.
 * 5. The fewest words of the food's name that the query leaves unsaid: "Peanuts" before "Peanuts, honey roasted".
 *    Words before the first comma first, because they say what the food is ("Banana chip"), the others only
 *    how it is prepared ("Banana, lady finger, peeled").
 * 6. The plain form, then the shortest name.
 */
function rankFood(food: Indexed, terms: readonly Term[]): readonly number[] | undefined {
  const roleOf = (w: string) => (food.nouns.includes(w) ? 0 : food.head.some((alt) => alt.includes(w)) ? 1 : 2);
  // Each query word counts by the best word it matched, so "pot" is half of "Potato", not the "pot" of "pot roast".
  // The query's own noun: its last word, and the one before a form word ("chicken breast").
  const nounTerms = new Set<Term>();
  for (let i = terms.length - 1; i >= 0; i--) {
    nounTerms.add(terms[i]!);
    if (!FORM_WORDS.has(terms[i]!.word)) break;
  }
  let role = 2;
  let nounRole = 2;
  let partial = 0;
  for (const t of terms) {
    let best: readonly [number, number] | undefined;
    for (const w of food.words) {
      if (!termMatches(t, w)) continue;
      const m = [roleOf(w), w === t.word ? 0 : 1] as const;
      if (!best || compare(m, best) < 0) best = m;
    }
    if (!best) return undefined;
    role = Math.min(role, best[0]);
    if (nounTerms.has(t)) nounRole = Math.min(nounRole, best[0]);
    partial = Math.max(partial, best[1]);
  }
  const said = (w: string) => terms.some((t) => termMatches(t, w));
  // A loose term accounts for the words it matched ("iced" for "ice"); otherwise only whole words count.
  const taken = (w: string) => terms.some((t) => w === t.word || (t.forms !== undefined && termMatches(t, w)));
  const unsaid = (w: string) => !taken(w) && !isMinor(w);
  // A food is judged by the name of it that the query says most of: "peanut" says all of "Nut, peanut".
  const named = food.head.filter((alt) => alt.some(said));
  const headExtras = Math.min(...(named.length > 0 ? named : food.head).map((alt) => new Set(alt.filter(unsaid)).size));
  const restExtras = food.rest.filter(unsaid).length;
  const other = food.words.filter((w) => !taken(w));
  const plain = other.some((w) => PLAIN_WORDS.has(w));
  return [role, partial, food.overseas ? 1 : 0, nounRole, headExtras, restExtras, plain ? 0 : 1, other.length];
}

export class GenericIndex {
  private readonly foods: readonly Indexed[];
  private readonly byId = new Map<string, GenericRow>();

  /**
   * @param home the user's country (`userCountry()`, DR-35). Region only breaks ties between foods that answer the
   * query equally well (DR-34): foods from sources outside it come after, and a copy of one of its foods is left out.
   * When no source is from it, or it is unknown, every source counts the same.
   */
  constructor(rows: readonly GenericRow[], home?: string) {
    const fromHome = (r: GenericRow) => home !== undefined && sourceCountry(r[0]) === home;
    const anyFromHome = rows.some(fromHome);
    const heads = new Map<string, Set<string>>();
    for (const r of rows) {
      const first = firstSegment(r[2]).join(" ");
      if (!heads.has(r[0])) heads.set(r[0], new Set());
      heads.get(r[0])!.add(first);
    }
    this.foods = rows.map((r) => indexRow(r, heads, anyFromHome && !fromHome(r)));
    for (const r of rows) this.byId.set(`${r[0]}:${r[1].toLowerCase()}`, r);
  }

  /** The best foods for a query, the user's country's first among equally good matches (rankFood). */
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
    // An overseas food is left out when one from the user's country that matched has the same words on each side
    // of the first comma, apart from plain words and numbers: for an Australian user, "Milk, whole" adds nothing to
    // "Milk, cow, fluid, regular fat (~3.5%)". Its values are never merged into the other food's.
    const local = new Set(found.filter((f) => !f.food.overseas).map((f) => f.food.key));
    const seen = new Set<string>();
    const out: GenericRow[] = [];
    for (const { food } of found.sort((a, b) => compare(a.rank, b.rank))) {
      if (food.overseas && local.has(food.key)) continue;
      // A lower-priority row with exactly the same name adds nothing to choose between.
      const name = sameNameKey(food.row[2]);
      if (seen.has(name)) continue;
      seen.add(name);
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
