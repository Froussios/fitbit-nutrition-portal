// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAmount } from "../src/core/amount-text";
import type { FoodItem } from "../src/core/food";
import { describeAmount, formatAmount, formatMeasurementLabel, toBaseAmount } from "../src/core/units";
import { LocalFoodCatalog } from "../src/food/catalog";
import { loggedAmount, toDiaryEntry } from "../src/health/mapping";
import type { DataPoint } from "../src/health/types";
import { createAmountField } from "../src/ui/amount-field";
import { createFoodCombobox } from "../src/ui/food-combobox";

const volume = 354.88199999999995;
const label = `Tall (${volume}mL)`;
const food: FoodItem = {
  ref: { source: "off", id: "1234567890123" },
  name: "Americano 2.345", brand: "Starbucks", packSize: `${volume}mL`,
  basis: "ml", per100: { energyKcal: 3, nutrients: {} },
  portions: [{ name: label, amount: volume, unit: "ml" }],
};

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("display rounding", () => {
  it.each([
    [label, "Tall (354.9mL)"],
    ["1/2 cup (40.00000000000001 g)", "1/2 cup (40 g)"],
    ["1.5/2 cup", "1.5/2 cup"],
    ["1,234.56789 ml", "1,234.6 ml"],
    ["1234.56789 g", "1,234.6 g"],
    ["0.3333333cup", "0.3333333cup"],
    ["1.2345tbsp", "1.2345tbsp"],
    ["1.2345tsp", "1.2345tsp"],
    ["1.2345fl oz", "1.2345fl oz"],
    ["354.882, iced", "354.882, iced"],
    ["12.345%", "12.345%"],
    ["0.000123456 g", "0.000123 g"],
    [".000123456g", "0.000123g"],
    ["B12.345 v1.234 1.2.345 1.234e5 1234567890123", "B12.345 v1.234 1.2.345 1.234e5 1234567890123"],
  ])("formats measurement label %s", (input, expected) => {
    expect(formatMeasurementLabel(input)).toBe(expected);
    expect(formatMeasurementLabel(expected)).toBe(expected);
  });

  it("formats numbers and meal prep descriptions without zeroing tiny portions", () => {
    expect(formatAmount(volume)).toBe("354.9");
    expect(formatAmount(0.000123456)).toBe("0.000123");
    expect(describeAmount(1.0000000000000002, `portion:${label}`)).toBe("1 × Tall (354.9mL)");
    expect(describeAmount(0.01, "g")).toBe("0.01 g");
  });

  it("rounds search serving and pack labels while keeping the food name and selection intact", async () => {
    vi.useFakeTimers();
    const onChoose = vi.fn();
    const combo = createFoodCombobox(new LocalFoodCatalog([food]), { id: "food", onChoose, onCustom: vi.fn(), onEdit: vi.fn() });
    document.body.append(combo.element);
    combo.input.value = "americano";
    combo.input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(500);
    expect(combo.element.querySelector(".opt-name")?.textContent).toBe(food.name);
    expect(combo.element.querySelector(".opt-sub")?.textContent).toContain("354.9mL");
    expect(combo.element.querySelector(".opt-serving")?.textContent).toContain("Tall (354.9mL)");
    combo.element.querySelector<HTMLElement>(".opt")!.click();
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ serving: expect.objectContaining({ label, amount: volume }) }) }));
  });

  it("rounds the unit option's text while preserving its key and calculation", () => {
    const field = createAmountField({ id: "qty", unitId: "unit", onChange: vi.fn() });
    field.show(food, defaultAmount);
    expect(field.unitSelect.selectedOptions[0]!.textContent).toBe("× Tall (354.9mL)");
    expect(field.read()).toEqual({ state: "ok", quantity: 1, unit: `portion:${label}` });
    expect(toBaseAmount(food, 1, field.unitSelect.value)).toBe(volume);
    expect(food.portions[0]!.name).toBe(label);
  });

  it("rounds history amounts and unit labels without changing the raw log", () => {
    const point: DataPoint = {
      name: "users/me/dataTypes/nutrition-log/dataPoints/123",
      nutritionLog: {
        interval: { startTime: "2026-11-08T01:00:00Z", endTime: "2026-11-08T01:01:00Z", startUtcOffset: "0s", endUtcOffset: "0s" },
        foodDisplayName: food.name,
        serving: { amount: volume, foodMeasurementUnit: "units/ml", foodMeasurementUnitDisplayName: "millilitre" },
      },
    };
    expect(toDiaryEntry(point)!.amount).toBe("354.9 ml");
    expect(loggedAmount(point.nutritionLog!)!.amount).toBe(volume);
    point.nutritionLog!.serving = { amount: 1.0000000000000002, foodMeasurementUnit: "units/tall" };
    expect(toDiaryEntry(point, { unitNames: new Map([["units/tall", label]]) })!.amount).toBe("1 Tall (354.9mL)");
    point.nutritionLog!.serving.amount = 0.01;
    expect(toDiaryEntry(point)!.amount).toBe("0.01");
    delete point.nutritionLog!.serving;
    point.nutritionLog!.foodDisplayName = `${food.name} (${volume} ml)`;
    expect(toDiaryEntry(point)!.displayName).toBe(`${food.name} (354.9 ml)`);
    expect(point.nutritionLog!.foodDisplayName).toContain(String(volume));
  });
});
