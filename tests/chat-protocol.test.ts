import { describe, expect, it } from "vitest";
import { ChatHandles, chatInstructions, describeDay, describeDays, describeEntry, mealOf, parseStep, readableText, resolveDay, stepSchema } from "../src/ai/chat-protocol";
import { summarise } from "../src/core/food-summary";
import type { DiaryEntry } from "../src/health/mapping";
import { bread, entryOf, oats, TODAY, withoutEnergy } from "./chat-fixtures";

const step = (fields: Record<string, string>) => JSON.stringify({ text: "", day: "", from: "", to: "", query: "", food: "", entry: "", amount: "", meal: "", ...fields });

describe("parseStep", () => {
  it("reads a complete answer", () => {
    expect(parseStep(step({ action: "read_day", day: "today" }))).toEqual({ ok: true, step: expect.objectContaining({ action: "read_day", day: "today" }) });
  });

  it("fills fields a browser left out, since it may not enforce the schema", () => {
    const parsed = parseStep(JSON.stringify({ action: "reply", text: "Hi" }));
    expect(parsed).toEqual({ ok: true, step: expect.objectContaining({ action: "reply", text: "Hi", entry: "", amount: "" }) });
  });

  it("refuses what is not one action", () => {
    expect(parseStep("not json").ok).toBe(false);
    expect(parseStep("[1]").ok).toBe(false);
    expect(parseStep(step({ action: "drop_tables" })).ok).toBe(false);
  });

  it("says which field an action is missing", () => {
    expect(parseStep(step({ action: "log_food", food: "F1" }))).toEqual({ ok: false, reason: 'log_food needs "amount".' });
    expect(parseStep(step({ action: "change_entry", entry: "E1" })).ok).toBe(false);
    expect(parseStep(step({ action: "reply" })).ok).toBe(false);
  });

  it("refuses a meal the app doesn't have", () => {
    expect(parseStep(step({ action: "log_food", food: "F1", amount: "1 slice", meal: "brunch" })).ok).toBe(false);
  });

  it("accepts handles in any case", () => {
    const parsed = parseStep(step({ action: "delete_entry", entry: "e2" }));
    expect(parsed.ok && parsed.step.entry).toBe("E2");
  });
});

describe("resolveDay", () => {
  it("reads today, yesterday and dates", () => {
    expect(resolveDay("today", TODAY)).toEqual({ ok: true, day: TODAY });
    expect(resolveDay("Yesterday", TODAY)).toEqual({ ok: true, day: "2026-11-18" });
    expect(resolveDay("2026-11-01", TODAY)).toEqual({ ok: true, day: "2026-11-01" });
  });

  it("refuses days after today and what isn't a day", () => {
    expect(resolveDay("2026-11-20", TODAY).ok).toBe(false);
    expect(resolveDay("tomorrow", TODAY).ok).toBe(false);
    expect(resolveDay("2026-02-30", TODAY).ok).toBe(false);
  });
});

describe("mealOf", () => {
  it("maps the model's meals, and none to no meal", () => {
    expect(mealOf("lunch")).toBe("LUNCH");
    expect(mealOf("none")).toBeUndefined();
    expect(mealOf("")).toBeUndefined();
  });
});

describe("stepSchema", () => {
  it("only allows the handles handed out, or none", () => {
    const schema = stepSchema(["E1", "E2"], []) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties["entry"]!.enum).toEqual(["E1", "E2", ""]);
    expect(schema.properties["food"]!.enum).toEqual([""]);
    expect(schema.required).toContain("amount");
  });
});

describe("readableText", () => {
  const today = TODAY;
  const sweets = entryOf(oats, 40, "g", `${TODAY}T16:10:00`, { mealType: "SNACK", id: "e-abc-aa11-off-123" });
  const earlier = entryOf(bread, 1, "portion:slice (35 g)", "2026-11-18T08:10:00", { id: "e-abc-bb22-fnds-555" });

  it("turns entry handles into the entry as the diary shows it", () => {
    const handles = new ChatHandles();
    handles.entryHandle(sweets);
    handles.entryHandle(earlier);
    expect(readableText("The entries E1 and E2 are sweet.", handles, today)).toBe("The entries “Oats”, 40 g, at 4:10 pm and “Bread, wholemeal”, 35 g, yesterday at 8:10 am are sweet.");
  });

  it("turns food handles into the food's name", () => {
    const handles = new ChatHandles();
    handles.foodHandle(summarise(bread));
    expect(readableText("F1 fits best.", handles, today)).toBe("“Bread, wholemeal” fits best.");
  });

  it("still names an entry whose handle was taken back after a change", () => {
    const handles = new ChatHandles();
    handles.entryHandle(sweets);
    handles.forgetEntry(sweets.id);
    expect(readableText("I deleted E1.", handles, today)).toBe("I deleted “Oats”, 40 g, at 4:10 pm.");
  });

  it("never shows a made-up handle, and leaves other words alone", () => {
    const handles = new ChatHandles();
    expect(readableText("E9 and F4 are sweet, and so is DE1 or E1x.", handles, today)).toBe("an entry and a food are sweet, and so is DE1 or E1x.");
  });
});

describe("ChatHandles", () => {
  it("keeps one handle per entry for the whole chat", () => {
    const handles = new ChatHandles();
    const a = entryOf(oats, 40, "g", `${TODAY}T08:00:00`, { id: "e-abc-aa11-off-123" });
    const b = entryOf(bread, 1, "portion:slice (35 g)", `${TODAY}T09:00:00`, { id: "e-abc-bb22-fnds-555" });
    expect(handles.entryHandle(a)).toBe("E1");
    expect(handles.entryHandle(b)).toBe("E2");
    expect(handles.entryHandle(a)).toBe("E1");
    expect(handles.entry("E2")).toBe(b);
    expect(handles.entry("E3")).toBeUndefined();
  });

  it("takes back an entry's handle, and never hands it out again", () => {
    const handles = new ChatHandles();
    const a = entryOf(oats, 40, "g", `${TODAY}T08:00:00`, { id: "e-abc-aa11-off-123" });
    const b = entryOf(bread, 1, "portion:slice (35 g)", `${TODAY}T09:00:00`, { id: "e-abc-bb22-fnds-555" });
    handles.entryHandle(a);
    handles.forgetEntry(a.id);
    expect(handles.entry("E1")).toBeUndefined();
    expect(handles.entryHandles()).toEqual([]);
    expect(handles.entryHandle(b)).toBe("E2");
  });
});

describe("describing the diary", () => {
  const breakfast = entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { mealType: "BREAKFAST" });

  it("names an entry by what the user sees, never its ID", () => {
    const line = describeEntry("E1", breakfast, "kcal");
    expect(line).toBe("E1: Oats, 40 g, breakfast, 160 kcal (protein 4 g, carbs 24 g, fat 2 g), complete, at 8:05 am, logged by this app");
    expect(line).not.toContain(breakfast.id);
  });

  it("says energy is not recorded rather than 0, and that the entry is incomplete", () => {
    const line = describeEntry("E1", withoutEnergy(breakfast), "kcal");
    expect(line).toBe("E1: Oats, 40 g, breakfast, energy not recorded (protein 4 g, carbs 24 g, fat 2 g), incomplete, not recorded: energy, at 8:05 am, logged by this app");
    expect(line).not.toContain("0 kcal");
  });

  it("says which entries a day's total leaves out, for energy and for each nutrient", () => {
    const noProtein = entryOf({ ...bread, per100: { energyKcal: 250, nutrients: { fat: 3, carbohydrates: 45 } } }, 1, "portion:slice (35 g)", `${TODAY}T08:20:00`, { id: "e-abc-cc33-fnds-555" });
    const toast = withoutEnergy(entryOf(bread, 1, "portion:slice (35 g)", `${TODAY}T08:10:00`, { id: "e-abc-bb22-fnds-555" }));
    const text = describeDay(TODAY, TODAY, [breakfast, toast, noProtein], new ChatHandles(), "kcal");
    expect(text).toMatch(/\nTotal: .* \(leaves out what is not recorded: energy of 1 entry, protein of 1 entry\)$/);
  });

  it("says what a range's average leaves out", () => {
    const toast = withoutEnergy(entryOf(bread, 1, "portion:slice (35 g)", `${TODAY}T08:10:00`, { id: "e-abc-bb22-fnds-555" }));
    const text = describeDays([{ day: TODAY, entries: [breakfast, toast] }], "kcal");
    expect(text).toMatch(/Average over the 1 day with entries: .* \(leaves out what is not recorded: energy of 1 entry across the range\)$/);
  });

  it("says a saved meal has no amount of its own, rather than none recorded", () => {
    const meal = { ...breakfast, displayName: "Porridge", amount: undefined, ref: { source: "meal", id: "m1" } } as DiaryEntry;
    expect(describeEntry("E1", meal, "kcal")).toContain("E1: Porridge, a saved meal, logged as one entry with no amount of its own, breakfast,");
    expect(describeEntry("E1", { ...meal, ref: undefined } as DiaryEntry, "kcal")).toContain("E1: Porridge, no amount, breakfast,");
  });

  it("says when another app logged an entry", () => {
    const other = entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { writer: "someone-else" });
    expect(describeEntry("E1", other, "kcal")).toContain("logged by com.example.other, cannot be changed here");
  });

  it("adds up a day, so the model doesn't have to", () => {
    const toast = entryOf(bread, 2, "portion:slice (35 g)", `${TODAY}T08:10:00`, { mealType: "BREAKFAST", id: "e-abc-bb22-fnds-555" });
    const text = describeDay(TODAY, TODAY, [breakfast, toast], new ChatHandles(), "kcal");
    expect(text).toContain("Thursday, 19 Nov 2026 (today): 2 entries");
    expect(text).toContain("E2: Bread, wholemeal");
    expect(text).toContain("Total: 335 kcal (protein 10.3 g, carbs 55.5 g, fat 4.1 g)");
  });

  it("says when nothing is logged", () => {
    expect(describeDay("2026-11-18", TODAY, [], new ChatHandles(), "kcal")).toBe("Wednesday, 18 Nov 2026 (yesterday): nothing logged.");
  });

  it("averages days over those with entries", () => {
    const text = describeDays(
      [
        { day: "2026-11-18", entries: [] },
        { day: TODAY, entries: [breakfast] },
      ],
      "kj",
    );
    expect(text).toContain("Wednesday, 18 Nov 2026: nothing logged");
    expect(text).toContain("Average over the 1 day with entries: 669 kJ");
  });
});

describe("chatInstructions", () => {
  it("tells the model the date and the entry the chat was opened on", () => {
    const entry = entryOf(oats, 40, "g", `${TODAY}T08:05:00`);
    const [system] = chatInstructions({ today: TODAY, viewed: "2026-11-17", energyUnit: "kcal", focus: { handle: "E1", entry } });
    expect(system!.content).toContain("Today is Thursday, 19 Nov 2026.");
    expect(system!.content).toContain("2026-11-18 is Wednesday (yesterday)");
    expect(system!.content).toContain("The diary on the screen shows Tuesday, 17 Nov 2026.");
    expect(system!.content).toContain('"This", "it" and "this entry" mean E1, not the whole day.');
    expect(system!.content).toContain("E1: Oats, 40 g");
  });
});
