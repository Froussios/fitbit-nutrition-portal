import type { ChatHost } from "../src/ai/chat-tools";
import type { FoodItem } from "../src/core/food";
import { LocalFoodCatalog } from "../src/food/catalog";
import { buildNutritionLogPoint, toDiaryEntry, type DiaryEntry } from "../src/health/mapping";
import type { MealType } from "../src/health/types";

export const UNIT_G = "users/me/dataTypes/food-measurement-unit/dataPoints/g";
export const UNIT_ML = "users/me/dataTypes/food-measurement-unit/dataPoints/ml";
export const unitNames = new Map([
  [UNIT_G, "gram"],
  [UNIT_ML, "milliliter"],
]);
export const OWN_CLIENT = "own-client";
export const TODAY = "2026-11-19";

export const oats: FoodItem = {
  ref: { source: "off", id: "123" },
  name: "Oats",
  basis: "g",
  per100: { energyKcal: 400, nutrients: { protein: 10, fat: 5, carbohydrates: 60 } },
  portions: [{ name: "1 cup (90 g)", amount: 90, unit: "g" }],
};

export const bread: FoodItem = {
  ref: { source: "fndds", id: "555" },
  name: "Bread, wholemeal",
  basis: "g",
  per100: { energyKcal: 250, nutrients: { protein: 9, fat: 3, carbohydrates: 45 } },
  portions: [{ name: "slice (35 g)", amount: 35, unit: "g" }],
};

/** An entry this app logged, or (with `writer`) one another app logged. */
export function entryOf(food: FoodItem, quantity: number, unit: string, time: string, opts: { mealType?: MealType; writer?: string; id?: string } = {}): DiaryEntry {
  const point = buildNutritionLogPoint({ food, quantity, unit, time: new Date(time), ...(opts.mealType ? { mealType: opts.mealType } : {}) }, { id: opts.id ?? `e-abc-ab12-${food.ref.source === "fndds" ? "fnds" : "off"}-${food.ref.id}`, servingUnits: { g: UNIT_G, ml: UNIT_ML } });
  const withWriter = opts.writer ? { ...point, dataSource: { application: { googleWebClientId: opts.writer, packageName: "com.example.other" } } } : point;
  return toDiaryEntry(withWriter as typeof point, { ownClientId: OWN_CLIENT, unitNames })!;
}

/** The same entry with no energy stated, as another app may log one. The diary reads it as 0 kcal. */
export function withoutEnergy(e: DiaryEntry): DiaryEntry {
  const { energy: _energy, ...log } = e.point.nutritionLog!;
  return toDiaryEntry({ ...e.point, nutritionLog: log }, { ownClientId: OWN_CLIENT, unitNames })!;
}

/** A host with a fixed diary, by day. */
export function hostWith(days: Record<string, DiaryEntry[]>, foods: FoodItem[] = [oats, bread]): ChatHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    today: () => TODAY,
    viewedDay: () => TODAY,
    async entriesOn(day) {
      reads.push(day);
      return days[day] ?? [];
    },
    catalog: new LocalFoodCatalog(foods),
    energyUnit: () => "kcal",
    servingUnits: () => ({ g: UNIT_G, ml: UNIT_ML }),
    diaryContext: () => ({ ownClientId: OWN_CLIENT, unitNames }),
    logTime: (day) => new Date(`${day}T12:00:00`),
  };
}
