/**
 * Unit model (see docs/ARCHITECTURE.md, "Units of measurement").
 *
 * Every food has a base unit: nutrients are stored per 100 g or per 100 ml.
 * Amounts convert freely within one dimension (mass or volume). Converting
 * between mass and volume requires an explicit density from the source or the
 * user: we never assume 1 ml = 1 g.
 */

export type Dimension = "mass" | "volume";
export type BaseUnit = "g" | "ml";

export interface UnitDef {
  readonly key: string;
  readonly label: string;
  readonly dimension: Dimension;
  /** Multiply an amount in this unit by `toBase` to get grams (mass) or millilitres (volume). */
  readonly toBase: number;
}

/** Units are metric (Australian) where a household measure differs by country. */
export const UNITS: readonly UnitDef[] = [
  { key: "g", label: "g", dimension: "mass", toBase: 1 },
  { key: "kg", label: "kg", dimension: "mass", toBase: 1000 },
  { key: "mg", label: "mg", dimension: "mass", toBase: 0.001 },
  { key: "oz", label: "oz", dimension: "mass", toBase: 28.349523125 },
  { key: "lb", label: "lb", dimension: "mass", toBase: 453.59237 },
  { key: "ml", label: "ml", dimension: "volume", toBase: 1 },
  { key: "l", label: "L", dimension: "volume", toBase: 1000 },
  { key: "tsp", label: "tsp (5 ml)", dimension: "volume", toBase: 5 },
  { key: "tbsp", label: "tbsp (20 ml, AU)", dimension: "volume", toBase: 20 },
  { key: "cup", label: "cup (250 ml, metric)", dimension: "volume", toBase: 250 },
];

const UNIT_BY_KEY = new Map(UNITS.map((u) => [u.key, u]));

export function unitDef(key: string): UnitDef | undefined {
  return UNIT_BY_KEY.get(key);
}

export function dimensionOf(base: BaseUnit): Dimension {
  return base === "g" ? "mass" : "volume";
}

/** A named portion expressed in a base unit, e.g. "1 can" = 375 ml. */
export interface Portion {
  readonly name: string;
  readonly amount: number;
  readonly unit: BaseUnit;
}

/** The subset of a food that unit conversion needs. */
export interface Measurable {
  readonly basis: BaseUnit;
  readonly portions: readonly Portion[];
  /** Grams per millilitre, only when the source (or the user) supplies it. */
  readonly densityGPerMl?: number;
  /** Only the named portions measure it: no weights, volumes or household measures. */
  readonly portionsOnly?: boolean;
}

export class UnitConversionError extends Error {
  override name = "UnitConversionError";
}

/** Prefix that marks a unit selection as a named portion rather than a unit key. */
export const PORTION_PREFIX = "portion:";

/**
 * Converts `quantity` of `unit` into the food's base unit.
 * `unit` is a key from UNITS, or `portion:<name>` for one of the food's portions.
 */
export function toBaseAmount(food: Measurable, quantity: number, unit: string): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new UnitConversionError(`Invalid quantity: ${quantity}`);
  }

  let amount: number;
  let from: Dimension;
  if (unit.startsWith(PORTION_PREFIX)) {
    const name = unit.slice(PORTION_PREFIX.length);
    const portion = food.portions.find((p) => p.name === name);
    if (!portion) throw new UnitConversionError(`Unknown portion: ${name}`);
    amount = quantity * portion.amount;
    from = dimensionOf(portion.unit);
  } else {
    const def = unitDef(unit);
    if (!def) throw new UnitConversionError(`Unknown unit: ${unit}`);
    amount = quantity * def.toBase;
    from = def.dimension;
  }

  const to = dimensionOf(food.basis);
  if (from === to) return amount;

  const density = food.densityGPerMl;
  if (density === undefined || !(density > 0)) {
    throw new UnitConversionError(
      `Cannot convert ${from} to ${to}: this food has no density. Use a ${to} unit.`,
    );
  }
  // volume (ml) -> mass (g): multiply; mass -> volume: divide.
  return from === "volume" ? amount * density : amount / density;
}

/**
 * The amount in grams or millilitres, keeping the kind of unit the user chose
 * (250 g of milk stays 250 g; no density conversion). Used for the API's serving.
 */
export function metricAmount(food: Measurable, quantity: number, unit: string): { amount: number; unit: BaseUnit } {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new UnitConversionError(`Invalid quantity: ${quantity}`);
  }
  if (unit.startsWith(PORTION_PREFIX)) {
    const name = unit.slice(PORTION_PREFIX.length);
    const portion = food.portions.find((p) => p.name === name);
    if (!portion) throw new UnitConversionError(`Unknown portion: ${name}`);
    return { amount: quantity * portion.amount, unit: portion.unit };
  }
  const def = unitDef(unit);
  if (!def) throw new UnitConversionError(`Unknown unit: ${unit}`);
  return { amount: quantity * def.toBase, unit: def.dimension === "mass" ? "g" : "ml" };
}

/** The same amount in another unit, rounded for showing in a form field. */
export function convertQuantity(food: Measurable, quantity: number, from: string, to: string): number {
  const converted = toBaseAmount(food, quantity, from) / toBaseAmount(food, 1, to);
  return converted >= 1 ? Math.round(converted * 100) / 100 : Number(converted.toPrecision(3));
}

/** Units the user may pick for a food: same dimension always, the other one only with a density. */
export function selectableUnits(food: Measurable): UnitDef[] {
  if (food.portionsOnly) return [];
  const dim = dimensionOf(food.basis);
  const bridged = food.densityGPerMl !== undefined && food.densityGPerMl > 0;
  return UNITS.filter((u) => u.dimension === dim || bridged);
}

/** Human-readable amount, e.g. "40 g", "1.5 × can (375 ml)". */
export function describeAmount(quantity: number, unit: string): string {
  const q = formatAmount(quantity);
  if (unit.startsWith(PORTION_PREFIX)) return `${q} × ${formatMeasurementLabel(unit.slice(PORTION_PREFIX.length))}`;
  return `${q} ${unitDef(unit)?.key ?? unit}`;
}

/** Display only: one decimal place, retaining three significant digits for tiny amounts. */
export function formatAmount(n: number): string {
  return n !== 0 && Math.abs(n) < 0.1
    ? n.toLocaleString("en-AU", { maximumSignificantDigits: 3 })
    : formatNumber(n);
}

/** Round decimal measurements in source labels, without changing portion keys or stored values. */
export function formatMeasurementLabel(label: string): string {
  // Match whole decimal tokens (including grouped thousands), not fractions, codes or versions.
  // Attached units are allowed: source labels often say "354.88199999999995mL".
  return label.replace(
    /(?<![\w.,/])(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d+(?=$|[\s)×]|(?:ml|cl|dl|l|mg|kg|g|oz|lbs?)\b)/gi,
    (value) => formatAmount(Number(value.replace(/,/g, ""))),
  );
}

export function formatNumber(n: number, maxFractionDigits = 1): string {
  return n.toLocaleString("en-AU", { maximumFractionDigits: maxFractionDigits });
}
