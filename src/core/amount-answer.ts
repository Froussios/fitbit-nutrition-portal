/**
 * What an on-device model is told about an amount the rules could not read, and how its answer is checked (DR-26).
 *
 * The model is not trusted to follow instructions. These checks are what stop it guessing:
 * - It is only asked about text with words the rules refused, so a bare number can never reach it.
 * - It is told the typed text and the food's units, and never what the food is.
 * - It has to quote the words it read, and they are checked against the text and against the unit it chose.
 * - Its number only counts if the rules read the quoted words as that same number, and then it is the rules' number that is used.
 * - Every word typed has to be accounted for, so "1-2 cups" cannot become 1 cup.
 */

import { comparable, literal, readAmountText, UNIT_ALIASES } from "./amount-text";
import { PORTION_PREFIX, selectableUnits, type Measurable } from "./units";

/** What the rules could not read and a model might: a mistyped unit, or the words in an unusual order. */
export function worthAsking(text: string, food: Measurable): boolean {
  if (!/\p{L}/u.test(text)) return false;
  const { kind } = readAmountText(text, food);
  return kind === "unknown-unit" || kind === "unreadable";
}

function allowedUnits(food: Measurable): { readonly name: string; readonly value: string }[] {
  return [
    ...selectableUnits(food).map((u) => ({ name: u.key, value: u.key })),
    ...food.portions.map((p) => ({ name: p.name, value: PORTION_PREFIX + p.name })),
  ];
}

export function amountPrompt(text: string, food: Measurable): string {
  return `Allowed units: ${allowedUnits(food).map((u) => u.name).join(", ")}\nText: ${JSON.stringify(text.trim())}`;
}

/** Plain strings and numbers, with "" and 0 for nothing, because browsers may not support every JSON schema feature. */
export function amountSchema(food: Measurable): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      quantity: { type: "number" },
      quantityText: { type: "string" },
      unit: { type: "string", enum: [...allowedUnits(food).map((u) => u.name), ""] },
      unitText: { type: "string" },
    },
    required: ["quantity", "quantityText", "unit", "unitText"],
    additionalProperties: false,
  };
}

/** Sent once per session. It names no food, and shows the model refusing as well as answering. */
export const AMOUNT_INSTRUCTIONS: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[] = [
  {
    role: "system",
    content:
      "You read one typed amount of food into a number and a unit. Use only the typed text. Never use what you know about foods or how they are usually measured. " +
      "quantityText is the words typed for the number, copied exactly, and quantity is its value. " +
      "unitText is the words typed for the unit, copied exactly, and unit is the one allowed unit they mean, allowing for a typing mistake. " +
      'If no unit was typed, or no allowed unit fits, unit is "". If no exact number was typed, quantity is 0 and quantityText is "".',
  },
  { role: "user", content: 'Allowed units: g, kg, cup\nText: "250 grms"' },
  { role: "assistant", content: '{"quantity":250,"quantityText":"250","unit":"g","unitText":"grms"}' },
  { role: "user", content: 'Allowed units: g, 1 can\nText: "cans: two"' },
  { role: "assistant", content: '{"quantity":2,"quantityText":"two","unit":"1 can","unitText":"cans"}' },
  { role: "user", content: 'Allowed units: g, cup\nText: "1 scoop"' },
  { role: "assistant", content: '{"quantity":1,"quantityText":"1","unit":"","unitText":"scoop"}' },
  { role: "user", content: 'Allowed units: g, cup\nText: "some"' },
  { role: "assistant", content: '{"quantity":0,"quantityText":"","unit":"","unitText":""}' },
];

export type AnswerCheck =
  /** No `unit` means the text names none, so the unit field decides, as for any bare number. */
  | { readonly ok: true; readonly quantity: number; readonly unit?: string }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): AnswerCheck => ({ ok: false, reason });
const clean = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Edits to turn one word into the other, where swapping two neighbours counts as one. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * How many edits away a typing mistake is, or Infinity when it is too far to be one: "grms" for "grams", but not "scoop"
 * or "mug" for "cup". The first letter must match, because prefixes change the size: "mlitre" is not "litre", nor "kgram" "gram".
 */
function typoDistance(typed: string, name: string): number {
  if (typed[0] !== name[0]) return Number.POSITIVE_INFINITY;
  const distance = editDistance(typed, name);
  return distance <= Math.floor(Math.max(typed.length, name.length) / 3) ? distance : Number.POSITIVE_INFINITY;
}

/** Every way the chosen unit can be written. */
function namesOf(value: string): string[] {
  if (!value.startsWith(PORTION_PREFIX)) {
    const aliases = Object.entries(UNIT_ALIASES).filter(([, key]) => key === value).map(([alias]) => alias);
    return aliases.flatMap((alias) => [alias, `${alias}s`]);
  }
  const name = value.slice(PORTION_PREFIX.length);
  const full = comparable(name);
  const plain = comparable(name.split(",")[0]!);
  return [literal(name), full, plain, `${full}s`, `${plain}s`];
}

/** The number the rules read in these words alone, if they read one. */
function numberIn(quoted: string): number | undefined {
  // The rules want a unit after "a", because alone it is unfinished, but here the unit was quoted separately.
  if (quoted === "a" || quoted === "an") return 1;
  const read = readAmountText(quoted, { basis: "g", portions: [] });
  return read.kind === "amount" && read.unit === undefined ? read.quantity : undefined;
}

/** Takes the first appearance of `part` out of `text`. Undefined when it is not there. */
function without(text: string, part: string): string | undefined {
  const at = text.indexOf(part);
  return at < 0 ? undefined : `${text.slice(0, at)} ${text.slice(at + part.length)}`;
}

const FILLER_WORDS: ReadonlySet<string> = new Set(["of", "a", "an", "x"]);

/** Decides whether a model's answer can be used. `answer` is whatever the model returned. */
export function checkAnswer(text: string, answer: unknown, food: Measurable): AnswerCheck {
  if (typeof answer !== "object" || answer === null) return refuse("not an object");
  const { quantity, quantityText, unit, unitText } = answer as Record<string, unknown>;
  if (typeof quantity !== "number" || typeof quantityText !== "string" || typeof unit !== "string" || typeof unitText !== "string") return refuse("wrong field types");
  if (!Number.isFinite(quantity) || quantity <= 0) return refuse("no number");

  const typed = clean(text);
  const number = clean(quantityText);
  const unitWords = clean(unitText);

  // The number
  if (!number) return refuse("quoted no number");
  const rest = without(typed, number);
  if (rest === undefined) return refuse("the number's words are not in the text");
  const exact = numberIn(number);
  // Close enough for a model that writes two thirds as 0.67. The rules' number is the one used, never the model's.
  if (exact === undefined || Math.abs(exact - quantity) > 0.005) return refuse("the quoted words are not that number");

  // The unit
  const chosen = allowedUnits(food).find((u) => u.name === unit);
  if (unit && !chosen) return refuse("not an allowed unit");
  if (Boolean(chosen) !== Boolean(unitWords)) return refuse("a unit without its words, or words without a unit");
  const left = unitWords ? without(rest, unitWords) : rest;
  if (left === undefined) return refuse("the unit's words are not in the text");
  if (chosen) {
    const distanceTo = (value: string) => Math.min(...namesOf(value).flatMap((name) => [typoDistance(unitWords, name), typoDistance(comparable(unitWords), name)]));
    const distance = distanceTo(chosen.value);
    if (distance === Number.POSITIVE_INFINITY) return refuse("the words do not look like that unit");
    // "mgl" could be mg or ml, and "cpu" either of two cups: choosing between them is not the model's to do.
    if (allowedUnits(food).some((u) => u.value !== chosen.value && distanceTo(u.value) <= distance)) return refuse("the words look just as much like another unit");
  }

  // Everything else
  const unexplained = left.split(/[^\p{L}\p{N}]+/u).filter((word) => word && !FILLER_WORDS.has(word));
  if (left.match(/\p{N}/u) || unexplained.length > 0) return refuse(`left unexplained: ${unexplained.join(" ") || left.trim()}`);

  return { ok: true, quantity: exact, ...(chosen ? { unit: chosen.value } : {}) };
}
