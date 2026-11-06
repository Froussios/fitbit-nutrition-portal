import { describe, expect, it } from "vitest";
import { PORTION_PREFIX } from "../src/core/units";
import { SAMPLE_FOODS } from "../src/food/sample-foods";
import { buildNutritionLogPoint, findServingUnits, mealLabel, MEAL_TYPES, reconcilePending, toDiaryEntries, toDiaryEntry, unitNamesOf } from "../src/health/mapping";
import type { DataPoint } from "../src/health/types";

const oats = SAMPLE_FOODS.find((f) => f.ref.id === "oats")!;
const time = new Date("2026-11-01T07:30:00+11:00");

describe("meal", () => {
  it("leaves mealType out of the request when no meal is picked", () => {
    const p = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time }, { id: "e-test-0006-smp-oats" });
    expect(JSON.parse(JSON.stringify(p)).nutritionLog).not.toHaveProperty("mealType");
  });

  it("shows an entry with no meal as a dash", () => {
    const p = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time }, { id: "e-test-0007-smp-oats" });
    const entry = toDiaryEntry(p)!;
    expect(entry.mealType).toBe("MEAL_TYPE_UNSPECIFIED");
    expect(mealLabel(entry.mealType)).toBe("–");
  });

  it("does not offer the legacy ANYTIME value, but can still label one logged elsewhere", () => {
    expect(MEAL_TYPES.map((m) => m.value)).not.toContain("ANYTIME");
    expect(mealLabel("ANYTIME")).toBe("anytime");
  });
});

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
    // With a serving, the amount is not repeated in the name.
    expect(p.nutritionLog!.foodDisplayName).toBe("Rolled oats");
  });

  it("keeps the kind of unit the user chose for the serving", () => {
    const milk = SAMPLE_FOODS.find((f) => f.ref.id === "milk-full-cream")!;
    const units = { g: "units/gram", ml: "units/ml" };
    const byMass = buildNutritionLogPoint({ food: milk, quantity: 250, unit: "g", mealType: "SNACK", time }, { id: "e-test-0004-smp", servingUnits: units });
    expect(byMass.nutritionLog!.serving).toEqual({ foodMeasurementUnit: "units/gram", amount: 250 });
    const byCup = buildNutritionLogPoint({ food: milk, quantity: 1, unit: "cup", mealType: "SNACK", time }, { id: "e-test-0005-smp", servingUnits: units });
    expect(byCup.nutritionLog!.serving).toEqual({ foodMeasurementUnit: "units/ml", amount: 250 });
  });

  it("shows the serving in the diary entry", () => {
    const p = buildNutritionLogPoint(
      { food: oats, quantity: 55, unit: "g", mealType: "SNACK", time },
      { id: "e-test-0006-smp", servingUnits: { g: "units/gram" } },
    );
    expect(toDiaryEntry(p, { unitNames: new Map([["units/gram", "gram"]]) })!.amount).toBe("55 g");
    const fromApi = { ...p, nutritionLog: { ...p.nutritionLog!, serving: { foodMeasurementUnit: "units/9", amount: 2, foodMeasurementUnitDisplayName: "cup" } } };
    expect(toDiaryEntry(fromApi)!.amount).toBe("2 cup");
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
    const list = toDiaryEntries([other, ours, { name: "x" }], { ownClientId: "our-client" });
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
    expect(toDiaryEntry(point("our-client"), { ownClientId: "our-client" })!.own).toBe(true);
    const foreign = toDiaryEntry(point("someone-else"), { ownClientId: "our-client" })!;
    expect(foreign.own).toBe(false);
    expect(foreign.ref).toBeUndefined();
    expect(foreign.sourceLabel).toBe("Google Health API app");
  });

  it("names the Google Health app", () => {
    const p: DataPoint = { ...point(""), name: "users/me/dataTypes/nutrition-log/dataPoints/8812345", dataSource: { application: { packageName: "com.google.fitbit" } } };
    expect(toDiaryEntry(p, { ownClientId: "our-client" })!.sourceLabel).toBe("Google Health app");
  });
});

describe("findServingUnits", () => {
  it("maps unit resource names to display names", () => {
    expect(unitNamesOf([{ name: "u/2", foodMeasurementUnit: { displayName: "gram" } }, { name: "u/3" }])).toEqual(new Map([["u/2", "gram"]]));
  });

  it("picks gram and millilitre units", () => {
    const units = findServingUnits([
      { name: "u/1", foodMeasurementUnit: { displayName: "cup" } },
      { name: "u/2", foodMeasurementUnit: { displayName: "Gram" } },
      { name: "u/3", foodMeasurementUnit: { displayName: "milliliter" } },
    ]);
    expect(units).toEqual({ g: "u/2", ml: "u/3" });
  });
});

describe("reconcilePending", () => {
  const sent = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", mealType: "BREAKFAST", time }, { id: "e-mgx-ab12-smp-oats" });
  const pending = new Map([["e-mgx-ab12-smp-oats", sent]]);

  it("matches by ID", () => {
    expect(reconcilePending(pending, [{ ...sent, name: "users/4772/dataTypes/nutrition-log/dataPoints/e-mgx-ab12-smp-oats" }]).listedById).toEqual([
      "e-mgx-ab12-smp-oats",
    ]);
  });

  it("matches by content when the API assigned its own ID and reformatted the time", () => {
    const stored: DataPoint = {
      name: "users/4772/dataTypes/nutrition-log/dataPoints/8812345",
      nutritionLog: { ...sent.nutritionLog!, interval: { ...sent.nutritionLog!.interval, startTime: "2026-10-31T20:30:00Z" }, energy: { kcal: 149.2 } },
    };
    expect(reconcilePending(pending, [stored])).toEqual({ listedById: [], listedByContent: ["e-mgx-ab12-smp-oats"], stillPending: [] });
  });

  it("matches identical entries one-to-one", () => {
    const twin = { ...sent, name: "users/me/dataTypes/nutrition-log/dataPoints/e-mgx-cd34-smp-oats" };
    const two = new Map([
      ["e-mgx-ab12-smp-oats", sent],
      ["e-mgx-cd34-smp-oats", twin],
    ]);
    const storedOnce: DataPoint = { ...sent, name: "users/4772/dataTypes/nutrition-log/dataPoints/9001" };
    const r = reconcilePending(two, [storedOnce]);
    expect(r.listedByContent).toHaveLength(1);
    expect(r.stillPending).toHaveLength(1);
  });

  it("does not match another app's entry by content", () => {
    const foreign: DataPoint = {
      ...sent,
      name: "users/4772/dataTypes/nutrition-log/dataPoints/9002",
      dataSource: { application: { googleWebClientId: "someone-else" } },
    };
    expect(reconcilePending(pending, [foreign], "our-client").stillPending).toEqual(["e-mgx-ab12-smp-oats"]);
  });

  it("keeps entries the listing does not contain yet", () => {
    const other: DataPoint = { ...sent, name: "x/1", nutritionLog: { ...sent.nutritionLog!, foodDisplayName: "Banana" } };
    expect(reconcilePending(pending, [other]).stillPending).toEqual(["e-mgx-ab12-smp-oats"]);
  });
});
