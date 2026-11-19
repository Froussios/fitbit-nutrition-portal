// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import { newEntryId } from "../src/core/ids";
import { buildNutritionLogPoint, buildPortionPoint, toDiaryEntry, type DiaryEntry } from "../src/health/mapping";
import { amountText } from "../src/ui/format";
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
  const onRepeat = vi.fn();
  const table = renderDiaryTable({ entries: [e], pendingIds: new Set(), deleted: [], busy: new Map(), offline: false, onEdit, onDelete: vi.fn(), onUndo: vi.fn(), onRepeat, ...options });
  document.body.replaceChildren(table);
  const row = table.querySelector("tbody tr")!;
  return { onEdit, onRepeat, row };
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

  it("does nothing on a meal prep share, which has no Edit button", () => {
    const e: DiaryEntry = { ...entry(), ref: { source: "prep", id: "p1" } };
    const { onEdit, row } = render(e);
    expect(row.querySelector("[data-entry-edit]")).toBeNull();
    dblclick(row.querySelectorAll("td")[1]!);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does nothing on an entry from another app", () => {
    const e = { ...entry(), own: false };
    const { onEdit, row } = render(e);
    dblclick(row.querySelectorAll("td")[1]!);
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("diary table Log again button", () => {
  const repeatButton = (row: Element) => row.querySelector<HTMLButtonElement>("[data-entry-repeat]");

  it("logs an entry this app logged again, from beside its Edit and Delete", () => {
    const e = entry();
    const { onRepeat, row } = render(e);
    const buttons = [...row.querySelectorAll(".row-actions button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Log Oats again today", "Edit Oats", "Delete Oats"]);
    repeatButton(row)!.click();
    expect(onRepeat).toHaveBeenCalledWith(e);
  });

  it("is offered on an entry from another app, beside its lock", () => {
    const e = { ...entry(), own: false };
    const { onRepeat, row } = render(e);
    expect(row.querySelector(".not-owned")).not.toBeNull();
    repeatButton(row)!.click();
    expect(onRepeat).toHaveBeenCalledWith(e);
  });

  it("is not offered on a deleted entry or a meal prep share", () => {
    const e = entry();
    expect(repeatButton(render(e, { entries: [], deleted: [e] }).row)).toBeNull();
    expect(repeatButton(render({ ...e, ref: { source: "prep", id: "p1" } }).row)).toBeNull();
  });

  it("is disabled offline and while the row is busy", () => {
    const e = entry();
    expect(repeatButton(render(e, { offline: true }).row)!.disabled).toBe(true);
    expect(repeatButton(render(e, { busy: new Map([[e.id, "logging again…"]]) }).row)!.disabled).toBe(true);
    expect(repeatButton(render(e).row)!.disabled).toBe(false);
  });
});

describe("diary table + button", () => {
  const plus = (row: Element) => row.querySelector<HTMLButtonElement>("[data-entry-increment]");

  it("shows on today's entries what it adds, first in the row, and adds it", () => {
    const e = entry();
    const onIncrement = vi.fn();
    const { row } = render(e, { today: true, onIncrement });
    const button = plus(row)!;
    expect(button.textContent).toBe("+40 g");
    expect(button.getAttribute("aria-label")).toBe(`Add 40 g to ${e.displayName}`);
    expect(row.querySelector(".row-actions button")).toBe(button);
    button.click();
    expect(onIncrement).toHaveBeenCalledWith(e);
  });

  it("is not on another day, another app's entry, or a deleted one", () => {
    const e = entry();
    const onIncrement = vi.fn();
    expect(plus(render(e, { onIncrement }).row)).toBeNull();
    expect(plus(render({ ...e, own: false, increment: undefined } as DiaryEntry, { today: true, onIncrement }).row)).toBeNull();
    expect(plus(render(e, { today: true, onIncrement, entries: [], deleted: [e] }).row)).toBeNull();
  });

  it("is disabled offline and while the row is busy", () => {
    const e = entry();
    expect(plus(render(e, { today: true, onIncrement: vi.fn(), offline: true }).row)!.disabled).toBe(true);
    expect(plus(render(e, { today: true, onIncrement: vi.fn(), busy: new Map([[e.id, "adding…"]]) }).row)!.disabled).toBe(true);
  });
});

describe("diary table Amount", () => {
  const amountCell = (row: Element) => row.querySelectorAll("td")[2]!;
  const savedMeal = () => {
    const id = newEntryId({ source: "meal", id: "m1" });
    const point = buildPortionPoint({ name: "Porridge", profile: { energyKcal: 300, nutrients: { protein: 10 } }, time: new Date("2026-11-07T01:00:00Z") }, id);
    return toDiaryEntry(point)!;
  };

  it("shows the serving an entry was logged with", () => {
    expect(amountCell(render(entry()).row).textContent).toBe("40 g");
  });

  it("marks a saved meal, which has no amount of its own, instead of showing it as missing", () => {
    const e = savedMeal();
    expect(e.amount).toBeUndefined();
    const mark = amountCell(render(e).row).querySelector(".from-meal")!;
    expect(mark.textContent).toBe("saved meal");
    expect(mark.getAttribute("title")).toContain("saved meal");
    expect(amountText(e)).toBe("saved meal");
  });

  it("still shows a dash for an entry that recorded no amount", () => {
    const e: DiaryEntry = { ...entry(), amount: undefined } as DiaryEntry;
    const prep: DiaryEntry = { ...e, ref: { source: "prep", id: "p1" } };
    for (const x of [e, prep, { ...e, own: false, ref: undefined } as DiaryEntry]) {
      const cell = amountCell(render(x).row);
      expect(cell.textContent).toBe("–");
      expect(cell.querySelector(".from-meal")).toBeNull();
      expect(amountText(x)).toBe("–");
    }
  });
});
