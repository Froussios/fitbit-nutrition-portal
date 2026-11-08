/**
 * Which of a source's portions are worth offering (DR-28). Sources often list a plain weight or volume as a portion,
 * such as "100 g" or "1 oz", which only repeats a unit the app already has, in another size. Those are dropped. A
 * portion whose name says what it is, such as "1 pie (150 g)" or "1 serving (300 ml)", stays, as does a measure whose
 * size is not what the measure says: "1 cup" of flour weighs 125 g, and "1 oz, dry, yields" 170 g of cooked rice.
 */

import { comparable } from "./amount-text";
import { dimensionOf, unitDef, type Dimension, type Portion } from "./units";

/** Measures that sources write but that the app has no unit for. US fluid ounces, since the sources that use them are American. */
const OTHER_MEASURES: Readonly<Record<string, { readonly dimension: Dimension; readonly toBase: number }>> = {
  "fl oz": { dimension: "volume", toBase: 29.5735295625 },
  cl: { dimension: "volume", toBase: 10 },
  dl: { dimension: "volume", toBase: 100 },
};

/** Sizes in a name are rounded: "1 oz" is often 28 g. */
const TOLERANCE = 0.03;

/** What a few words such as "100 g", "1/2 cup" or "12 fl oz" measure, in grams or millilitres. */
function measureOf(text: string): { dimension: Dimension; amount: number } | undefined {
  const m = /^(?:(\d+)\s*\/\s*(\d+)|(\d+(?:\.\d+)?|\.\d+))\s*([a-z][a-z. ]*)$/i.exec(text.trim());
  if (!m) return undefined;
  const quantity = m[3] !== undefined ? Number(m[3]) : Number(m[1]) / Number(m[2]);
  const key = comparable(m[4]!);
  const def = OTHER_MEASURES[key] ?? unitDef(key);
  return def && quantity > 0 ? { dimension: def.dimension, amount: quantity * def.toBase } : undefined;
}

/**
 * Whether a portion is only a weight or volume the app can already measure: its name is a measure, perhaps with others
 * in brackets ("12 fl oz (355 ml)") or a description after a comma ("1 oz, cooked"), and it is the size that measure says.
 */
export function isRescaledUnit(portion: Portion): boolean {
  const m = /^([^(,]+?)\s*(?:\(([^()]*)\))?\s*(?:,([^\d()]*))?$/.exec(portion.name.trim());
  if (!m) return false;
  const brackets = m[2]?.split(/\s*(?:\bor\b|=|;|,)\s*/).filter(Boolean) ?? [];
  if (!brackets.every((part) => measureOf(part))) return false;
  const measure = measureOf(m[1]!);
  return measure !== undefined && measure.dimension === dimensionOf(portion.unit) && Math.abs(measure.amount / portion.amount - 1) <= TOLERANCE;
}

/** The portions worth offering, in the source's order. */
export function usefulPortions(portions: readonly Portion[]): Portion[] {
  return portions.filter((p) => !isRescaledUnit(p));
}
