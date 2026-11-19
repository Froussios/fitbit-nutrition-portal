// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { IndexBuilder, type RawProduct } from "../pipeline/index-builder";
import { energyFromMacros, energyMismatch } from "../src/core/energy-check";
import type { FoodSummary } from "../src/core/food-summary";
import type { NutrientProfile } from "../src/core/nutrients";
import { offEnergyExtras } from "../src/core/off";
import { parseQuery } from "../src/core/tokens";
import { FoodIndex, IndexNotFoundError, type IndexReader } from "../src/food/index-engine";
import { fromSummaryRow, summaryRow } from "../src/food/index-format";
import { energyWarning } from "../src/ui/food-combobox";

const per100 = (energyKcal: number, fat?: number, carbohydrates?: number, protein?: number, fiber?: number): NutrientProfile => ({
  energyKcal,
  nutrients: { ...(fat !== undefined ? { fat } : {}), ...(carbohydrates !== undefined ? { carbohydrates } : {}), ...(protein !== undefined ? { protein } : {}), ...(fiber !== undefined ? { fiber } : {}) },
});

describe("energy check", () => {
  it("accepts energy that agrees with fat, carbs and protein", () => {
    expect(energyMismatch(per100(520, 32, 56, 8))).toBeUndefined(); // Nutella: 544 by its macros
    expect(energyMismatch(per100(177, 0.5, 11, 25))).toBeUndefined(); // Vegemite
    expect(energyMismatch(per100(0, 0, 0, 0))).toBeUndefined(); // water
  });

  it("flags energy that disagrees, with what the macros imply", () => {
    expect(energyMismatch(per100(6, 0, 5, 0))).toBe(20); // 14 kcal off at 20: beyond 10 kcal
    expect(energyMismatch(per100(15.3, 6.7, 15.3, 8))).toBeCloseTo(153.5, 1);
    expect(energyMismatch(per100(185, 0, 10.6, 0))).toBeCloseTo(42.4, 1); // Pepsi at 185 kcal
  });

  it("allows 20%, or 10 kcal for low-energy foods", () => {
    expect(energyMismatch(per100(30, 0, 5, 0))).toBeUndefined(); // 20 by macros, 10 off
    expect(energyMismatch(per100(31, 0, 5, 0))).toBe(20);
    expect(energyMismatch(per100(400, 0, 120, 0))).toBeUndefined(); // 480: 80 off, within 20% of 480
    expect(energyMismatch(per100(380, 0, 120, 0))).toBe(480);
  });

  it("counts fibre either inside carbohydrate (US labels) or outside it (Australian and EU labels)", () => {
    // Bran: 20 g fibre. Outside carbs: 4 × 40 + 2 × 20 + … = 260; inside: 4 × 20 + 40 + … = 180.
    expect(energyFromMacros(per100(0, 5, 40, 15, 20))).toEqual([305, 225]);
    expect(energyMismatch(per100(300, 5, 40, 15, 20))).toBeUndefined();
    expect(energyMismatch(per100(230, 5, 40, 15, 20))).toBeUndefined();
  });

  it("can't check a food missing fat, carbs or protein", () => {
    expect(energyFromMacros(per100(500, 30, 50))).toBeUndefined();
    expect(energyMismatch(per100(5, 30, 50))).toBeUndefined();
  });

  it("counts alcohol and sugar alcohols when Open Food Facts records them", () => {
    const beer = per100(43, 0, 3.6, 0.5);
    expect(energyMismatch(beer)).toBeDefined();
    expect(energyMismatch(beer, offEnergyExtras({ nutriments: { alcohol_100g: "4.8" } }))).toBeUndefined();
    const gum = per100(160, 0, 70, 0); // 65 g of it polyols
    expect(energyMismatch(gum)).toBe(280);
    expect(energyMismatch(gum, offEnergyExtras({ nutriments: { polyols_100g: 65 } }))).toBeUndefined();
  });
});

function index(records: RawProduct[]) {
  const b = new IndexBuilder({ version: "test", builtAt: "2026-11-19T00:00:00Z" });
  for (const r of records) b.add(r);
  const files = new Map<string, string | Uint8Array>(b.files());
  const get = (path: string) => {
    const f = files.get(path);
    if (f === undefined) throw new IndexNotFoundError(path);
    return f;
  };
  const reader: IndexReader = { json: async <T>(p: string) => JSON.parse(get(p) as string) as T, bytes: async (p: string) => get(p) as Uint8Array };
  return { builder: b, reader };
}

const vegemite = (code: string, kcal: number, carbs: number, protein: number, scans: number): RawProduct => ({
  code,
  product_name: "Vegemite",
  brands: "Vegemite",
  unique_scans_n: scans,
  nutriments: { "energy-kcal_100g": kcal, fat_100g: 0.5, carbohydrates_100g: carbs, proteins_100g: protein },
});

describe("energy check in the index", () => {
  it("keeps an entry that adds up over a more popular one that doesn't, and marks the rest", async () => {
    const { builder, reader } = index([
      vegemite("9001", 6, 5, 0, 900),
      vegemite("9002", 177, 11, 25, 1),
      { code: "9003", product_name: "Pepsi", nutriments: { "energy-kcal_100g": 185, fat_100g: 0, carbohydrates_100g: 10.6, proteins_100g: 0 } },
    ]);
    expect(builder.counts.energyMismatch).toBe(2);
    const idx = await FoodIndex.open(reader);
    const rows = (await idx.summaries(await idx.search(parseQuery("vegemite")))).map(fromSummaryRow);
    expect(rows.map((r) => [r.ref.id, r.macroKcalPer100])).toEqual([["9002", undefined]]);
    const pepsi = (await idx.summaries(await idx.search(parseQuery("pepsi")))).map(fromSummaryRow);
    expect(pepsi[0]!.macroKcalPer100).toBeCloseTo(42.4, 1);
    const hidden = fromSummaryRow((await idx.summaries([(await idx.findBarcode("9001"))!]))[0]!);
    expect(hidden.macroKcalPer100).toBeCloseTo(24.5, 1);
  });

  it("stores the implied energy after the countries, which may be empty", () => {
    const s: FoodSummary = { ref: { source: "off", id: "1" }, name: "Pepsi", basis: "ml", kcalPer100: 185, macroKcalPer100: 42.4 };
    expect(summaryRow(s)).toEqual(["1", "Pepsi", null, null, "ml", 185, null, null, null, null, 42.4]);
    expect(fromSummaryRow(summaryRow(s))).toEqual(s);
    expect(fromSummaryRow(summaryRow({ ...s, countries: ["AU"] })).countries).toEqual(["AU"]);
    const { macroKcalPer100: _, ...unchecked } = s;
    expect(summaryRow(unchecked)).toHaveLength(9);
  });
});

describe("the dropdown's energy warning", () => {
  const summary = (extra: Partial<FoodSummary> = {}): FoodSummary => ({ ref: { source: "off", id: "1" }, name: "Pepsi", basis: "ml", kcalPer100: 185, ...extra });

  it("says the energy doesn't add up, and what the macros give", () => {
    const chip = energyWarning(summary({ macroKcalPer100: 42.4 }))!;
    expect(chip.textContent).toContain("Energy doesn't add up");
    expect(chip.title).toBe("Its fat, carbs and protein add up to 42 kcal / 100 ml, not 185. One of the values is probably wrong: check the pack before logging it.");
  });

  it("is absent when the energy adds up or wasn't checked", () => {
    expect(energyWarning(summary())).toBeNull();
  });
});
