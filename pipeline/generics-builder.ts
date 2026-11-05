import { KJ_PER_KCAL, NUTRIENT_KEYS, type NutrientKey } from "../src/core/nutrients";
import type { BaseUnit } from "../src/core/units";
import type { GenericRow } from "../src/food/generics-format";

/**
 * Converts authoritative food composition tables to the generic foods file
 * (docs/FOOD_SEARCH.md section 13). Pure: `pipeline/build-generics.ts` reads the
 * downloads and writes the result. Each source's values stay as they are, apart
 * from the unit and definition changes noted here; rows are never merged.
 */

export type TableRow = Readonly<Record<string, string | undefined>>;

const MG = 0.001;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Values in NUTRIENT_KEYS order, in grams, without the trailing gaps. */
function nutrientArray(values: Partial<Record<NutrientKey, number>>): (number | null)[] {
  const out = NUTRIENT_KEYS.map((k) => {
    const v = values[k];
    return v === undefined ? null : round(v, 5);
  });
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out;
}

/** Foods for infants, and human milk: not what anyone logging their own food is looking for. */
const EXCLUDED = /\b(human|infant formula|baby food)\b/i;

/** AFCD columns for each nutrient, with the factor that converts the value to grams. */
const AFCD_COLUMNS: Readonly<Record<NutrientKey, readonly [column: string, toGrams: number]>> = {
  fat: ["Fat, total (g)", 1],
  saturatedFat: ["Total saturated fatty acids, equated (g)", 1],
  transFat: ["Total trans fatty acids, imputed (mg)", MG],
  monounsaturatedFat: ["Total monounsaturated fatty acids, equated (g)", 1],
  polyunsaturatedFat: ["Total polyunsaturated fatty acids, equated (g)", 1],
  cholesterol: ["Cholesterol (mg)", MG],
  carbohydrates: ["Available carbohydrate, with sugar alcohols (g)", 1],
  sugars: ["Total sugars (g)", 1],
  fiber: ["Total dietary fibre (g)", 1],
  protein: ["Protein (g)", 1],
  sodium: ["Sodium (Na) (mg)", MG],
  potassium: ["Potassium (K) (mg)", MG],
  calcium: ["Calcium (Ca) (mg)", MG],
  iron: ["Iron (Fe) (mg)", MG],
  caffeine: ["Caffeine (mg)", MG],
  vitaminC: ["Vitamin C (mg)", MG],
};
const AFCD_ENERGY = "Energy with dietary fibre, equated (kJ)";

/**
 * Australian Food Composition Database. Every food is listed per 100 g, and
 * liquids again per 100 ml; a liquid uses the per-100-ml row, as on its label.
 * Throws if a column has gone, so a new release can't silently drop a nutrient.
 */
export function fromAfcd(solids: readonly TableRow[], liquids: readonly TableRow[], details: readonly TableRow[]): GenericRow[] {
  const first = solids[0];
  if (first) {
    for (const column of [AFCD_ENERGY, ...NUTRIENT_KEYS.map((k) => AFCD_COLUMNS[k][0])]) {
      if (!(column in first)) throw new Error(`AFCD: no column "${column}"`);
    }
  }
  const density = new Map(details.map((r) => [r["Public Food Key"], num(r["Specific Gravity"])]));
  const perMl = new Map(liquids.map((r) => [r["Public Food Key"], r]));
  const out: GenericRow[] = [];
  for (const solid of solids) {
    const key = solid["Public Food Key"];
    const name = solid["Food Name"]?.trim();
    if (!key || !name || EXCLUDED.test(name)) continue;
    const liquid = perMl.get(key);
    const r = liquid ?? solid;
    const basis: BaseUnit = liquid ? "ml" : "g";
    const kj = num(r[AFCD_ENERGY]);
    if (kj === undefined) continue;
    const values: Partial<Record<NutrientKey, number>> = {};
    for (const k of NUTRIENT_KEYS) {
      const [column, factor] = AFCD_COLUMNS[k];
      const v = num(r[column]);
      if (v !== undefined) values[k] = v * factor;
    }
    out.push(["afcd", key, name, basis, round(kj / KJ_PER_KCAL, 1), nutrientArray(values), density.get(key) || null, []]);
  }
  return out;
}

/** FNDDS nutrient numbers. It uses USDA's older numbering (208 for energy, not 1008). */
const FNDDS_NUTRIENTS: Readonly<Record<string, readonly [NutrientKey, number]>> = {
  "204": ["fat", 1],
  "606": ["saturatedFat", 1],
  "605": ["transFat", 1],
  "645": ["monounsaturatedFat", 1],
  "646": ["polyunsaturatedFat", 1],
  "601": ["cholesterol", MG],
  "205": ["carbohydrates", 1],
  "269": ["sugars", 1],
  "291": ["fiber", 1],
  "203": ["protein", 1],
  "307": ["sodium", MG],
  "306": ["potassium", MG],
  "301": ["calcium", MG],
  "303": ["iron", MG],
  "262": ["caffeine", MG],
  "401": ["vitaminC", MG],
};
const FNDDS_ENERGY = "208";
const MAX_PORTIONS = 6;

/**
 * USDA Food and Nutrient Database for Dietary Studies. USDA's carbohydrate
 * includes fibre; the Australian and European figures do not, so fibre is taken
 * out to make them mean the same. All values are per 100 g.
 */
export function fromFndds(foods: readonly TableRow[], nutrients: readonly TableRow[], portions: readonly TableRow[]): GenericRow[] {
  const kcal = new Map<string, number>();
  const values = new Map<string, Partial<Record<NutrientKey, number>>>();
  for (const r of nutrients) {
    const id = r["fdc_id"];
    const v = num(r["amount"]);
    if (!id || v === undefined) continue;
    if (r["nutrient_id"] === FNDDS_ENERGY) {
      kcal.set(id, v);
      continue;
    }
    const known = FNDDS_NUTRIENTS[r["nutrient_id"] ?? ""];
    if (!known) continue;
    let row = values.get(id);
    if (!row) values.set(id, (row = {}));
    row[known[0]] = v * known[1];
  }
  const servings = new Map<string, [string, number][]>();
  for (const r of [...portions].sort((a, b) => (num(a["seq_num"]) ?? 0) - (num(b["seq_num"]) ?? 0))) {
    const id = r["fdc_id"];
    const name = r["portion_description"]?.trim();
    const grams = num(r["gram_weight"]);
    if (!id || !name || !grams || grams <= 0 || /quantity not specified|guideline|school/i.test(name)) continue;
    let list = servings.get(id);
    if (!list) servings.set(id, (list = []));
    if (list.length < MAX_PORTIONS) list.push([name.slice(0, 60), round(grams, 1)]);
  }
  const out: GenericRow[] = [];
  for (const f of foods) {
    const id = f["fdc_id"];
    const name = f["description"]?.trim();
    if (!id || !name || EXCLUDED.test(name)) continue;
    const energy = kcal.get(id);
    if (energy === undefined) continue;
    const row = { ...values.get(id) };
    if (row.carbohydrates !== undefined) row.carbohydrates = Math.max(0, row.carbohydrates - (row.fiber ?? 0));
    out.push(["fndds", id, name, "g", round(energy, 1), nutrientArray(row), null, servings.get(id) ?? []]);
  }
  return out;
}
