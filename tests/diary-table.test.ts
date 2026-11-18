// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import { buildNutritionLogPoint, toDiaryEntry, type DiaryEntry } from "../src/health/mapping";
import { renderDiaryTable, type DiaryTableOptions } from "../src/ui/diary-table";

const UNIT_G = "users/me/dataTypes/food-measurement-unit/dataPoints/g";
const oats: FoodItem = {
  ref: { source: "off", id: "123" },
  name: "Oats",
  basis: "g",
  per100: { energyKcal: 400, nutrients: { protein: 10, fat: 5, carbohydrates: 60 } },
  portions: [],
};

function entry(id = "e-abc-ab12-off-123"): DiaryEntry {
  const point = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time: new Date("2026-11-07T01:00:00Z") }, { id, servingUnits: { g: UNIT_G } });
  return toDiaryEntry(point, { unitNames: new Map([[UNIT_G, "gram"]]) })!;
}

function render(e: DiaryEntry, options: Partial<DiaryTableOptions> = {}) {
  const onEdit = vi.fn();
  const table = renderDiaryTable({ entries: [e], pendingIds: new Set(), deleted: [], busy: new Map(), offline: false, onEdit, onDelete: vi.fn(), onUndo: vi.fn(), ...options });
  document.body.replaceChildren(table);
  const row = table.querySelector("tbody tr")!;
  return { onEdit, row };
}

const dblclick = (target: Element) => target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

describe("diary table double-click", () => {
  it("opens an entry this app logged for editing", () => {
    const e = entry();
    const { onEdit, row } = render(e);
    dblclick(row.querySelectorAll("td")[1]!);
    expect(onEdit).toHaveBeenCalledWith(e);
  });

  it("leaves double-clicks on the row's buttons to the buttons", () => {
    const { onEdit, row } = render(entry());
    dblclick(row.querySelector("button")!);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does nothing where the Edit button is disabled or missing", () => {
    const e = entry();
    const cases: Partial<DiaryTableOptions>[] = [
      { offline: true },
      { busy: new Map([[e.id, "saving"]]) },
      { entries: [], deleted: [e] },
      { editing: { id: "other" } as DiaryTableOptions["editing"] },
    ];
    for (const options of cases) {
      const { onEdit, row } = render(e, options);
      dblclick(row.querySelectorAll("td")[1]!);
      expect(onEdit).not.toHaveBeenCalled();
    }
  });

  it("does nothing on an entry from another app", () => {
    const e = { ...entry(), own: false };
    const { onEdit, row } = render(e);
    dblclick(row.querySelectorAll("td")[1]!);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
