/**
 * Runs the chat model's actions (DR-41). Reading and searching happen straight away. A log, change or delete is only
 * a proposal: the user sees it in full and accepts or rejects it, and only the app's own code writes to the diary.
 *
 * Amounts go through the same rules as typed ones (DR-25), so the model cannot decide a unit the rules would not.
 */

import { readAmount } from "../core/amount-text";
import { canReload, type FoodItem } from "../core/food";
import { copiedEntryId, newEntryId } from "../core/ids";
import { addCivilDays } from "../core/time";
import { selectableUnits, type BaseUnit, type Measurable } from "../core/units";
import { searchWithFallback, type FoodCatalog } from "../food/catalog";
import {
  AS_LOGGED,
  AS_LOGGED_UNIT,
  asLoggedMeasure,
  basicMeasure,
  buildNutritionLogPoint,
  canConvertLogged,
  editedNutritionLogPoint,
  isLoggedAmount,
  loggedAmount,
  toDiaryEntry,
  type AmountEdit,
  type DiaryContext,
  type DiaryEntry,
  type EntryEdit,
  type LogDraft,
} from "../health/mapping";
import type { MealType } from "../health/types";
import { ChatHandles, dayWords, readableText, describeDay, describeDays, describeFood, mealOf, resolveDay, stepSchema, type ChatStep, type EnergyUnitName } from "./chat-protocol";

/** How many search results the model is shown. Few, because its context is small. */
export const SEARCH_RESULTS = 5;
/** The most days `read_days` reads, one request each. */
export const MAX_DAYS = 14;

/** What the chat needs from the app. */
export interface ChatHost {
  /** YYYY-MM-DD. */
  today(): string;
  /** The day the diary shows. */
  viewedDay(): string;
  /** A day's entries as the diary would show them, read afresh. Deleted ones are left out. */
  entriesOn(day: string, signal: AbortSignal): Promise<DiaryEntry[]>;
  readonly catalog: FoodCatalog;
  energyUnit(): EnergyUnitName;
  servingUnits(): Partial<Record<BaseUnit, string>>;
  diaryContext(): DiaryContext;
  /** When an entry logged now for `day` is eaten: now today, or the same clock time on an earlier day. */
  logTime(day: string): Date;
}

/** A change the user is asked to accept. `preview` is the entry as it would be written. */
export type Proposal =
  | { readonly kind: "log"; readonly draft: LogDraft; readonly preview: DiaryEntry }
  | { readonly kind: "edit"; readonly entry: DiaryEntry; readonly edit: EntryEdit; readonly preview: DiaryEntry }
  | { readonly kind: "delete"; readonly entry: DiaryEntry };

export type ToolOutcome =
  /** `text` goes to the model. `activity` tells the user what was looked at. */
  | { readonly kind: "result"; readonly text: string; readonly activity: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "proposal"; readonly proposal: Proposal };

export interface ChatTools {
  readonly handles: ChatHandles;
  /** The constraint for the model's next answer, with the handles handed out so far. */
  schema(): Record<string, unknown>;
  /** Runs any action but `reply`. Never rejects for a problem with what the model asked: it says so in an error. */
  run(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome>;
  /** The model's words for the user, with its handles turned into the entries and foods they stand for. */
  readable(text: string): string;
}

const error = (text: string): ToolOutcome => ({ kind: "error", text });

/** The units the rules accept for a measure, as the model should write them. */
function unitList(measure: Measurable): string {
  const units = [...selectableUnits(measure).map((u) => u.key), ...measure.portions.map((p) => (p.name === AS_LOGGED ? `× ${AS_LOGGED}` : p.name))];
  return units.join(", ");
}

/** Reads an amount the model wrote, with the rules. `shownUnit` is what a bare number means; "" asks for a unit. */
function readModelAmount(text: string, measure: Measurable, shownUnit: string): { quantity: number; unit: string } | string {
  const read = readAmount(text, shownUnit, measure, { settled: true });
  if (read.state === "ok") return { quantity: read.quantity, unit: read.unit };
  const why = read.state === "problem" ? read.message : "The amount is not complete.";
  return `The amount "${text}" can't be used: ${why} Units for this food: ${unitList(measure)}.`;
}

/** Why the app can't change this entry, if it can't. */
function cannotChange(e: DiaryEntry, what: "change" | "delete"): string | undefined {
  if (!e.own) return `This entry was logged by ${e.sourceLabel ?? "another app"}, so this app can't ${what} it.`;
  if (what === "change" && e.ref?.source === "prep") return "This entry is a share of a meal prep. It can be deleted, but not changed.";
  return undefined;
}

export function createChatTools(host: ChatHost, handles: ChatHandles = new ChatHandles()): ChatTools {
  const unit = () => host.energyUnit();
  const today = () => host.today();

  /** The day a step names, or the error to send back. */
  const dayOf = (text: string): string | ToolOutcome => {
    const parsed = resolveDay(text, today());
    return parsed.ok ? parsed.day : error(parsed.reason);
  };

  const entryOf = (handle: string): DiaryEntry | ToolOutcome => handles.entry(handle) ?? error(`There is no entry "${handle}". Use read_day to find it.`);

  async function readDay(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome> {
    const day = dayOf(step.day);
    if (typeof day !== "string") return day;
    const entries = await host.entriesOn(day, signal);
    return { kind: "result", text: describeDay(day, today(), entries, handles, unit()), activity: `Read the diary for ${dayWords(day, today())}` };
  }

  async function readDays(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome> {
    const from = dayOf(step.from);
    if (typeof from !== "string") return from;
    const to = dayOf(step.to);
    if (typeof to !== "string") return to;
    const [first, last] = from <= to ? [from, to] : [to, from];
    const days: string[] = [];
    for (let d = first; d <= last && days.length < MAX_DAYS; d = addCivilDays(d, 1)) days.push(d);
    if (days[days.length - 1] !== last) return error(`read_days reads at most ${MAX_DAYS} days at a time.`);
    const read: { day: string; entries: DiaryEntry[] }[] = [];
    // One at a time: each is a request to Google Health, and a fortnight at once would be a burst.
    for (const day of days) read.push({ day, entries: await host.entriesOn(day, signal) });
    return { kind: "result", text: describeDays(read, unit()), activity: `Read the totals from ${dayWords(first, today())} to ${dayWords(last, today())}` };
  }

  async function searchFood(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome> {
    const hits = await searchWithFallback(host.catalog, step.query, { limit: SEARCH_RESULTS, signal });
    const lines = hits.map((h) => describeFood(handles.foodHandle(h.summary), h.summary, unit()));
    return {
      kind: "result",
      text: lines.length ? lines.join("\n") : `No foods match "${step.query}". Try fewer or simpler words.`,
      activity: `Searched foods for “${step.query}”`,
    };
  }

  async function logFood(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome> {
    const summary = handles.food(step.food);
    if (!summary) return error(`There is no food "${step.food}". Use search_food to find it.`);
    const day = dayOf(step.day || "today");
    if (typeof day !== "string") return day;
    let food: FoodItem | undefined;
    try {
      food = await host.catalog.get(summary.ref, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      return error(`The food ${summary.name} could not be loaded. Try another result.`);
    }
    if (!food) return error(`The food ${summary.name} could not be loaded. Try another result.`);
    // The rules read the amount, and a bare number is refused: the unit is never decided for the user (DR-25).
    const amount = readModelAmount(step.amount, food, "");
    if (typeof amount === "string") return error(amount);
    const mealType = mealOf(step.meal);
    const draft: LogDraft = { food, quantity: amount.quantity, unit: amount.unit, ...(mealType ? { mealType } : {}), time: host.logTime(day) };
    try {
      const point = buildNutritionLogPoint(draft, { id: newEntryId(food.ref), servingUnits: host.servingUnits() });
      const preview = toDiaryEntry(point, host.diaryContext());
      if (!preview) return error("That entry could not be made.");
      return { kind: "proposal", proposal: { kind: "log", draft, preview } };
    } catch (e) {
      return error(`That entry could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The food that measures an entry, as the row editor finds it: its record if it converts the logged amount, else the logged units. */
  async function measureOf(entry: DiaryEntry, signal: AbortSignal): Promise<{ measure: Measurable; food?: FoodItem }> {
    const logged = loggedAmount(entry.point.nutritionLog!, host.diaryContext().unitNames);
    if (entry.ref && canReload(entry.ref.source)) {
      try {
        const found = await host.catalog.get(entry.ref, { signal });
        if (found && (!logged || canConvertLogged(found, logged))) return { measure: found, food: found };
      } catch (e) {
        if (signal.aborted) throw e;
        // Without the record, the logged values are scaled, as in the row editor.
      }
    }
    return { measure: logged ? basicMeasure(logged.unit) : asLoggedMeasure() };
  }

  async function amountEdit(entry: DiaryEntry, text: string, signal: AbortSignal): Promise<AmountEdit | undefined | string> {
    const logged = loggedAmount(entry.point.nutritionLog!, host.diaryContext().unitNames);
    const { measure, food } = await measureOf(entry, signal);
    // A bare number is in the unit the entry shows, as in the row editor, whose unit field starts on it.
    const amount = readModelAmount(text, measure, logged?.unit ?? AS_LOGGED_UNIT);
    if (typeof amount === "string") return amount;
    if (logged && isLoggedAmount(logged, measure, amount.quantity, amount.unit)) return undefined;
    if (amount.unit === AS_LOGGED_UNIT && amount.quantity === 1) return undefined;
    return { ...amount, ...(food ? { food } : {}) };
  }

  async function changeEntry(step: ChatStep, signal: AbortSignal): Promise<ToolOutcome> {
    const entry = entryOf(step.entry);
    if (!("id" in entry)) return entry;
    const refused = cannotChange(entry, "change");
    if (refused) return error(refused);
    const edit: { mealType?: MealType; amount?: AmountEdit; day?: string } = {};
    let changed = false;
    if (step.amount) {
      const amount = await amountEdit(entry, step.amount, signal);
      if (typeof amount === "string") return error(amount);
      if (amount) {
        edit.amount = amount;
        changed = true;
      }
    }
    // An edit always says the meal: left out, it means no meal (EntryEdit.mealType).
    const meal0 = entry.mealType === "MEAL_TYPE_UNSPECIFIED" ? undefined : entry.mealType;
    const meal = step.meal ? mealOf(step.meal) : meal0;
    if (meal) edit.mealType = meal;
    if (meal !== meal0) changed = true;
    if (step.day) {
      const day = dayOf(step.day);
      if (typeof day !== "string") return day;
      if (day !== entry.day) {
        edit.day = day;
        changed = true;
      }
    }
    if (!changed) return error("That is how the entry already is, so there is nothing to change.");
    try {
      const point = editedNutritionLogPoint(entry.point.nutritionLog!, edit, { id: copiedEntryId(entry.id), servingUnits: host.servingUnits(), unitNames: host.diaryContext().unitNames ?? new Map() });
      const preview = toDiaryEntry(point, host.diaryContext());
      if (!preview) return error("That change could not be made.");
      return { kind: "proposal", proposal: { kind: "edit", entry, edit, preview } };
    } catch (e) {
      return error(`That change could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function deleteEntry(step: ChatStep): ToolOutcome {
    const entry = entryOf(step.entry);
    if (!("id" in entry)) return entry;
    const refused = cannotChange(entry, "delete");
    if (refused) return error(refused);
    return { kind: "proposal", proposal: { kind: "delete", entry } };
  }

  return {
    handles,
    schema: () => stepSchema(handles.entryHandles(), handles.foodHandles()),
    readable: (text) => readableText(text, handles, today()),
    async run(step, signal) {
      switch (step.action) {
        case "read_day":
          return readDay(step, signal);
        case "read_days":
          return readDays(step, signal);
        case "search_food":
          return searchFood(step, signal);
        case "log_food":
          return logFood(step, signal);
        case "change_entry":
          return changeEntry(step, signal);
        case "delete_entry":
          return deleteEntry(step);
        case "reply":
          return error("reply is not a tool.");
      }
    },
  };
}

/** What happened to a proposal, as the model is told it. */
export function outcomeText(
  proposal: Proposal,
  outcome: { readonly accepted: false } | { readonly accepted: true; readonly ok: boolean; readonly message: string; readonly stale?: boolean },
  today: string,
): string {
  if (!outcome.accepted) return "The user rejected this change, so nothing was done. Do not propose it again unless the user asks.";
  // After a change or delete, and after one refused because the entry had changed, the entry's handle was taken back
  // (ChatHandles.forgetEntry): say so, or the model would try to use it again.
  const forgotten = proposal.kind !== "log" && (outcome.ok || outcome.stale) ? " That entry's handle no longer works. To change it again, use read_day to see it as it is now." : "";
  if (!outcome.ok) return `The user accepted, but it failed: ${outcome.message}${forgotten}`;
  return `The user accepted, and it was done: ${outcome.message || describeDone(proposal, today)}${forgotten}`;
}

/** What a done proposal did, in words. */
export function describeDone(proposal: Proposal, today: string): string {
  switch (proposal.kind) {
    case "log":
      return `logged ${proposal.preview.displayName}, ${proposal.preview.amount ?? "as one entry"}, ${dayWords(proposal.preview.day, today)}.`;
    case "edit":
      return `changed ${proposal.entry.displayName}.`;
    case "delete":
      return `deleted ${proposal.entry.displayName}.`;
  }
}
