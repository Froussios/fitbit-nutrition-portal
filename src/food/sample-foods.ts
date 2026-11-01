import type { FoodItem } from "../core/food";
import { fromOffProduct, type OffProduct } from "../core/off";

/**
 * Proof-of-concept catalogue.
 *
 * Local fake data: the values are arbitrary (rounded, plausible) and NOT taken
 * from any real product. They are written in the Open Food Facts product format
 * on purpose, so they go through the same normaliser that records from the
 * future Open Food Facts mirror will use. The codes are not barcodes and use
 * the "sample" source.
 */
const SAMPLE_PRODUCTS: OffProduct[] = [
  {
    code: "oats",
    product_name: "Rolled oats",
    serving_size: "1/2 cup (40 g)",
    serving_quantity: 40,
    serving_quantity_unit: "g",
    nutrition_data_per: "100g",
    nutriments: {
      "energy-kj_100g": 1560, "energy-kcal_100g": 373, proteins_100g: 12, carbohydrates_100g: 58,
      sugars_100g: 1, fat_100g: 8.5, "saturated-fat_100g": 1.5, fiber_100g: 10, sodium_100g: 0.005,
    },
  },
  {
    code: "milk-full-cream",
    product_name: "Full cream milk",
    quantity: "2 L",
    product_quantity: 2000,
    product_quantity_unit: "ml",
    serving_size: "1 glass (250 ml)",
    serving_quantity: 250,
    serving_quantity_unit: "ml",
    nutrition_data_per: "100ml",
    nutriments: {
      "energy-kj_100g": 270, "energy-kcal_100g": 65, proteins_100g: 3.3, carbohydrates_100g: 4.8,
      sugars_100g: 4.8, fat_100g: 3.5, "saturated-fat_100g": 2.3, sodium_100g: 0.04, calcium_100g: 0.12,
    },
  },
  {
    code: "banana",
    product_name: "Banana, raw",
    serving_size: "1 medium (120 g)",
    serving_quantity: 120,
    serving_quantity_unit: "g",
    nutriments: {
      "energy-kcal_100g": 90, proteins_100g: 1.2, carbohydrates_100g: 20, sugars_100g: 15,
      fat_100g: 0.3, fiber_100g: 2.4, potassium_100g: 0.35,
    },
  },
  {
    code: "cola-can",
    product_name: "Cola soft drink",
    brands: "Sample Drinks Co",
    quantity: "375 ml",
    product_quantity: 375,
    product_quantity_unit: "ml",
    nutrition_data_per: "100g", // legacy OFF records say 100g even for drinks
    nutriments: {
      "energy-kj_100g": 180, "energy-kcal_100g": 43, carbohydrates_100g: 10.6, sugars_100g: 10.6,
      fat_100g: 0, proteins_100g: 0, sodium_100g: 0.01, caffeine_100g: 0.0096,
    },
  },
  {
    code: "burger-classic",
    product_name: "Classic double burger",
    brands: "Sample Burger Bar",
    serving_size: "1 burger (215 g)",
    serving_quantity: 215,
    serving_quantity_unit: "g",
    nutrition_data_per: "serving",
    // Restaurant data is usually per serving only; the normaliser derives per-100 g values.
    nutriments: {
      "energy-kj_serving": 2200, "energy-kcal_serving": 525, proteins_serving: 26, carbohydrates_serving: 43,
      sugars_serving: 9, fat_serving: 27, "saturated-fat_serving": 10.5, fiber_serving: 3, sodium_serving: 0.95,
    },
  },
  {
    code: "peanut-butter",
    product_name: "Smooth peanut butter",
    brands: "Sample Pantry",
    quantity: "375 g",
    product_quantity: 375,
    product_quantity_unit: "g",
    serving_size: "1 tbsp (20 g)",
    serving_quantity: 20,
    serving_quantity_unit: "g",
    nutriments: {
      "energy-kcal_100g": 620, proteins_100g: 25, carbohydrates_100g: 12, sugars_100g: 6,
      fat_100g: 50, "saturated-fat_100g": 8, fiber_100g: 7, sodium_100g: 0.35,
    },
  },
];

/** OFF has no density field; this one shows the mass/volume bridge working (milk ≈ 1.03 g/ml). */
const DENSITY_G_PER_ML: Record<string, number> = { "milk-full-cream": 1.03 };

export const SAMPLE_FOODS: readonly FoodItem[] = SAMPLE_PRODUCTS.map((p) => {
  const item: FoodItem = { ...fromOffProduct(p), ref: { source: "sample", id: p.code } };
  const density = DENSITY_G_PER_ML[p.code];
  return density ? { ...item, densityGPerMl: density } : item;
});
