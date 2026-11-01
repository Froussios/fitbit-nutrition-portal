import { describe, expect, it } from "vitest";
import { metricAmount, PORTION_PREFIX, selectableUnits, toBaseAmount, UnitConversionError, type Measurable } from "../src/core/units";

const oats: Measurable = { basis: "g", portions: [{ name: "1/2 cup (40 g)", amount: 40, unit: "g" }] };
const milk: Measurable = { basis: "ml", portions: [], densityGPerMl: 1.03 };
const cola: Measurable = { basis: "ml", portions: [{ name: "can", amount: 375, unit: "ml" }] };

describe("toBaseAmount", () => {
  it("converts within a dimension", () => {
    expect(toBaseAmount(oats, 0.25, "kg")).toBe(250);
    expect(toBaseAmount(cola, 2, "cup")).toBe(500);
    expect(toBaseAmount(cola, 1, "tbsp")).toBe(20);
  });

  it("uses portions", () => {
    expect(toBaseAmount(oats, 1.5, `${PORTION_PREFIX}1/2 cup (40 g)`)).toBe(60);
    expect(toBaseAmount(cola, 1, `${PORTION_PREFIX}can`)).toBe(375);
  });

  it("bridges mass and volume only with a density", () => {
    expect(toBaseAmount(milk, 103, "g")).toBeCloseTo(100);
    expect(() => toBaseAmount(cola, 100, "g")).toThrow(UnitConversionError);
    expect(() => toBaseAmount(oats, 1, "cup")).toThrow(/no density/);
  });

  it("rejects bad input", () => {
    expect(() => toBaseAmount(oats, -1, "g")).toThrow(UnitConversionError);
    expect(() => toBaseAmount(oats, 1, "furlong")).toThrow(/Unknown unit/);
    expect(() => toBaseAmount(oats, 1, `${PORTION_PREFIX}nope`)).toThrow(/Unknown portion/);
  });
});

describe("selectableUnits", () => {
  it("offers only the food's dimension without a density", () => {
    expect(selectableUnits(oats).every((u) => u.dimension === "mass")).toBe(true);
  });
  it("offers both dimensions with a density", () => {
    const dims = new Set(selectableUnits(milk).map((u) => u.dimension));
    expect(dims).toEqual(new Set(["mass", "volume"]));
  });
});

describe("metricAmount", () => {
  it("keeps the dimension the user chose", () => {
    expect(metricAmount(milk, 250, "g")).toEqual({ amount: 250, unit: "g" });
    expect(metricAmount(milk, 2, "cup")).toEqual({ amount: 500, unit: "ml" });
    expect(metricAmount(cola, 1, `${PORTION_PREFIX}can`)).toEqual({ amount: 375, unit: "ml" });
    expect(() => metricAmount(cola, 1, "furlong")).toThrow(UnitConversionError);
  });
});
