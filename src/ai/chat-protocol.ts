/**
 * What the chat's on-device model may answer, and how the app describes the diary to it (DR-41).
 *
 * The model answers every prompt with one action as JSON, held to a schema with `responseConstraint`. The Prompt API's
 * own tool calls are not used: they are specified, but not in every Chrome that runs the model, and a schema is. The app runs the action and sends back what it found, until the model replies or proposes a change.
 *
 * The model never sees an entry's ID or a food's database reference. It names them by short handles (`E1`, `F1`) that
 * the app hands out, and the schema only allows handles the app has handed out.
 */

import { addCivilDays, dayLabel, formatCivilDate } from "../core/time";
import { isCivilDate } from "../core/day-url";
import { kcalToKj, type NutrientProfile } from "../core/nutrients";
import { formatAmount, formatNumber } from "../core/units";
import { SOURCE_TAGS } from "../core/food";
import type { FoodSummary } from "../core/food-summary";
import { isSavedMeal, mealLabel, type DiaryEntry } from "../health/mapping";
import type { MealType } from "../health/types";

export const CHAT_ACTIONS = ["reply", "read_day", "read_days", "search_food", "log_food", "change_entry", "delete_entry"] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

/** The meals the model may name. `none` is no meal; "" (in a change) leaves the meal as it is. */
export const CHAT_MEALS = ["breakfast", "lunch", "dinner", "snack", "none"] as const;
type ChatMeal = (typeof CHAT_MEALS)[number];

const MEAL_TYPE: Readonly<Record<Exclude<ChatMeal, "none">, MealType>> = {
  breakfast: "BREAKFAST",
  lunch: "LUNCH",
  dinner: "DINNER",
  snack: "SNACK",
};

/** One answer from the model. Every field is a string, "" when the action does not use it. */
export interface ChatStep {
  readonly action: ChatAction;
  /** What to say to the user: the reply, or a note shown above a proposed change. */
  readonly text: string;
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly query: string;
  readonly food: string;
  readonly entry: string;
  /** An amount as the user would type it ("2 slices", "150 g"), read by the app's own rules (DR-25). */
  readonly amount: string;
  readonly meal: string;
}

const FIELDS = ["text", "day", "from", "to", "query", "food", "entry", "amount", "meal"] as const;

/**
 * The schema for the next answer. Every field is required, with "" for nothing, because browsers may not support
 * optional properties or unions in a constraint (as in `amountSchema`). Handles are limited to those handed out.
 */
export function stepSchema(entryHandles: readonly string[], foodHandles: readonly string[]): Record<string, unknown> {
  const text = { type: "string" };
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: [...CHAT_ACTIONS] },
      text,
      day: text,
      from: text,
      to: text,
      query: text,
      food: { type: "string", enum: [...foodHandles, ""] },
      entry: { type: "string", enum: [...entryHandles, ""] },
      amount: text,
      meal: { type: "string", enum: [...CHAT_MEALS, ""] },
    },
    required: ["action", ...FIELDS],
    additionalProperties: false,
  };
}

export type StepParse = { readonly ok: true; readonly step: ChatStep } | { readonly ok: false; readonly reason: string };

/** Reads the model's answer. A browser may not enforce the schema, so nothing in it is assumed. */
export function parseStep(raw: string): StepParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "The answer was not JSON." };
  }
  if (typeof value !== "object" || value === null) return { ok: false, reason: "The answer was not a JSON object." };
  const record = value as Record<string, unknown>;
  const action = record["action"];
  if (typeof action !== "string" || !(CHAT_ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: `"action" must be one of ${CHAT_ACTIONS.join(", ")}.` };
  const field = (name: (typeof FIELDS)[number]) => {
    const v = record[name];
    return typeof v === "string" ? v.trim() : "";
  };
  const step: ChatStep = {
    action: action as ChatAction,
    text: field("text"),
    day: field("day"),
    from: field("from"),
    to: field("to"),
    query: field("query"),
    food: field("food").toUpperCase(),
    entry: field("entry").toUpperCase(),
    amount: field("amount"),
    meal: field("meal").toLowerCase(),
  };
  const missing = (name: string) => ({ ok: false as const, reason: `${step.action} needs "${name}".` });
  switch (step.action) {
    case "reply":
      if (!step.text) return missing("text");
      break;
    case "read_day":
      if (!step.day) return missing("day");
      break;
    case "read_days":
      if (!step.from) return missing("from");
      if (!step.to) return missing("to");
      break;
    case "search_food":
      if (!step.query) return missing("query");
      break;
    case "log_food":
      if (!step.food) return missing("food");
      if (!step.amount) return missing("amount");
      break;
    case "change_entry":
      if (!step.entry) return missing("entry");
      if (!step.amount && !step.meal && !step.day) return { ok: false, reason: 'change_entry needs at least one of "amount", "meal" or "day".' };
      break;
    case "delete_entry":
      if (!step.entry) return missing("entry");
      break;
  }
  if (step.meal && !(CHAT_MEALS as readonly string[]).includes(step.meal)) return { ok: false, reason: `"meal" must be one of ${CHAT_MEALS.join(", ")}.` };
  return { ok: true, step };
}

export type DayParse = { readonly ok: true; readonly day: string } | { readonly ok: false; readonly reason: string };

/** A day the model named: "today", "yesterday" or YYYY-MM-DD, and never after today, since there is no diary there. */
export function resolveDay(text: string, today: string): DayParse {
  const t = text.trim().toLowerCase();
  const day = t === "today" ? today : t === "yesterday" ? addCivilDays(today, -1) : t;
  if (!isCivilDate(day)) return { ok: false, reason: `"${text}" is not a day. Use today, yesterday or YYYY-MM-DD.` };
  if (day > today) return { ok: false, reason: `${day} is after today, and the diary has nothing after today.` };
  return { ok: true, day };
}

/** The meal the model named. Undefined for none. */
export function mealOf(meal: string): MealType | undefined {
  return meal && meal !== "none" ? MEAL_TYPE[meal as Exclude<ChatMeal, "none">] : undefined;
}

/**
 * The short names the model uses for entries and foods. The same entry or food keeps its handle for the whole chat,
 * and a handle always means the entry or food as the app last described it.
 */
export class ChatHandles {
  private readonly entries = new Map<string, DiaryEntry>();
  private readonly entryById = new Map<string, string>();
  private readonly foods = new Map<string, FoodSummary>();
  private readonly foodByRef = new Map<string, string>();
  /** Handles handed out so far. Counted, not taken from the maps' sizes, so that a forgotten handle is never reused. */
  private entryCount = 0;
  private foodCount = 0;

  entryHandle(entry: DiaryEntry): string {
    let handle = this.entryById.get(entry.id);
    if (!handle) {
      handle = `E${++this.entryCount}`;
      this.entryById.set(entry.id, handle);
    }
    this.entries.set(handle, entry);
    return handle;
  }

  /** The handle an entry has now, without handing one out. Undefined if it has none, or it was taken back. */
  handleOf(id: string): string | undefined {
    return this.entryById.get(id);
  }

  foodHandle(food: FoodSummary): string {
    const key = `${food.ref.source}:${food.ref.id}`;
    let handle = this.foodByRef.get(key);
    if (!handle) {
      handle = `F${++this.foodCount}`;
      this.foodByRef.set(key, handle);
    }
    this.foods.set(handle, food);
    return handle;
  }

  entry(handle: string): DiaryEntry | undefined {
    return this.entries.get(handle);
  }

  food(handle: string): FoodSummary | undefined {
    return this.foods.get(handle);
  }

  /**
   * Takes back an entry's handle once it has been edited or deleted: the entry has gone (an edit writes a new one), so
   * the handle must not keep offering the old values. The schema stops allowing it, and reading the day gives the new
   * entry a new handle.
   */
  forgetEntry(id: string): void {
    const handle = this.entryById.get(id);
    if (!handle) return;
    this.entryById.delete(id);
    this.entries.delete(handle);
  }

  entryHandles(): string[] {
    return [...this.entries.keys()];
  }

  foodHandles(): string[] {
    return [...this.foods.keys()];
  }
}

export type EnergyUnitName = "kcal" | "kj";

function energyText(kcal: number, unit: EnergyUnitName): string {
  return unit === "kj" ? `${formatNumber(kcalToKj(kcal), 0)} kJ` : `${formatNumber(kcal, 0)} kcal`;
}

const grams = (g: number | undefined) => (g === undefined ? "not recorded" : `${formatNumber(g, 1)} g`);

/**
 * Whether an entry states its energy. The diary reads a missing value as 0 kcal, so without this an entry another app
 * logged with no energy would read as one with none in it.
 */
export function energyRecorded(e: DiaryEntry): boolean {
  return e.point.nutritionLog?.energy !== undefined;
}

/** What an entry leaves out of energy, protein, carbs and fat. */
function missingOf(e: DiaryEntry): string[] {
  const n = e.profile.nutrients;
  return [!energyRecorded(e) && "energy", n.protein === undefined && "protein", n.carbohydrates === undefined && "carbs", n.fat === undefined && "fat"].filter((x): x is string => Boolean(x));
}

/** An entry's energy and main nutrients, saying "not recorded" where it has no value rather than 0. */
function entryProfileText(e: DiaryEntry, unit: EnergyUnitName): string {
  const n = e.profile.nutrients;
  const energy = energyRecorded(e) ? energyText(e.profile.energyKcal, unit) : "energy not recorded";
  return `${energy} (protein ${grams(n.protein)}, carbs ${grams(n.carbohydrates)}, fat ${grams(n.fat)})`;
}

/** Energy and the three main nutrients, e.g. "156 kcal (protein 4 g, carbs 24 g, fat 2 g)". */
export function profileText(p: NutrientProfile, unit: EnergyUnitName): string {
  const n = p.nutrients;
  return `${energyText(p.energyKcal, unit)} (protein ${grams(n.protein)}, carbs ${grams(n.carbohydrates)}, fat ${grams(n.fat)})`;
}

/** A clock time such as "8:05 am". Fixed English wording, whatever the locale. */
export function clockTime(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

/** A day for people and the model: "today", "yesterday", or the date written out. */
export function dayWords(day: string, today: string): string {
  const label = dayLabel(day, today);
  return label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;
}

/** Who logged an entry, and whether the app can change it. */
function ownerText(e: DiaryEntry): string {
  if (!e.own) return `logged by ${e.sourceLabel ?? "another app"}, cannot be changed here`;
  if (e.ref?.source === "prep") return "a meal prep share, can be deleted but not changed";
  return "logged by this app";
}

/** One line about an entry for the model. Its handle stands in for the ID, which the model never sees. */
export function describeEntry(handle: string, e: DiaryEntry, unit: EnergyUnitName): string {
  const meal = e.mealType === "MEAL_TYPE_UNSPECIFIED" ? "no meal" : mealLabel(e.mealType).toLowerCase();
  const missing = missingOf(e);
  const complete = missing.length ? `incomplete, not recorded: ${missing.join(", ")}` : "complete";
  // A saved meal has no amount of its own, which is not something missing (DR-44).
  const amount = e.amount ?? (isSavedMeal(e) ? "a saved meal, logged as one entry with no amount of its own" : "no amount");
  return `${handle}: ${e.displayName}, ${amount}, ${meal}, ${entryProfileText(e, unit)}, ${complete}, at ${clockTime(e.start)}, ${ownerText(e)}`;
}

/**
 * Says which entries a total leaves out because they record no value for it, if any: energy, protein, carbs or fat.
 * Without it, a total with a gap reads as complete.
 */
function totalGaps(entries: readonly DiaryEntry[], where = ""): string {
  const counts = new Map<string, number>();
  for (const e of entries) for (const part of missingOf(e)) counts.set(part, (counts.get(part) ?? 0) + 1);
  if (counts.size === 0) return "";
  const parts = [...counts].map(([part, n]) => `${part} of ${n} ${n === 1 ? "entry" : "entries"}${where}`);
  return ` (leaves out what is not recorded: ${parts.join(", ")})`;
}

function totalOf(entries: readonly DiaryEntry[]): NutrientProfile {
  let energyKcal = 0;
  const sums: Record<string, number | undefined> = {};
  for (const e of entries) {
    energyKcal += e.profile.energyKcal;
    for (const key of ["protein", "carbohydrates", "fat"] as const) {
      const v = e.profile.nutrients[key];
      if (v !== undefined) sums[key] = (sums[key] ?? 0) + v;
    }
  }
  return { energyKcal, nutrients: sums };
}

/** A day's diary for the model: every entry with its handle, then the total, so the model never adds anything up. */
export function describeDay(day: string, today: string, entries: readonly DiaryEntry[], handles: ChatHandles, unit: EnergyUnitName): string {
  const head = `${formatCivilDate(day)}${day === today ? " (today)" : day === addCivilDays(today, -1) ? " (yesterday)" : ""}`;
  if (entries.length === 0) return `${head}: nothing logged.`;
  const lines = entries.map((e) => describeEntry(handles.entryHandle(e), e, unit));
  return [`${head}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`, ...lines, `Total: ${profileText(totalOf(entries), unit)}${totalGaps(entries)}`].join("\n");
}

/** Totals for several days, with the average over the days that have entries. */
export function describeDays(days: readonly { readonly day: string; readonly entries: readonly DiaryEntry[] }[], unit: EnergyUnitName): string {
  const lines = days.map(({ day, entries }) => (entries.length ? `${formatCivilDate(day)}: ${profileText(totalOf(entries), unit)}, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}${totalGaps(entries)}` : `${formatCivilDate(day)}: nothing logged`));
  const logged = days.filter((d) => d.entries.length > 0);
  if (logged.length > 0) {
    const loggedEntries = logged.flatMap((d) => d.entries);
    const all = totalOf(loggedEntries);
    const factor = 1 / logged.length;
    const average: NutrientProfile = {
      energyKcal: all.energyKcal * factor,
      nutrients: Object.fromEntries(Object.entries(all.nutrients).map(([k, v]) => [k, v === undefined ? v : v * factor])),
    };
    lines.push(`Average over the ${logged.length} ${logged.length === 1 ? "day" : "days"} with entries: ${profileText(average, unit)}${totalGaps(loggedEntries, " across the range")}`);
  }
  return lines.join("\n");
}

/** One line about a search result for the model. */
export function describeFood(handle: string, f: FoodSummary, unit: EnergyUnitName): string {
  const parts = [`${handle}: ${f.name}`];
  if (f.brand) parts.push(`brand ${f.brand}`);
  parts.push(`${energyText(f.kcalPer100, unit)} per 100 ${f.basis}`);
  if (f.serving) parts.push(`serving "${f.serving.label}" (${formatAmount(f.serving.amount)} ${f.serving.unit})`);
  parts.push(`from ${SOURCE_TAGS[f.ref.source]}`);
  return parts.join(", ");
}

const EXAMPLE_TODAY = "2026-03-04";

const json = (step: Partial<ChatStep> & { action: ChatAction }) => JSON.stringify({ action: step.action, ...Object.fromEntries(FIELDS.map((f) => [f, step[f] ?? ""])) });

/** How a message in a chat opened on an entry starts. The worked example uses it too, so the two can't drift apart. */
export const FOCUS_PREFIX = "This chat is about";

/** The line that starts each message in a chat opened on an entry. */
export function focusPrompt(handle: string, entry: DiaryEntry, unit: EnergyUnitName): string {
  return `${FOCUS_PREFIX} ${describeEntry(handle, entry, unit)}`;
}

export interface ChatContext {
  /** YYYY-MM-DD. */
  readonly today: string;
  /** The day the diary shows. */
  readonly viewed: string;
  readonly energyUnit: EnergyUnitName;
  /** The entry the chat was opened on, with its handle, if any. */
  readonly focus?: { readonly handle: string; readonly entry: DiaryEntry };
}

/** The system prompt and a short worked example, sent once per chat. Only the system prompt names the user's diary. */
export function chatInstructions(ctx: ChatContext): { readonly role: "system" | "user" | "assistant"; readonly content: string }[] {
  const week = Array.from({ length: 7 }, (_, i) => addCivilDays(ctx.today, -i))
    .map((d, i) => `${d} is ${formatCivilDate(d).split(",")[0]}${i === 0 ? " (today)" : i === 1 ? " (yesterday)" : ""}`)
    .join("; ");
  const system = [
    "You are the assistant in a food diary app. You answer questions about the user's nutrition diary, and log, change and delete diary entries for them.",
    "Answer every message with exactly one action, as JSON. Use \"\" for every field the action does not use.",
    "Actions:",
    '- reply: say "text" to the user. This ends your turn.',
    '- read_day: read the diary for "day" (today, yesterday or YYYY-MM-DD). Each entry gets a handle such as E1.',
    '- read_days: read the totals for each day from "from" to "to", at most 14 days.',
    '- search_food: search the food database for "query", a short food name. Each result gets a handle such as F1.',
    '- log_food: propose logging "food" (a handle from search_food) with "amount" (such as "2 slices" or "150 g"), on "day", with "meal".',
    '- change_entry: propose changing "entry" (a handle from read_day): any of a new "amount", "meal" or "day". Leave the others "".',
    '- delete_entry: propose deleting "entry".',
    "Rules:",
    "- Never make up entries, foods, numbers or totals. Read them first, and quote the numbers the app gives you.",
    '- "not recorded" means the entry has no value for it, which is not the same as 0. An entry is complete when energy, protein, carbs and fat are all recorded.',
    "- To log a food, search_food first, then log_food with the handle of the result that fits best. If none fits, reply and ask.",
    "- The amount must say a unit, as the user would type it. Use only units the app lists for the food.",
    "- The app shows each proposed change to the user, who accepts or rejects it. Then you are told what happened. Propose one change at a time.",
    "- Only entries logged by this app can be changed or deleted.",
    "- Keep replies short and plain.",
    `Energy is in ${ctx.energyUnit === "kj" ? "kJ" : "kcal"}.`,
    `Today is ${formatCivilDate(ctx.today)}. Days: ${week}.`,
    `The diary on the screen shows ${ctx.viewed === ctx.today ? "today" : formatCivilDate(ctx.viewed)}.`,
  ];
  if (ctx.focus) {
    const h = ctx.focus.handle;
    system.push(
      `The user opened this chat from one entry, ${h}. "This", "it" and "this entry" mean ${h}, not the whole day. ` +
        `Answer questions about ${h} from its line below, which each message repeats while the entry is unchanged, without read_day:\n${describeEntry(h, ctx.focus.entry, ctx.energyUnit)}`,
    );
  }
  return [
    { role: "system", content: system.join("\n") },
    // A worked example on a made-up day, so that its handles and numbers can't be mistaken for the user's.
    { role: "user", content: `(Example, not the user's diary. Today is ${formatCivilDate(EXAMPLE_TODAY)}.) Log a banana for breakfast` },
    { role: "assistant", content: json({ action: "search_food", query: "banana" }) },
    { role: "user", content: 'Result of search_food:\nX1: Banana, raw, 89 kcal per 100 g, serving "1 medium (118 g)" (118 g), from FNDDS' },
    { role: "assistant", content: json({ action: "log_food", food: "X1", amount: "1 medium", day: "today", meal: "breakfast" }) },
    { role: "user", content: "The user accepted, and it was done: logged Banana, raw, 118 g, breakfast, today." },
    { role: "assistant", content: json({ action: "reply", text: "Logged a banana for breakfast." }) },
    // A second example: a question about the entry the chat was opened on is answered from its line, without reading the day.
    {
      role: "user",
      content:
        `(Example, not the user's diary.) ${FOCUS_PREFIX} X7: Toast, 2 slices, breakfast, energy not recorded (protein 6 g, carbs 30 g, fat 2 g), incomplete, not recorded: energy, at 7:40 am, logged by Google Health app, cannot be changed here\nUser: Is this entry complete?`,
    },
    { role: "assistant", content: json({ action: "reply", text: "No. The toast at breakfast has no energy recorded, so the day's energy total leaves it out. Its protein, carbs and fat are recorded." }) },
    { role: "user", content: "(End of examples.)" },
    { role: "assistant", content: json({ action: "reply", text: "Ready." }) },
  ];
}
