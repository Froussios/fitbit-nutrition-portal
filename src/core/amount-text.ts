/**
 * Reads an amount typed as free text, such as "90 g", "1 1/2 cups" or "2 × can" (DR-25).
 *
 * Fixed rules only. Anything these rules cannot read with certainty is refused rather than guessed: the same
 * reasoning as never assuming a density (DR-06).
 */

import { PORTION_PREFIX, selectableUnits, type Measurable } from "./units";

/** What a text says, for one food. A `unit` is a key from UNITS or `portion:<name>`. */
export type AmountReading =
  | { readonly kind: "empty" }
  /** No `unit` means a bare number: the text names no unit. */
  | { readonly kind: "amount"; readonly quantity: number; readonly unit?: string }
  | { readonly kind: "zero"; readonly typing: boolean }
  | { readonly kind: "unreadable"; readonly typing: boolean }
  /** The word is not a unit, or not one of this food's portions. */
  | { readonly kind: "unknown-unit"; readonly quantity: number; readonly word: string; readonly typing: boolean }
  /** A real unit, but this food cannot use it: "cup" on a food with no cup portion and no density. */
  | { readonly kind: "not-for-this-food"; readonly quantity: number; readonly word: string; readonly typing: boolean }
  /** Several of the food's portions fit and they differ, so the user has to say which. */
  | { readonly kind: "ambiguous"; readonly quantity: number; readonly word: string; readonly choices: readonly string[]; readonly typing: boolean };

export const UNIT_ALIASES: Readonly<Record<string, string>> = {
  g: "g", gm: "g", gms: "g", gram: "g", gramme: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilogram: "kg", kilogramme: "kg",
  mg: "mg", mgs: "mg", milligram: "mg", milligramme: "mg",
  oz: "oz", ounce: "oz",
  lb: "lb", lbs: "lb", pound: "lb",
  ml: "ml", mls: "ml", millilitre: "ml", milliliter: "ml",
  l: "l", litre: "l", liter: "l",
  tsp: "tsp", teaspoon: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp",
  cup: "cup",
};

/** Measures whose real size depends on the food, so the food's own portion beats the metric unit: flour's cup is not 250 ml. */
const HOUSEHOLD_UNITS: ReadonlySet<string> = new Set(["tsp", "tbsp", "cup"]);

const VULGAR_FRACTIONS: Readonly<Record<string, number>> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const VULGAR = `[${Object.keys(VULGAR_FRACTIONS).join("")}]`;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const FRACTION_WORDS: Readonly<Record<string, number>> = { half: 1 / 2, quarter: 1 / 4, third: 1 / 3, "three quarters": 3 / 4, "two thirds": 2 / 3 };
const WHOLE_NUMBER = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;
/** "half", "a quarter of a", "two and a half", "1 and three quarters" */
const FRACTION_PHRASE = new RegExp(`^(?:(${WHOLE_NUMBER})\\s+and\\s+)?(?:an?\\s+)?(${Object.keys(FRACTION_WORDS).reverse().join("|")})(\\s+of)?(\\s+an?)?(?=\\s|$)`);
/** Everything a number made of words can start as, to tell "ha" on the way to "half" from nonsense. */
const NUMBER_WORD_STARTS = ["a", "an", "half of", "quarter of", "third of", "a half", "a quarter", "a third", ...Object.keys(FRACTION_WORDS), ...Object.keys(NUMBER_WORDS)];
/** What can follow a whole number on the way to a fraction, such as "and a h" in "two and a half". */
const FRACTION_CONTINUATIONS = ["and a half", "and a quarter", "and a third", "and half", "and three quarters", "and two thirds", "quarters", "thirds"];

interface Leading {
  readonly quantity: number;
  readonly rest: string;
  /** "a" and "half a" count something, so a unit has to follow. */
  readonly needsUnit: boolean;
}

/** Thirds would otherwise fill the field with 0.3333333333333333. */
const roundFraction = (n: number) => Number(n.toFixed(3));

function leadingNumber(text: string): Leading | undefined {
  const number = (quantity: number, length: number, needsUnit = false): Leading => ({ quantity, rest: text.slice(length).trim(), needsUnit });
  let m: RegExpMatchArray | null;

  if ((m = FRACTION_PHRASE.exec(text))) {
    const whole = m[1] === undefined ? 0 : (NUMBER_WORDS[m[1]] ?? Number(m[1]));
    return number(roundFraction(whole + FRACTION_WORDS[m[2]!]!), m[0].length, Boolean(m[3] || m[4]));
  }
  if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)/.exec(text))) return number(roundFraction(Number(m[1]) + Number(m[2]) / Number(m[3])), m[0].length);
  if ((m = /^(\d+)\s*\/\s*(\d+)/.exec(text))) return number(roundFraction(Number(m[1]) / Number(m[2])), m[0].length);
  if ((m = new RegExp(`^(\\d+)\\s*(${VULGAR})`).exec(text))) return number(roundFraction(Number(m[1]) + VULGAR_FRACTIONS[m[2]!]!), m[0].length);
  if ((m = new RegExp(`^${VULGAR}`).exec(text))) return number(roundFraction(VULGAR_FRACTIONS[m[0]]!), m[0].length);
  // A comma only ever separates thousands: "1,5" is refused, because it could be 1.5 or a typo for 15.
  if ((m = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/.exec(text))) return number(Number(m[0].replaceAll(",", "")), m[0].length);
  if ((m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text))) return number(Number(m[0]), m[0].length);

  if ((m = /^[a-z]+(?=\s|$)/.exec(text)) && NUMBER_WORDS[m[0]] !== undefined) return number(NUMBER_WORDS[m[0]]!, m[0].length);
  if ((m = /^an?(?=\s|$)/.exec(text))) return number(1, m[0].length, true);
  return undefined;
}

/** On the way to a number, such as "1/" towards "1/2", "1,0" towards "1,000" or "ha" towards "half". */
function isPartialNumber(text: string): boolean {
  if (/^(?:\.|\d+\s*\/\s*|\d+\s+\d+\s*\/\s*|\d{1,3},\d{0,2})$/.test(text)) return true;
  return /^[a-z ]+$/.test(text) && NUMBER_WORD_STARTS.some((w) => w.startsWith(text));
}

/** One spelling for comparing: "cookies" and "cookie" both end up "cooky". Only ever compared, never shown. */
function singular(word: string): string {
  if (word.length <= 2 || word.endsWith("ss")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ie")) return `${word.slice(0, -2)}y`;
  if (/(?:ch|sh|ss|x|o)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const stripLeadingOne = (text: string) => text.replace(/^1\s+/, "");
export const literal = (text: string) => stripLeadingOne(text.trim().toLowerCase().replace(/\s+/g, " "));
const withoutBrackets = (text: string) => text.replace(/\([^)]*\)/g, " ");

/** Words for comparing a typed unit with a portion's name: "Tablespoons," and "1 tablespoon" are both "tbsp". */
export function comparable(text: string): string {
  return stripLeadingOne(withoutBrackets(text).trim().toLowerCase())
    .replace(/[,.;]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const one = singular(word);
      return UNIT_ALIASES[word] ?? UNIT_ALIASES[one] ?? one;
    })
    .join(" ");
}

const valueOf = (name: string) => PORTION_PREFIX + name;
const portionsOf = (food: Measurable) => food.portions.map((portion) => ({ portion, value: valueOf(portion.name), key: comparable(portion.name), plain: !portion.name.includes("(") }));
type Candidate = ReturnType<typeof portionsOf>[number];

/** The portion these name, unless several fit and they differ. Undefined when none do. */
function pickPortion(candidates: readonly Candidate[]): { value: string } | { choices: readonly string[] } | undefined {
  if (candidates.length === 0) return undefined;
  const plain = candidates.filter((c) => c.plain);
  const remaining = plain.length > 0 ? plain : candidates;
  const [first] = remaining;
  const same = remaining.every((c) => c.portion.amount === first!.portion.amount && c.portion.unit === first!.portion.unit);
  return same ? { value: first!.value } : { choices: remaining.map((c) => c.portion.name) };
}

function isTyping(word: string, food: Measurable): boolean {
  // "1 1" may become "1 1/2", and "1 5" may become "1 5.3 oz container".
  if (/^\d[\d.,/ ]*$/.test(word)) return true;
  const raw = word.trim().toLowerCase();
  if (FRACTION_CONTINUATIONS.some((c) => c.startsWith(raw))) return true;
  const key = comparable(word);
  const startsLonger = (name: string) => (name.length > raw.length && name.startsWith(raw)) || (name.length > key.length && name.startsWith(key));
  return Object.keys(UNIT_ALIASES).some(startsLonger) || food.portions.some((p) => startsLonger(literal(p.name)) || startsLonger(comparable(p.name)));
}

function readUnit(wholeText: string, quantity: number, word: string, food: Measurable, afterTimes: boolean): AmountReading {
  const key = comparable(word);
  const unit = UNIT_ALIASES[key];
  const usable = unit !== undefined && selectableUnits(food).some((u) => u.key === unit);
  const portions = portionsOf(food);

  // A weight or volume means exactly what it says, whatever portions the food has. "× 1 oz" is asking for the portion.
  if (usable && !HOUSEHOLD_UNITS.has(unit) && !afterTimes) return { kind: "amount", quantity, unit };

  const exactName = portions.filter((c) => literal(c.portion.name) === literal(word));
  const found =
    pickPortion(exactName) ??
    pickPortion(portions.filter((c) => c.key === key)) ??
    // "cup" finds "1 cup, diced" when nothing plainer fits.
    pickPortion(portions.filter((c) => comparable(c.portion.name.split(",")[0]!) === key));

  if (found && "value" in found) return { kind: "amount", quantity, unit: found.value };
  if (found) return { kind: "ambiguous", quantity, word, choices: found.choices, typing: isTyping(word, food) };

  // "1/2 cup" or "2 slices" can be the whole name of a portion, as Open Food Facts serving sizes often are.
  const whole = pickPortion(portions.filter((c) => c.key === comparable(wholeText) || literal(c.portion.name) === literal(wholeText)));
  if (whole && "value" in whole) return { kind: "amount", quantity: 1, unit: whole.value };

  if (usable) return { kind: "amount", quantity, unit };
  return { kind: unit === undefined ? "unknown-unit" : "not-for-this-food", quantity, word, typing: isTyping(word, food) };
}

/** Reads the text for this food. The result never depends on what the unit dropdown shows: see `readAmount`. */
export function readAmountText(text: string, food: Measurable): AmountReading {
  const clean = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!clean) return { kind: "empty" };

  const lead = leadingNumber(clean);
  if (!lead) return { kind: "unreadable", typing: isPartialNumber(clean) };
  if (!Number.isFinite(lead.quantity)) return { kind: "unreadable", typing: false };

  const times = /^(?:[×*]\s*|x(?:\s+|(?=\d)|$))/.exec(lead.rest);
  const word = times ? lead.rest.slice(times[0].length) : lead.rest;

  if (!word) {
    if (times || lead.needsUnit) return { kind: "unreadable", typing: true };
    return lead.quantity > 0 ? { kind: "amount", quantity: lead.quantity } : { kind: "zero", typing: true };
  }
  if (!/^[\p{L}\d]/u.test(word)) return { kind: "unreadable", typing: isPartialNumber(clean) };
  if (!(lead.quantity > 0)) return { kind: "zero", typing: false };

  return readUnit(clean, lead.quantity, word, food, Boolean(times));
}

/** The number in a text that also names a unit, so that picking a unit by hand can replace the typed one. */
export function typedQuantity(reading: AmountReading): number | undefined {
  if (reading.kind === "amount" && reading.unit === undefined) return undefined;
  return "quantity" in reading ? reading.quantity : undefined;
}

/** What the amount and unit fields say together. */
export type AmountRead =
  | { readonly state: "ok"; readonly quantity: number; readonly unit: string }
  /** Not finished, or not known yet. Nothing can be logged, but it is too early to call it wrong. */
  | { readonly state: "typing" }
  /** `inUnit` when the Unit field is where to fix it. */
  | { readonly state: "problem"; readonly message: string; readonly inUnit: boolean };

const ENTER_AMOUNT = "Enter an amount greater than 0.";

function problemOf(reading: Exclude<AmountReading, { kind: "amount" }>): { message: string; inUnit: boolean } {
  switch (reading.kind) {
    case "empty":
    case "zero":
      return { message: ENTER_AMOUNT, inUnit: false };
    case "unreadable":
      return { message: "Enter an amount such as 90 g or 1 cup.", inUnit: false };
    case "unknown-unit":
      return { message: `“${reading.word}” is not a unit of this food. Choose a unit.`, inUnit: true };
    case "not-for-this-food":
      return { message: `This food cannot be measured in “${reading.word}”. Choose a unit.`, inUnit: true };
    case "ambiguous":
      return { message: `Which “${reading.word}”? Choose one: ${reading.choices.join("; ")}.`, inUnit: true };
  }
}

export interface ReadOptions {
  /** The text is finished: the user left the field or pressed Enter. */
  readonly settled: boolean;
  /** The food's portions are still loading, so a word may yet turn out to be one. */
  readonly pending?: boolean;
}

/**
 * Reads both fields. A bare number takes the unit showing in `shownUnit` and nothing else: when none is showing, the
 * answer is to ask. A unit must never be decided after the number was typed (DR-25).
 */
export function readAmount(text: string, shownUnit: string, food: Measurable, { settled, pending = false }: ReadOptions): AmountRead {
  const reading = readAmountText(text, food);
  if (reading.kind === "amount") {
    const unit = reading.unit ?? shownUnit;
    if (unit) return { state: "ok", quantity: reading.quantity, unit };
    return { state: "problem", message: "Choose a unit for this amount.", inUnit: true };
  }
  const waiting = pending && (reading.kind === "unknown-unit" || reading.kind === "not-for-this-food" || reading.kind === "ambiguous");
  if (waiting || ("typing" in reading && reading.typing && !settled)) return { state: "typing" };
  return { state: "problem", ...problemOf(reading) };
}

export interface ShownAmount {
  readonly text: string;
  /** "" when no unit is showing. */
  readonly unit: string;
}

/** The fields once the user has finished typing: "90 g" becomes 90 and g. What cannot be read stays as typed. */
export function settledAmount(shown: ShownAmount, food: Measurable): ShownAmount {
  const reading = readAmountText(shown.text, food);
  if (reading.kind !== "amount") return shown;
  return { text: String(reading.quantity), unit: reading.unit ?? shown.unit };
}

/**
 * The fields when a food's units arrive or change. `fill` is what an untouched field starts as for this food.
 * What the user typed stays. A unit it names applies; a bare number keeps only a unit that was already showing.
 */
export function amountForFood(food: Measurable, shown: ShownAmount, typed: boolean, fill: (food: Measurable) => ShownAmount): ShownAmount {
  const offered = (unit: string) => food.portions.some((p) => valueOf(p.name) === unit) || selectableUnits(food).some((u) => u.key === unit);
  if (typed) {
    const reading = readAmountText(shown.text, food);
    const named = reading.kind === "amount" ? reading.unit : undefined;
    return { text: shown.text, unit: named ?? (offered(shown.unit) ? shown.unit : "") };
  }
  return offered(shown.unit) ? shown : fill(food);
}

/** A portion is the natural start ("1 × can"), otherwise 100 of the base unit. */
export function defaultAmount(food: Measurable): ShownAmount {
  const [portion] = food.portions;
  return portion ? { text: "1", unit: valueOf(portion.name) } : { text: "100", unit: food.basis };
}
