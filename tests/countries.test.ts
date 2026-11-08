// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { IndexBuilder, type RawProduct } from "../pipeline/index-builder";
import { offCountries } from "../pipeline/off-countries";
import { countryName, flagEmoji, foodCountries, shownCountry } from "../src/core/countries";
import type { FoodSummary } from "../src/core/food-summary";
import { fromSummaryRow, toFoodItem, type DetailRow, type SummaryRow } from "../src/food/index-format";
import { countryFlag } from "../src/ui/food-combobox";

const summary = (extra: Partial<FoodSummary> = {}): FoodSummary => ({ ref: { source: "off", id: "1" }, name: "Milk", basis: "ml", kcalPer100: 64, ...extra });

describe("Open Food Facts country tags", () => {
  it("become ISO codes in the order listed, once each", () => {
    expect(offCountries(["en:france", "en:australia", "en:france", "en:new-zealand"])).toEqual(["FR", "AU", "NZ"]);
    expect(offCountries(["en:united-kingdom"])).toEqual(["GB"]);
  });

  it("ignore tags with no country code, in another language, or that aren't countries", () => {
    expect(offCountries(["en:world", "en:yugoslavia", "fr:australie", "en:Scotland", "en:constructor", "australia"])).toEqual([]);
    expect(offCountries(undefined)).toEqual([]);
  });
});

describe("countries in the index", () => {
  function rows(records: RawProduct[]): { sum: SummaryRow[]; det: DetailRow[] } {
    const b = new IndexBuilder({ version: "test", builtAt: "2026-11-08T00:00:00Z" });
    for (const r of records) b.add(r);
    const files = new Map(b.files());
    return { sum: JSON.parse(files.get("sum/0.json") as string) as SummaryRow[], det: JSON.parse(files.get("det/0.json") as string) as DetailRow[] };
  }
  const product = (code: string, name: string, extra: Partial<RawProduct> = {}): RawProduct => ({ code, product_name: name, nutriments: { "energy-kcal_100g": 100 }, ...extra });

  it("are stored only for products that list one", () => {
    const { sum, det } = rows([product("1", "Lite milk", { countries_tags: ["en:australia", "en:new-zealand"] }), product("2", "Rice cake")]);
    const milk = sum.findIndex((r) => r[0] === "1");
    const rice = sum.findIndex((r) => r[0] === "2");
    expect(sum[milk]![9]).toBe("AU NZ");
    expect(sum[rice]).toHaveLength(9);
    expect(fromSummaryRow(sum[milk]!).countries).toEqual(["AU", "NZ"]);
    expect(fromSummaryRow(sum[rice]!)).not.toHaveProperty("countries");
    expect(toFoodItem(sum[milk]!, det[milk]!).countries).toEqual(["AU", "NZ"]);
  });

  it("still boost products sold in Australia", () => {
    const { sum } = rows([product("1", "Whole milk", { brands: "Acme" }), product("2", "Whole milk", { brands: "Bolt", countries_tags: ["en:australia"] })]);
    expect(sum[0]![0]).toBe("2");
  });
});

describe("the dropdown's country flag", () => {
  it("prefers Australia when listed, else the first country", () => {
    expect(shownCountry(["FR", "AU"])).toBe("AU");
    expect(shownCountry(["FR", "BE"])).toBe("FR");
    expect(shownCountry([])).toBeUndefined();
  });

  it("knows where generic databases are from", () => {
    expect(foodCountries({ ref: { source: "afcd" } })).toEqual(["AU"]);
    expect(foodCountries({ ref: { source: "fndds" } })).toEqual(["US"]);
    expect(foodCountries({ ref: { source: "off" } })).toEqual([]);
    expect(foodCountries({ ref: { source: "manual" } })).toEqual([]);
  });

  it("draws flags and names countries", () => {
    expect(flagEmoji("AU")).toBe("🇦🇺");
    expect(countryName("NZ")).toBe("New Zealand");
  });

  it("shows one flag, how many other countries, and all of them in the tooltip", () => {
    const flag = countryFlag(summary({ countries: ["US", "AU", "CA"] }))!;
    expect(flag.textContent).toBe("🇦🇺 +2");
    expect(flag.title).toBe("Sold in Australia, United States, Canada");
    expect(flag.getAttribute("aria-label")).toBe(flag.title);
    expect(countryFlag(summary({ countries: ["FR"] }))!.textContent).toBe("🇫🇷");
  });

  it("says where a generic food is from, and shows nothing when the country is unknown", () => {
    expect(countryFlag({ ...summary(), ref: { source: "afcd", id: "F1" } })!.title).toBe("From Australia");
    expect(countryFlag(summary())).toBeNull();
  });
});
