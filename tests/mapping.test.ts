import { describe, expect, it } from "vitest";
import type { FoodItem } from "../src/core/food";
import { PORTION_PREFIX, selectableUnits } from "../src/core/units";
import { SAMPLE_FOODS } from "../src/food/sample-foods";
import { AS_LOGGED_UNIT, asLoggedMeasure, basicMeasure, buildNutritionLogPoint, canConvertLogged, copyNutritionLogPoint, editedNutritionLogPoint, entryFingerprint, findServingUnits, isLoggedAmount, loggedAmount, mealLabel, MEAL_TYPES, NUTRITION_LOG_PARENT, reconcilePending, toDiaryEntries, toDiaryEntry, toLoggedFoods, unitNamesOf, withoutEntries } from "../src/health/mapping";
import type { DataPoint, MealType, NutritionLog } from "../src/health/types";

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

describe("copyNutritionLogPoint", () => {
  const original = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", mealType: "BREAKFAST", time }, { id: "e-test-0001-smp-oats", servingUnits: { g: "units/gram" } });

  it("writes the same entry under the new ID", () => {
    const copy = copyNutritionLogPoint(original.nutritionLog!, "e-test-0002-smp-oats");
    expect(copy).toEqual({ ...original, name: "users/me/dataTypes/nutrition-log/dataPoints/e-test-0002-smp-oats" });
  });

  it("leaves out the read-only fields the API adds when it lists an entry", () => {
    const log = original.nutritionLog!;
    const listed: DataPoint = {
      ...original,
      dataSource: { platform: "GOOGLE_WEB_API", application: { googleWebClientId: "our-client" } },
      nutritionLog: {
        ...log,
        interval: { ...log.interval, civilStartTime: { date: { year: 2026, month: 11, day: 1 } }, civilEndTime: { date: { year: 2026, month: 11, day: 1 } } },
        serving: { ...log.serving!, foodMeasurementUnitDisplayName: "gram" },
      },
    };
    const copy = copyNutritionLogPoint(listed.nutritionLog!, "e-test-0002-smp-oats");
    expect(copy).toEqual({ ...original, name: "users/me/dataTypes/nutrition-log/dataPoints/e-test-0002-smp-oats" });
  });

  it("keeps the entry's place on the day, its meal and its nutrients", () => {
    const entry = toDiaryEntry(original)!;
    const copy = toDiaryEntry(copyNutritionLogPoint(original.nutritionLog!, "e-test-0002-smp-oats"))!;
    expect(copy.start).toEqual(entry.start);
    expect(copy.mealType).toBe("BREAKFAST");
    expect(copy.profile).toEqual(entry.profile);
    expect(copy.id).not.toBe(entry.id);
  });

  it("copies an entry with no serving or meal", () => {
    const bare = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time }, { id: "e-test-0003-smp-oats" });
    expect(copyNutritionLogPoint(bare.nutritionLog!, "e-test-0004-smp-oats").nutritionLog).toEqual(bare.nutritionLog);
  });
});

describe("withoutEntries", () => {
  const point = (id: string): DataPoint => buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time }, { id });

  it("hides deleted entries the API still lists", () => {
    const listed = [point("e-test-0001-smp-oats"), point("e-test-0002-smp-oats")];
    expect(withoutEntries(listed, new Set(["e-test-0001-smp-oats"])).map((p) => p.name)).toEqual([listed[1]!.name]);
  });

  it("stops a copy matching the original the API still lists, by content", () => {
    const original = point("e-test-0001-smp-oats");
    const copy = point("e-test-0002-smp-oats");
    const pending = new Map([["e-test-0002-smp-oats", copy]]);
    expect(reconcilePending(pending, [original]).listedByContent).toEqual(["e-test-0002-smp-oats"]);
    expect(reconcilePending(pending, withoutEntries([original], new Set(["e-test-0001-smp-oats"]))).stillPending).toEqual(["e-test-0002-smp-oats"]);
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

describe("toLoggedFoods", () => {
  const point = (id: string, name = "Oats (Uncle Tobys)", writer?: string): DataPoint => ({
    name: `users/me/dataTypes/nutrition-log/dataPoints/${id}`,
    ...(writer ? { dataSource: { application: { googleWebClientId: writer } } } : {}),
    nutritionLog: { interval: { startTime: "2026-11-01T07:30:00+11:00", endTime: "2026-11-01T07:31:00+11:00" }, foodDisplayName: name },
  }) as DataPoint;

  it("takes the food from the entry's ID and the name from the entry", () => {
    expect(toLoggedFoods([point("e-mgx-ab12-afcd-f005634")])).toEqual([
      { id: "e-mgx-ab12-afcd-f005634", ref: { source: "afcd", id: "f005634" }, label: "Oats (Uncle Tobys)", at: Date.parse("2026-11-01T07:30:00+11:00") },
    ]);
  });

  it("drops an amount the entry had to carry in its name", () => {
    for (const amount of ["40 g", "1,000 ml", "12.5 g"]) {
      expect(toLoggedFoods([point("e-mgx-ab12-off-123", `Oats (${amount})`)])[0]!.label).toBe("Oats");
    }
    expect(toLoggedFoods([point("e-mgx-ab12-off-123", "Oats (Uncle Tobys) (40 g)")])[0]!.label).toBe("Oats (Uncle Tobys)");
    expect(toLoggedFoods([point("e-mgx-ab12-off-123", "Oats (Blend 40)")])[0]!.label).toBe("Oats (Blend 40)");
  });

  it("drops the amount however buildNutritionLogPoint formats it", () => {
    for (const quantity of [40, 12.5, 1000, 1234.5]) {
      const written = buildNutritionLogPoint({ food: oats, quantity, unit: "g", time }, { id: "e-mgx-ab12-smp-oats" });
      expect(written.nutritionLog!.foodDisplayName).not.toBe(oats.name);
      expect(toLoggedFoods([written])[0]!.label).toBe(oats.name);
    }
  });

  it("leaves out what the catalogue cannot load: custom foods, no food in the ID, other apps", () => {
    expect(toLoggedFoods([point("e-mgx-ab12-man-custom")])).toEqual([]);
    expect(toLoggedFoods([point("e-mgx-ab12-off")])).toEqual([]);
    expect(toLoggedFoods([point("12345")])).toEqual([]);
    expect(toLoggedFoods([point("e-mgx-ab12-off-123", "Oats", "other-client")], "our-client")).toEqual([]);
    expect(toLoggedFoods([point("e-mgx-ab12-off-123", "Oats", "our-client")], "our-client")).toHaveLength(1);
  });
});

const round1 = (v: number) => Math.round(v * 10) / 10;

describe("editing an entry", () => {
  const units = { g: "users/me/dataTypes/food-measurement-unit/dataPoints/g", ml: "users/me/dataTypes/food-measurement-unit/dataPoints/ml" };
  const unitNames = new Map([[units.g, "gram"], [units.ml, "milliliter"]]);
  const milk: FoodItem = {
    ref: { source: "off", id: "123" },
    name: "Milk",
    basis: "ml",
    densityGPerMl: 1.03,
    per100: { energyKcal: 64, nutrients: { protein: 3.3, fat: 3.5, carbohydrates: 4.7, iron: 0.00003 } },
    portions: [{ name: "glass", amount: 250, unit: "ml" }],
  };
  const logFood = (food: FoodItem, quantity: number, unit: string, servingUnits: Partial<Record<"g" | "ml", string>> = units, mealType?: MealType) =>
    buildNutritionLogPoint({ food, quantity, unit, time, ...(mealType ? { mealType } : {}) }, { id: "e-test-0001-off-123", servingUnits }).nutritionLog!;
  const opts = { id: "e-new-0002-off-123", servingUnits: units, unitNames };

  describe("loggedAmount", () => {
    it("reads the serving", () => {
      expect(loggedAmount(logFood(oats, 40, "g"), unitNames)).toEqual({ amount: 40, unit: "g" });
      expect(loggedAmount({ ...logFood(milk, 250, "ml"), serving: { foodMeasurementUnit: "x", foodMeasurementUnitDisplayName: "Milliliter", amount: 250 } })).toEqual({ amount: 250, unit: "ml" });
    });

    it("finds the unit when the API names it under users/me rather than the user's ID, as real entries do", () => {
      const looked = new Map([["users/1234567890/dataTypes/food-measurement-unit/dataPoints/147", "gram"]]);
      const serving = { amount: 30, foodMeasurementUnit: "users/me/dataTypes/food-measurement-unit/dataPoints/147" };
      const log = { ...logFood(oats, 30, "g"), serving };
      expect(loggedAmount(log, looked)).toEqual({ amount: 30, unit: "g" });
      expect(toDiaryEntry({ name: "users/me/dataTypes/nutrition-log/dataPoints/1", nutritionLog: log }, { unitNames: looked })?.amount).toBe("30 g");
    });

    it("does not take another unit with the same number", () => {
      const looked = new Map([["users/1234567890/dataTypes/food-measurement-unit/dataPoints/147", "gram"]]);
      const serving = { amount: 30, foodMeasurementUnit: "users/me/dataTypes/food-measurement-unit/dataPoints/1470" };
      expect(loggedAmount({ ...logFood(oats, 30, "g"), serving }, looked)).toBeUndefined();
    });

    it("reads the name when the entry has no serving", () => {
      expect(loggedAmount(logFood(oats, 1000, "g", {}))).toEqual({ amount: 1000, unit: "g" });
    });

    it("finds nothing to edit when there is no usable amount", () => {
      const base = logFood(oats, 40, "g", {});
      expect(loggedAmount({ ...base, foodDisplayName: "Chili (1/6)" })).toBeUndefined();
      expect(loggedAmount({ ...base, foodDisplayName: "Oats (0 g)" })).toBeUndefined();
      expect(loggedAmount({ ...base, serving: { foodMeasurementUnit: units.g, amount: 0 } }, unitNames)).toBeUndefined();
      expect(loggedAmount({ ...base, serving: { foodMeasurementUnit: "unknown", amount: 2 } }, unitNames)).toBeUndefined();
    });

    it("accepts the ways the API might word a unit", () => {
      const withName = (foodMeasurementUnitDisplayName: string) => ({ ...logFood(oats, 40, "g"), serving: { foodMeasurementUnit: "u/1", foodMeasurementUnitDisplayName, amount: 40 } });
      for (const name of ["gram", "Grams", "g", "gram (g)", "gram(s)", " GRAM "]) expect(loggedAmount(withName(name))).toEqual({ amount: 40, unit: "g" });
      for (const name of ["milliliter", "Millilitres", "mL", "ml (milliliter)"]) expect(loggedAmount(withName(name))).toEqual({ amount: 40, unit: "ml" });
      for (const name of ["cup", "gallon", "serving", "glass", "mlem"]) expect(loggedAmount(withName(name))).toBeUndefined();
    });

    it("trusts the unit this app looked up over the API's wording", () => {
      const log = { ...logFood(oats, 40, "g"), serving: { foodMeasurementUnit: units.g, foodMeasurementUnitDisplayName: "unfamiliar wording", amount: 40 } };
      expect(loggedAmount(log, unitNames)).toEqual({ amount: 40, unit: "g" });
    });

    it("reads an amount sent as a string", () => {
      const log = { ...logFood(oats, 40, "g"), serving: { foodMeasurementUnit: units.g, amount: "40" as unknown as number } };
      expect(loggedAmount(log, unitNames)).toEqual({ amount: 40, unit: "g" });
    });

    it("does not take a name's brackets for the amount when the entry has a serving", () => {
      const log = { ...logFood(oats, 40, "g"), foodDisplayName: "Yoghurt (500 g)" };
      expect(loggedAmount(log, unitNames)).toEqual({ amount: 40, unit: "g" });
    });
  });

  describe("with the food's record", () => {
    it("writes what logging that amount would have written, without rounding carried over", () => {
      const log = logFood(milk, 5, "ml");
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 500, unit: "ml", food: milk } }, opts).nutritionLog!;
      const exact = logFood(milk, 500, "ml");
      expect(edited.energy).toEqual(exact.energy);
      expect(edited.nutrients).toEqual(exact.nutrients);
      expect(edited.totalFat).toEqual(exact.totalFat);
      expect(edited.serving).toEqual(exact.serving);
    });

    it("handles portions and density", () => {
      const glass = editedNutritionLogPoint(logFood(milk, 100, "ml"), { amount: { quantity: 2, unit: `${PORTION_PREFIX}glass`, food: milk } }, opts).nutritionLog!;
      expect(glass.energy?.kcal).toBe(320);
      expect(glass.serving).toEqual({ foodMeasurementUnit: units.ml, amount: 500 });

      const grams = editedNutritionLogPoint(logFood(milk, 100, "ml"), { amount: { quantity: 103, unit: "g", food: milk } }, opts).nutritionLog!;
      expect(grams.energy?.kcal).toBe(64);
      expect(grams.serving).toEqual({ foodMeasurementUnit: units.g, amount: 103 });
    });

    it("keeps the time and name as logged, even if the record has changed", () => {
      const log = { ...logFood(milk, 100, "ml"), foodDisplayName: "Old name", interval: { ...logFood(milk, 100, "ml").interval, startUtcOffset: "39600s", civilStartTime: { date: { year: 2026, month: 11, day: 1 } } } };
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 200, unit: "ml", food: { ...milk, name: "New name" } } }, opts).nutritionLog!;
      expect(edited.foodDisplayName).toBe("Old name");
      expect(edited.interval.startTime).toBe(log.interval.startTime);
      expect(edited.interval.startUtcOffset).toBe("39600s");
      expect(edited.interval).not.toHaveProperty("civilStartTime");
    });

    it("does not need the entry to state an amount", () => {
      const log = { ...logFood(milk, 100, "ml"), serving: { foodMeasurementUnit: "u/odd", foodMeasurementUnitDisplayName: "odd", amount: 1 } };
      expect(loggedAmount(log, unitNames)).toBeUndefined();
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 250, unit: "ml", food: milk } }, opts).nutritionLog!;
      expect(edited.energy?.kcal).toBe(160);
      expect(edited.serving).toEqual({ foodMeasurementUnit: units.ml, amount: 250 });
    });

    it("takes the record's current values if they have changed", () => {
      const changed = { ...milk, per100: { energyKcal: 50, nutrients: {} } };
      const edited = editedNutritionLogPoint(logFood(milk, 100, "ml"), { amount: { quantity: 200, unit: "ml", food: changed } }, opts).nutritionLog!;
      expect(edited.energy?.kcal).toBe(100);
    });

    it("can use the entry's own unit when the app has not looked units up yet", () => {
      const log = { ...logFood(milk, 100, "ml"), serving: { foodMeasurementUnit: units.ml, foodMeasurementUnitDisplayName: "milliliter", amount: 100 } };
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 200, unit: "ml", food: milk } }, { id: "e-new-0002-off-123" }).nutritionLog!;
      expect(edited.serving).toEqual({ foodMeasurementUnit: units.ml, amount: 200 });
      expect(edited.foodDisplayName).toBe(log.foodDisplayName);
    });
  });

  describe("without the food's record", () => {
    it("scales every logged value", () => {
      const log: NutritionLog = {
        ...logFood(milk, 100, "ml"),
        energyFromFat: { kcal: 30, userProvidedUnit: "KILOCALORIE" },
      };
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 250, unit: "ml" } }, opts).nutritionLog!;
      expect(edited.energy).toEqual({ kcal: 160, userProvidedUnit: "KILOCALORIE" });
      expect(edited.energyFromFat?.kcal).toBe(75);
      expect(edited.totalFat?.grams).toBe(8.75);
      expect(edited.totalCarbohydrate?.grams).toBe(11.75);
      expect(edited.nutrients?.find((n) => n.nutrient === "PROTEIN")?.quantity.grams).toBe(8.25);
      expect(edited.serving).toEqual({ foodMeasurementUnit: units.ml, amount: 250 });
    });

    it("converts within the kind of unit logged", () => {
      const edited = editedNutritionLogPoint(logFood(milk, 100, "ml"), { amount: { quantity: 1, unit: "cup" } }, opts).nutritionLog!;
      expect(edited.energy?.kcal).toBe(160);
      expect(edited.serving?.amount).toBe(250);
    });

    it("rewrites an amount kept in the name", () => {
      const log = logFood(oats, 40, "g", {});
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 1000, unit: "g" } }, { id: "e-new-0002-smp-oats" }).nutritionLog!;
      expect(edited.foodDisplayName).toBe("Rolled oats (1,000 g)");
      expect(edited).not.toHaveProperty("serving");
      expect(edited.energy?.kcal).toBeCloseTo((log.energy!.kcal * 1000) / 40, 1);
    });

    it("moves an amount kept in the name into the serving once the unit is known", () => {
      const edited = editedNutritionLogPoint(logFood(oats, 40, "g", {}), { amount: { quantity: 50, unit: "g" } }, opts).nutritionLog!;
      expect(edited.foodDisplayName).toBe("Rolled oats");
      expect(edited.serving).toEqual({ foodMeasurementUnit: units.g, amount: 50 });
    });

    it("refuses an amount edit on an entry with no amount", () => {
      const log = { ...logFood(oats, 40, "g", {}), foodDisplayName: "Chili (1/6)" };
      expect(() => editedNutritionLogPoint(log, { amount: { quantity: 2, unit: "g" } }, opts)).toThrow("no amount");
    });
  });

  describe("as a multiple of the entry", () => {
    it("scales every value, and the serving whatever its unit", () => {
      const log = { ...logFood(oats, 40, "g"), serving: { foodMeasurementUnit: "u/odd", foodMeasurementUnitDisplayName: "Gramm", amount: 40 } };
      expect(loggedAmount(log, unitNames)).toBeUndefined();
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 2, unit: AS_LOGGED_UNIT } }, opts).nutritionLog!;
      expect(edited.energy?.kcal).toBe(round1(log.energy!.kcal * 2));
      expect(edited.nutrients?.find((n) => n.nutrient === "PROTEIN")?.quantity.grams).toBe(9.6);
      expect(edited.serving).toEqual({ foodMeasurementUnit: "u/odd", amount: 80 });
      expect(edited.foodDisplayName).toBe(log.foodDisplayName);
    });

    it("works with no serving at all", () => {
      const log = { ...logFood(oats, 40, "g", {}), foodDisplayName: "Chili (1/6)" };
      const edited = editedNutritionLogPoint(log, { amount: { quantity: 0.5, unit: AS_LOGGED_UNIT } }, opts).nutritionLog!;
      expect(edited.energy?.kcal).toBe(round1(log.energy!.kcal / 2));
      expect(edited).not.toHaveProperty("serving");
      expect(edited.foodDisplayName).toBe("Chili (1/6)");
    });

    it("offers only that portion", () => {
      expect(selectableUnits(asLoggedMeasure())).toEqual([]);
      expect(asLoggedMeasure().portions.map((p) => PORTION_PREFIX + p.name)).toEqual([AS_LOGGED_UNIT]);
    });
  });

  describe("meal only", () => {
    it("copies the logged nutrients, even if a food's record would now give others", () => {
      const log = logFood(milk, 100, "ml", units, "LUNCH");
      const edited = editedNutritionLogPoint(log, { mealType: "DINNER" }, opts);
      expect(edited.name).toBe(`${NUTRITION_LOG_PARENT}/dataPoints/${opts.id}`);
      expect(edited.nutritionLog).toEqual({ ...log, mealType: "DINNER" });
    });

    it("removes the meal when none is chosen", () => {
      const edited = editedNutritionLogPoint(logFood(milk, 100, "ml", units, "LUNCH"), {}, opts).nutritionLog!;
      expect(edited).not.toHaveProperty("mealType");
      expect(JSON.parse(JSON.stringify(edited))).not.toHaveProperty("mealType");
    });

    it("adds a meal to an entry that had none", () => {
      expect(editedNutritionLogPoint(logFood(milk, 100, "ml"), { mealType: "SNACK" }, opts).nutritionLog?.mealType).toBe("SNACK");
    });

    it("does not let a listing's old entry stand in for a replacement that looks the same", () => {
      const original: DataPoint = { name: `${NUTRITION_LOG_PARENT}/dataPoints/e-old-0001-off-123`, nutritionLog: logFood(milk, 100, "ml", units, "LUNCH") };
      const replacement = editedNutritionLogPoint(original.nutritionLog!, { mealType: "DINNER" }, opts);
      expect(entryFingerprint(replacement)).toBe(entryFingerprint(original));
      const listed = withoutEntries([original], new Set(["e-old-0001-off-123"]));
      expect(reconcilePending(new Map([[opts.id, replacement]]), listed).stillPending).toEqual([opts.id]);
    });
  });

  describe("isLoggedAmount and canConvertLogged", () => {
    const logged = { amount: 40, unit: "g" as const };

    it("is exact in the logged unit", () => {
      expect(isLoggedAmount(logged, oats, 40, "g")).toBe(true);
      expect(isLoggedAmount(logged, oats, 40.1, "g")).toBe(false);
    });

    it("forgives the rounding of a unit change", () => {
      expect(isLoggedAmount(logged, oats, 1.41, "oz")).toBe(true);
      expect(isLoggedAmount(logged, oats, 2, "oz")).toBe(false);
    });

    it("spots a food that can no longer convert the logged unit", () => {
      const noDensity: FoodItem = { ...milk, densityGPerMl: undefined as never };
      expect(canConvertLogged(milk, { amount: 100, unit: "g" })).toBe(true);
      expect(canConvertLogged(noDensity, { amount: 100, unit: "g" })).toBe(false);
      expect(basicMeasure("g")).toEqual({ basis: "g", portions: [] });
    });
  });
});
