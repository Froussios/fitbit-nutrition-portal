/**
 * Source-neutral nutrient model.
 *
 * Masses are in grams and energy in kcal, which is what the Google Health API
 * stores. Each key maps to the Open Food Facts nutriment name (the primary food
 * database from milestone 1) and to its slot in a Google Health NutritionLog:
 * either a top-level field (fat, carbohydrates) or a `nutrients[]` enum value.
 */

export const KJ_PER_KCAL = 4.184;

export interface NutrientDef {
  readonly label: string;
  /** Open Food Facts nutriment key; values are read from `<off>_100g` (grams). */
  readonly off: string;
  /** Where the value goes in a Google Health NutritionLog. */
  readonly google: { readonly field: "totalFat" | "totalCarbohydrate" } | { readonly nutrient: string };
}

export const NUTRIENTS = {
  fat: { label: "Fat", off: "fat", google: { field: "totalFat" } },
  saturatedFat: { label: "Saturated fat", off: "saturated-fat", google: { nutrient: "SATURATED_FAT" } },
  transFat: { label: "Trans fat", off: "trans-fat", google: { nutrient: "TRANS_FAT" } },
  monounsaturatedFat: { label: "Monounsaturated fat", off: "monounsaturated-fat", google: { nutrient: "MONOUNSATURATED_FAT" } },
  polyunsaturatedFat: { label: "Polyunsaturated fat", off: "polyunsaturated-fat", google: { nutrient: "POLYUNSATURATED_FAT" } },
  cholesterol: { label: "Cholesterol", off: "cholesterol", google: { nutrient: "CHOLESTEROL" } },
  carbohydrates: { label: "Carbohydrate", off: "carbohydrates", google: { field: "totalCarbohydrate" } },
  sugars: { label: "Sugars", off: "sugars", google: { nutrient: "SUGAR" } },
  fiber: { label: "Dietary fibre", off: "fiber", google: { nutrient: "DIETARY_FIBER" } },
  protein: { label: "Protein", off: "proteins", google: { nutrient: "PROTEIN" } },
  sodium: { label: "Sodium", off: "sodium", google: { nutrient: "SODIUM" } },
  potassium: { label: "Potassium", off: "potassium", google: { nutrient: "POTASSIUM" } },
  calcium: { label: "Calcium", off: "calcium", google: { nutrient: "CALCIUM" } },
  iron: { label: "Iron", off: "iron", google: { nutrient: "IRON" } },
  caffeine: { label: "Caffeine", off: "caffeine", google: { nutrient: "CAFFEINE" } },
  vitaminC: { label: "Vitamin C", off: "vitamin-c", google: { nutrient: "VITAMIN_C" } },
} as const satisfies Record<string, NutrientDef>;

export type NutrientKey = keyof typeof NUTRIENTS;
export const NUTRIENT_KEYS = Object.keys(NUTRIENTS) as NutrientKey[];

/** Energy and nutrient masses for some amount of food. */
export interface NutrientProfile {
  readonly energyKcal: number;
  readonly nutrients: Readonly<Partial<Record<NutrientKey, number>>>;
}

export function scaleProfile(profile: NutrientProfile, factor: number): NutrientProfile {
  const nutrients: Partial<Record<NutrientKey, number>> = {};
  for (const key of NUTRIENT_KEYS) {
    const v = profile.nutrients[key];
    if (v !== undefined) nutrients[key] = v * factor;
  }
  return { energyKcal: profile.energyKcal * factor, nutrients };
}

export function sumProfiles(profiles: readonly NutrientProfile[]): NutrientProfile {
  const nutrients: Partial<Record<NutrientKey, number>> = {};
  let energyKcal = 0;
  for (const p of profiles) {
    energyKcal += p.energyKcal;
    for (const key of NUTRIENT_KEYS) {
      const v = p.nutrients[key];
      if (v !== undefined) nutrients[key] = (nutrients[key] ?? 0) + v;
    }
  }
  return { energyKcal, nutrients };
}

export function kcalToKj(kcal: number): number {
  return kcal * KJ_PER_KCAL;
}

export function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}
