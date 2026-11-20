/**
 * The dashboard's numbers: a day's totals by macronutrient and by meal, and the same for each day of a week.
 * Pure: it takes diary entries (from any app) and returns sums, so the charts only draw.
 */

import { addCivilDays } from "./time";
import type { NutrientProfile } from "./nutrients";

/** The macronutrients the dashboard charts, in the order they stack. */
export const MACROS = ["protein", "carbohydrates", "fat"] as const;
export type Macro = (typeof MACROS)[number];

/** Atwater factors: the energy a gram of each macronutrient gives, in kcal. */
export const KCAL_PER_GRAM: Readonly<Record<Macro, number>> = { protein: 4, carbohydrates: 4, fat: 9 };

/**
 * The meals the dashboard groups entries into, in the order they stack. Google Health has more meal types than the
 * log form offers: the ones around meals (`BEFORE_LUNCH`, `AFTER_DINNER`...) are snacks, and `ANYTIME` joins entries
 * with no meal under Other.
 */
export const MEAL_GROUPS = ["breakfast", "lunch", "dinner", "snacks", "other"] as const;
export type MealGroup = (typeof MEAL_GROUPS)[number];

const GROUP_OF: Readonly<Record<string, MealGroup>> = {
  BREAKFAST: "breakfast",
  LUNCH: "lunch",
  DINNER: "dinner",
  SNACK: "snacks",
  BEFORE_BREAKFAST: "snacks",
  BEFORE_LUNCH: "snacks",
  BEFORE_DINNER: "snacks",
  AFTER_DINNER: "snacks",
};

/** The dashboard's group for a Google Health meal type. A meal type the API adds later goes under Other. */
export function mealGroup(mealType: string): MealGroup {
  return GROUP_OF[mealType] ?? "other";
}

/** What the dashboard needs of a diary entry. */
export interface DashboardEntry {
  readonly start: Date;
  /** The civil day it is on, by its own clock, as the diary lists it (`entryDay`). */
  readonly day: string;
  readonly mealType: string;
  readonly profile: NutrientProfile;
}

export interface Totals {
  readonly energyKcal: number;
  /** Grams of each macronutrient. An entry that doesn't say counts as 0 g. */
  readonly grams: Readonly<Record<Macro, number>>;
  /** How many entries were added up. */
  readonly count: number;
}

export const NO_TOTALS: Totals = { energyKcal: 0, grams: { protein: 0, carbohydrates: 0, fat: 0 }, count: 0 };

export function totals(entries: readonly DashboardEntry[]): Totals {
  let energyKcal = 0;
  const grams = { protein: 0, carbohydrates: 0, fat: 0 };
  for (const e of entries) {
    energyKcal += e.profile.energyKcal;
    for (const m of MACROS) grams[m] += e.profile.nutrients[m] ?? 0;
  }
  return { energyKcal, grams, count: entries.length };
}

/**
 * The energy each macronutrient gives, in kcal, by the Atwater factors. Their sum is close to the logged energy but
 * rarely equal to it: labels round, fibre gives less than other carbohydrate, and alcohol is not a macronutrient here.
 */
export function macroEnergy(t: Totals): Record<Macro, number> {
  return { protein: t.grams.protein * KCAL_PER_GRAM.protein, carbohydrates: t.grams.carbohydrates * KCAL_PER_GRAM.carbohydrates, fat: t.grams.fat * KCAL_PER_GRAM.fat };
}

/** Totals for each meal group. Every group is present, with zeros when nothing was logged in it. */
export function byMealGroup(entries: readonly DashboardEntry[]): Record<MealGroup, Totals> {
  const groups = new Map<MealGroup, DashboardEntry[]>();
  for (const e of entries) {
    const g = mealGroup(e.mealType);
    const list = groups.get(g);
    if (list) list.push(e);
    else groups.set(g, [e]);
  }
  return Object.fromEntries(MEAL_GROUPS.map((g) => [g, totals(groups.get(g) ?? [])])) as Record<MealGroup, Totals>;
}

export interface DayTotals {
  /** YYYY-MM-DD. */
  readonly day: string;
  readonly total: Totals;
  readonly meals: Readonly<Record<MealGroup, Totals>>;
}

/**
 * The `days` civil days ending on `last` (YYYY-MM-DD), oldest first, each with its totals. An entry counts on the
 * civil day it is on (`day`), as in the diary; entries outside the range are left out.
 */
export function dailyTotals(entries: readonly DashboardEntry[], last: string, days = 7): DayTotals[] {
  const range = Array.from({ length: days }, (_, i) => addCivilDays(last, i - days + 1));
  const byDay = new Map<string, DashboardEntry[]>(range.map((d) => [d, []]));
  for (const e of entries) byDay.get(e.day)?.push(e);
  return range.map((day) => {
    const list = byDay.get(day)!;
    return { day, total: totals(list), meals: byMealGroup(list) };
  });
}

/** The mean daily energy over the days that have any entry, or undefined when none has. */
export function averageEnergy(days: readonly DayTotals[]): number | undefined {
  const logged = days.filter((d) => d.total.count > 0);
  return logged.length ? logged.reduce((sum, d) => sum + d.total.energyKcal, 0) / logged.length : undefined;
}

/**
 * The mean of the calories burnt (kcal by YYYY-MM-DD) over the given days that have a figure, leaving out `today`,
 * whose figure is only what was burnt so far. Undefined when no such day has one.
 */
export function averageBurnt(burnt: ReadonlyMap<string, number>, days: readonly string[], today: string): number | undefined {
  const known = days.flatMap((d) => {
    const kcal = burnt.get(d);
    return d !== today && kcal !== undefined ? [kcal] : [];
  });
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined;
}

/**
 * A round axis maximum at or above `max`, and the step between its gridlines: 1, 2, 2.5 or 5 times a power of 10. It
 * takes the smallest step that needs no more than `maxSteps` of them, so the tallest column fills most of the plot.
 */
export function niceScale(max: number, maxSteps = 5): { max: number; step: number } {
  if (!(max > 0)) return { max: 4, step: 1 };
  const power = 10 ** Math.floor(Math.log10(max / maxSteps));
  // Rounded to 12 significant digits, so that 3 × 0.1 is 0.3.
  const round = (n: number) => Number(n.toPrecision(12));
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => round(m * power)).find((s) => Math.ceil(max / s - 1e-9) <= maxSteps)!;
  return { max: round(Math.ceil(max / step - 1e-9) * step), step };
}
