// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { FoodItem, FoodRef } from "../src/core/food";
import type { FoodCatalog } from "../src/food/catalog";
import { AS_LOGGED_UNIT, buildNutritionLogPoint, toDiaryEntry, type DiaryEntry, type EntryEdit } from "../src/health/mapping";
import type { DataPoint } from "../src/health/types";
import { createRowEditor } from "../src/ui/row-editor";

const UNIT_G = "users/me/dataTypes/food-measurement-unit/dataPoints/g";
const unitNames = new Map([[UNIT_G, "gram"]]);
const oats: FoodItem = {
  ref: { source: "off", id: "123" },
  name: "Oats",
  basis: "g",
  per100: { energyKcal: 400, nutrients: { protein: 10, fat: 5, carbohydrates: 60 } },
  portions: [{ name: "1/2 cup", amount: 40, unit: "g" }],
};

/** An entry this app wrote, then changed the way Google might return it. */
function entry(change: (p: DataPoint) => void = () => {}, id = "e-abc-ab12-off-123"): DiaryEntry {
  const point = buildNutritionLogPoint({ food: oats, quantity: 40, unit: "g", time: new Date("2026-11-07T01:00:00Z") }, { id, servingUnits: { g: UNIT_G } });
  change(point);
  return toDiaryEntry(point, { unitNames })!;
}

/** A catalogue whose answer arrives when the test says so. */
function catalog(found: FoodItem | undefined) {
  let release: () => void = () => {};
  const ready = new Promise<void>((r) => (release = r));
  const get = vi.fn(async (_ref: FoodRef) => {
    await ready;
    return found;
  });
  return { catalog: { label: "test", search: async () => [], get } as unknown as FoodCatalog, release, get };
}

function open(e: DiaryEntry, cat: FoodCatalog) {
  const onSave = vi.fn<(edit: EntryEdit) => void>();
  const editor = createRowEditor({ catalog: cat, entry: e, unitNames, offline: false, onSave, onCancel: vi.fn() });
  const row = document.createElement("tr");
  for (const part of [editor.meal, editor.amount, editor.energy, editor.actions]) {
    const cell = document.createElement("td");
    cell.append(part);
    row.append(cell);
  }
  document.body.replaceChildren(row);
  const qty = editor.amount.querySelector<HTMLInputElement>("input")!;
  const unit = editor.amount.querySelector<HTMLSelectElement>("select")!;
  const save = editor.actions.querySelector<HTMLButtonElement>(".edit-save")!;
  const cancel = editor.actions.querySelector<HTMLButtonElement>(".edit-cancel")!;
  const type = (text: string) => {
    qty.value = text;
    qty.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { editor, onSave, qty, unit, save, cancel, type };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const noAmount = (p: DataPoint) => {
  delete p.nutritionLog!.serving;
};

describe("row editor", () => {
  it("shows Save and Cancel as words, never the delete symbol", () => {
    const { save, cancel, editor } = open(entry(), catalog(oats).catalog);
    expect(save.textContent).toBe("Save");
    expect(cancel.textContent).toBe("Cancel");
    expect(editor.actions.textContent).not.toContain("✕");
  });

  it("offers an entry with no readable amount and no food as 1 × this entry", async () => {
    const e = entry(noAmount, "1234567890");
    expect(e.ref).toBeUndefined();
    const { qty, unit, save, type, onSave } = open(e, catalog(undefined).catalog);
    expect(qty.value).toBe("1");
    expect(unit.value).toBe(AS_LOGGED_UNIT);
    expect([...unit.options].map((o) => o.value)).toEqual([AS_LOGGED_UNIT]);
    expect(save.disabled).toBe(true);
    type("2");
    expect(save.disabled).toBe(false);
    save.click();
    expect(onSave).toHaveBeenCalledWith({ amount: { quantity: 2, unit: AS_LOGGED_UNIT } });
  });

  it("treats an empty multiple as no change, so the meal alone can still be saved", () => {
    const { save, type, editor } = open(entry(noAmount, "1234567890"), catalog(undefined).catalog);
    type("");
    expect(save.disabled).toBe(true);
    const meal = editor.meal as HTMLSelectElement;
    meal.value = "LUNCH";
    meal.dispatchEvent(new Event("input", { bubbles: true }));
    expect(save.disabled).toBe(false);
  });

  it("switches to the food's units when it arrives, if the user has not typed", async () => {
    const cat = catalog(oats);
    const { qty, unit } = open(entry(noAmount), cat.catalog);
    expect(unit.value).toBe(AS_LOGGED_UNIT);
    cat.release();
    await settle();
    expect(unit.value).toBe("g");
    expect(qty.value).toBe("");
  });

  it("keeps a multiple the user started typing when the food arrives, even one that reads 1", async () => {
    const cat = catalog(oats);
    const { qty, unit, type } = open(entry(noAmount), cat.catalog);
    type("1");
    cat.release();
    await settle();
    expect(qty.value).toBe("1");
    expect(unit.value).toBe(AS_LOGGED_UNIT);
    type("15");
    expect(unit.value).toBe(AS_LOGGED_UNIT);
  });

  it("keeps the logged amount and units for an entry that states one", async () => {
    const cat = catalog(oats);
    const { qty, unit, save } = open(entry(), cat.catalog);
    expect(qty.value).toBe("40");
    expect(unit.value).toBe("g");
    cat.release();
    await settle();
    expect([...unit.options].map((o) => o.textContent)).toContain("× 1/2 cup");
    expect(save.disabled).toBe(true);
  });
});
