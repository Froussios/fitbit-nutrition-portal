import { describe, expect, it } from "vitest";
import { nutrientsForAmount } from "../src/core/food";
import { fromOffProduct, offBasis, OffNormalizationError } from "../src/core/off";
import { PORTION_PREFIX } from "../src/core/units";
import { SAMPLE_FOODS } from "../src/food/sample-foods";

describe("fromOffProduct", () => {
  it("reads per-100 g values and the serving portion", () => {
    const f = fromOffProduct({
      code: "9300000000001",
      product_name: "Muesli",
      brands: "Brand A, Brand B",
      serving_size: "45 g",
      serving_quantity: "45",
      serving_quantity_unit: "g",
      nutriments: { "energy-kcal_100g": 400, proteins_100g: 10, fat_100g: "7", sodium_100g: 0.02 },
    });
    expect(f.ref).toEqual({ source: "off", id: "9300000000001" });
    expect(f.brand).toBe("Brand A");
    expect(f.basis).toBe("g");
    expect(f.per100).toEqual({ energyKcal: 400, nutrients: { protein: 10, fat: 7, sodium: 0.02 } });
    expect(f.portions).toEqual([{ name: "45 g", amount: 45, unit: "g" }]);
  });

  it("treats legacy _100g values of a liquid product as per 100 ml", () => {
    const p = { code: "1", product_quantity: 375, product_quantity_unit: "ml", nutrition_data_per: "100g", nutriments: { "energy-kcal_100g": 42 } };
    expect(offBasis(p)).toBe("ml");
    expect(fromOffProduct(p).portions).toEqual([{ name: "pack", amount: 375, unit: "ml" }]);
  });

  it("honours an explicit 100ml basis", () => {
    expect(offBasis({ code: "1", nutrition_data_per: "100ml" })).toBe("ml");
  });

  it("derives kcal from kJ", () => {
    expect(fromOffProduct({ code: "1", nutriments: { "energy-kj_100g": 418.4 } }).per100.energyKcal).toBeCloseTo(100);
  });

  it("derives per-100 values from per-serving data", () => {
    const f = fromOffProduct({
      code: "2",
      serving_quantity: 200,
      serving_quantity_unit: "g",
      nutrition_data_per: "serving",
      nutriments: { "energy-kcal_serving": 500, proteins_serving: 20 },
    });
    expect(f.per100.energyKcal).toBe(250);
    expect(f.per100.nutrients.protein).toBe(10);
  });

  it("fails without energy", () => {
    expect(() => fromOffProduct({ code: "3", nutriments: { proteins_100g: 1 } })).toThrow(OffNormalizationError);
  });
});

describe("sample catalogue", () => {
  it("normalises every sample food", () => {
    expect(SAMPLE_FOODS.length).toBeGreaterThan(0);
    for (const f of SAMPLE_FOODS) {
      expect(f.ref.source).toBe("sample");
      expect(f.per100.energyKcal).toBeGreaterThan(0);
    }
  });

  it("computes nutrients for a portion", () => {
    const burger = SAMPLE_FOODS.find((f) => f.ref.id === "burger-classic")!;
    const p = nutrientsForAmount(burger, 1, PORTION_PREFIX + burger.portions[0]!.name);
    expect(p.energyKcal).toBeCloseTo(525);
    expect(p.nutrients.protein).toBeCloseTo(26);
  });
});

describe("LocalFoodCatalog", () => {
  it("searches by every word and finds by reference", async () => {
    const { LocalFoodCatalog } = await import("../src/food/catalog");
    const c = new LocalFoodCatalog(SAMPLE_FOODS);
    expect(await c.search("")).toEqual([]);
    expect((await c.search("sample BURGER")).map((h) => h.summary.ref.id)).toEqual(["burger-classic"]);
    expect((await c.search("burger sam")).map((h) => h.summary.ref.id)).toEqual(["burger-classic"]);
    expect(await c.get({ source: "sample", id: "oats" })).toBe(SAMPLE_FOODS.find((f) => f.ref.id === "oats"));
    expect(await c.get({ source: "off", id: "oats" })).toBeUndefined();
  });
});
