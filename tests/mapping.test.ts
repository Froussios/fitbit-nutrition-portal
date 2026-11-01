import { describe, expect, it } from "vitest";
import { PORTION_PREFIX } from "../src/core/units";
import { SAMPLE_FOODS } from "../src/food/sample-foods";
import { buildNutritionLogPoint, findServingUnits, toDiaryEntries, toDiaryEntry } from "../src/health/mapping";
import type { DataPoint } from "../src/health/types";

const oats = SAMPLE_FOODS.find((f) => f.ref.id === "oats")!;
const time = new Date("2026-11-01T07:30:00+11:00");

describe("buildNutritionLogPoint", () => {
  it("builds an anonymous nutrition-log data point", () => {
    const p = buildNutritionLogPoint(
      { food: oats, quantity: 1, unit: PORTION_PREFIX + oats.portions[0]!.name, mealType: "BREAKFAST", time },
      { id: "e-test-0001-smp-oats" },
    );
    expect(p.name).toBe("users/me/dataTypes/nutrition-log/dataPoints/e-test-0001-smp-oats");
    const log = p.nutritionLog!;
    expect(log.food).toBeUndefined();
    expect(log.foodDisplayName).toBe("Rolled oats (40 g)");
    expect(log.mealType).toBe("BREAKFAST");
    expect(log.interval.startTime).toBe("2026-10-31T20:30:00.000Z");
    expect(log.interval.endTime).toBe("2026-10-31T20:31:00.000Z");
    expect(log.interval.startUtcOffset).toMatch(/^-?\d+s$/);
    expect(log.energy).toEqual({ kcal: 149.2, userProvidedUnit: "KILOCALORIE" });
    expect(log.totalFat).toEqual({ grams: 3.4 });
    expect(log.totalCarbohydrate).toEqual({ grams: 23.2 });
    expect(log.nutrients).toContainEqual({ nutrient: "PROTEIN", quantity: { grams: 4.8 } });
    expect(log.nutrients).toContainEqual({ nutrient: "DIETARY_FIBER", quantity: { grams: 4 } });
    expect(log.nutrients?.some((n) => n.nutrient === "CARBOHYDRATES")).toBe(false);
    expect(log.serving).toBeUndefined();
  });

  it("names plain-unit amounts as typed", () => {
    const milk = SAMPLE_FOODS.find((f) => f.ref.id === "milk-full-cream")!;
    const p = buildNutritionLogPoint({ food: milk, quantity: 250, unit: "g", mealType: "SNACK", time }, { id: "e-test-0003-smp" });
    expect(p.nutritionLog!.foodDisplayName).toBe("Full cream milk (250 g)");
    expect(p.nutritionLog!.energy!.kcal).toBeCloseTo((250 / 1.03) * 0.65, 1);
  });

  it("adds a serving when the API's gram unit is known", () => {
    const p = buildNutritionLogPoint(
      { food: oats, quantity: 55, unit: "g", mealType: "SNACK", time },
      { id: "e-test-0002-smp", servingUnits: { g: "users/me/dataTypes/food-measurement-unit/dataPoints/147" } },
    );
    expect(p.nutritionLog!.serving).toEqual({ foodMeasurementUnit: "users/me/dataTypes/food-measurement-unit/dataPoints/147", amount: 55 });
  });

  it("round-trips into a diary entry", () => {
    const p = buildNutritionLogPoint({ food: oats, quantity: 100, unit: "g", mealType: "LUNCH", time }, { id: "e-mgx-ab12-smp-oats" });
    const e = toDiaryEntry(p)!;
    expect(e.ref).toEqual({ source: "sample", id: "oats" });
    expect(e.profile.energyKcal).toBe(373);
    expect(e.profile.nutrients.protein).toBe(12);
    expect(e.profile.nutrients.carbohydrates).toBe(58);
    expect(e.start).toEqual(time);
  });
});

describe("toDiaryEntries", () => {
  const other: DataPoint = {
    name: "users/me/dataTypes/nutrition-log/dataPoints/123456789",
    dataSource: { platform: "HEALTH_CONNECT" },
    nutritionLog: {
      interval: { startTime: "2026-10-31T21:00:00Z", endTime: "2026-10-31T21:00:00Z", startUtcOffset: "39600s", endUtcOffset: "39600s" },
      foodDisplayName: "Flat white",
      energy: { kcal: 120 },
      nutrients: [{ nutrient: "CARBOHYDRATES", quantity: { grams: 9 } }],
    },
  };
  const ours = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", mealType: "BREAKFAST", time }, { id: "e-mgx-ab12-smp-oats" });

  it("sorts chronologically and keeps entries from other sources", () => {
    const list = toDiaryEntries([other, ours, { name: "x" }], "our-client");
    expect(list.map((e) => e.displayName)).toEqual(["Rolled oats (40 g)", "Flat white"]);
    expect(list[0]!.own).toBe(true);
    expect(list[1]!.own).toBe(false);
    expect(list[1]!.ref).toBeUndefined();
    expect(list[1]!.sourceLabel).toBe("Health Connect");
    expect(list[1]!.mealType).toBe("MEAL_TYPE_UNSPECIFIED");
    expect(list[1]!.profile.nutrients.carbohydrates).toBe(9);
  });
});

describe("entry ownership", () => {
  const point = (clientId: string, packageName?: string): DataPoint => ({
    name: "users/me/dataTypes/nutrition-log/dataPoints/e-mgx-ab12-smp-oats",
    dataSource: { platform: "GOOGLE_WEB_API", application: { googleWebClientId: clientId, ...(packageName ? { packageName } : {}) } },
    nutritionLog: { interval: { startTime: "2026-10-31T21:00:00Z", endTime: "2026-10-31T21:01:00Z", startUtcOffset: "39600s", endUtcOffset: "39600s" } },
  });

  it("trusts the recorded OAuth client over the ID format", () => {
    expect(toDiaryEntry(point("our-client"), "our-client")!.own).toBe(true);
    const foreign = toDiaryEntry(point("someone-else"), "our-client")!;
    expect(foreign.own).toBe(false);
    expect(foreign.ref).toBeUndefined();
    expect(foreign.sourceLabel).toBe("Google Health API app");
  });

  it("names the Google Health app", () => {
    const p: DataPoint = { ...point(""), name: "users/me/dataTypes/nutrition-log/dataPoints/8812345", dataSource: { application: { packageName: "com.google.fitbit" } } };
    expect(toDiaryEntry(p, "our-client")!.sourceLabel).toBe("Google Health app");
  });
});

describe("findServingUnits", () => {
  it("picks gram and millilitre units", () => {
    const units = findServingUnits([
      { name: "u/1", foodMeasurementUnit: { displayName: "cup" } },
      { name: "u/2", foodMeasurementUnit: { displayName: "Gram" } },
      { name: "u/3", foodMeasurementUnit: { displayName: "milliliter" } },
    ]);
    expect(units).toEqual({ g: "u/2", ml: "u/3" });
  });
});
