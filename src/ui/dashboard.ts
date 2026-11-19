/**
 * The dashboard: the viewed day's totals by macronutrient and by meal, and the 7 days ending on it, each day's
 * macronutrients and each day's energy by meal (DR-38). With the activity scope, the calories burnt are set against
 * the energy eaten: under the day's energy, on its bar by meal, and as a line on each day's column (DR-46).
 */

import { averageBurnt, averageEnergy, byMealGroup, dailyTotals, macroEnergy, MACROS, MEAL_GROUPS, totals, type DashboardEntry, type Macro, type MealGroup } from "../core/dashboard";
import { kcalToKj } from "../core/nutrients";
import { addCivilDays, dayLabel, formatCivilDate } from "../core/time";
import { formatNumber } from "../core/units";
import { segmentedBar, stackedColumns, type Column, type Series } from "./charts";
import { el } from "./dom";
import { getEnergyUnit } from "./energy-unit";
import { energyLabel, fmtEnergy } from "./format";

const MACRO_NAMES: Record<Macro, string> = { protein: "Protein", carbohydrates: "Carbs", fat: "Fat" };
const MEAL_NAMES: Record<MealGroup, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks", other: "Other" };

export const MACRO_SERIES: readonly Series[] = MACROS.map((m) => ({ key: m, name: MACRO_NAMES[m], color: `--macro-${m}` }));
export const MEAL_SERIES: readonly Series[] = MEAL_GROUPS.map((g) => ({ key: g, name: MEAL_NAMES[g], color: `--meal-${g}` }));

export interface DashboardOptions {
  /** The day the diary shows (YYYY-MM-DD). */
  readonly day: string;
  readonly today: string;
  /** The entries of `day`, or undefined while they load. */
  readonly dayEntries: readonly DashboardEntry[] | undefined;
  /** The entries of the 7 days ending on `day`, or undefined while they load or when they failed. */
  readonly weekEntries: readonly DashboardEntry[] | undefined;
  /** Said in place of the week's charts when there are no entries for it. */
  readonly weekStatus: string;
  /**
   * Calories burnt (kcal by YYYY-MM-DD) over the 7 days ending on `day`, today's only so far. Undefined leaves them out:
   * the activity scope was not granted, or they are loading or failed.
   */
  readonly burnt?: ReadonlyMap<string, number>;
  /** Said under the week's summary when the calories burnt could not be loaded. */
  readonly burntStatus?: string;
}

/** The colour of calories burnt in every chart: an ink line, apart from every series' fill. */
const BURNT_COLOR = "--burnt";

const grams = (g: number) => `${formatNumber(g, g < 10 ? 1 : 0)} g`;
/** Energy in the chosen unit, as a number to chart. */
const energyValue = (kcal: number) => (getEnergyUnit() === "kj" ? kcalToKj(kcal) : kcal);
const energy = (kcal: number) => `${fmtEnergy(kcal)} ${energyLabel()}`;
const energyShown = (value: number) => `${formatNumber(value, 0)} ${energyLabel()}`;

/** `tint`: the tile's colour, the same as its series in the charts. `note`: a line under the value. */
function stat(label: string, value: string, tint: string, note?: string): HTMLElement {
  return el("div", { class: `stat stat-${tint}` }, el("div", { class: "stat-label" }, label), el("div", { class: "stat-value" }, value), note && el("div", { class: "stat-note" }, note));
}

/** "burnt" or, for today, whose figure is still growing, "burnt so far". */
const burntWords = (day: string, today: string) => (day === today ? "burnt so far" : "burnt");

/** "Thu 19": a column's label. */
function shortDay(day: string): string {
  const [weekday, date] = formatCivilDate(day).split(", ") as [string, string];
  return `${weekday.slice(0, 3)} ${date.split(" ")[0]}`;
}

function daySection(day: string, today: string, entries: readonly DashboardEntry[] | undefined, burnt: number | undefined): HTMLElement {
  const heading = el("h3", {}, dayLabel(day, today));
  if (!entries) return el("section", { class: "dash-day" }, heading, el("p", { class: "status" }, "Loading…"));
  const words = burntWords(day, today);
  if (entries.length === 0)
    return el(
      "section",
      { class: "dash-day" },
      heading,
      el("p", { class: "empty" }, day === today ? "Nothing logged today yet." : "Nothing logged on this day.", burnt !== undefined && ` ${energy(burnt)} ${words}.`),
    );
  const t = totals(entries);
  const fromMacros = macroEnergy(t);
  const meals = byMealGroup(entries);
  return el(
    "section",
    { class: "dash-day" },
    heading,
    el("div", { class: "stats" }, stat("Energy", energy(t.energyKcal), "energy", burnt !== undefined ? `of ${energy(burnt)} ${words}` : undefined), ...MACROS.map((m) => stat(MACRO_NAMES[m], grams(t.grams[m]), m))),
    segmentedBar({
      title: "Energy by macronutrient",
      series: MACRO_SERIES,
      values: MACROS.map((m) => fromMacros[m]),
      // The legend gives grams, the unit the diary uses; the blocks give each one's share of the energy.
      format: (_, i) => grams(t.grams[MACROS[i]!]),
      emptyText: "No protein, carbs or fat logged.",
    }),
    segmentedBar({
      title: "Energy by meal",
      series: MEAL_SERIES,
      values: MEAL_GROUPS.map((g) => meals[g].energyKcal),
      format: (kcal) => energy(kcal),
      emptyText: "No energy logged.",
      ...(burnt !== undefined
        ? { reference: { name: words[0]!.toUpperCase() + words.slice(1), color: BURNT_COLOR, value: burnt, format: energy, above: "more than eaten", below: "less than eaten" } }
        : {}),
    }),
  );
}

function weekSection(day: string, today: string, entries: readonly DashboardEntry[] | undefined, status: string, burnt: ReadonlyMap<string, number> | undefined, burntStatus: string): HTMLElement {
  const first = addCivilDays(day, -6);
  const heading = el("h3", {}, `7 days to ${day === today ? "today" : formatCivilDate(day)}`);
  if (!entries) return el("section", { class: "dash-week" }, heading, el("p", { class: "status" }, status || "Loading…"));
  const days = dailyTotals(entries, day, 7);
  const average = averageEnergy(days);
  const logged = days.filter((d) => d.total.count > 0).length;
  const burntAverage = burnt && averageBurnt(burnt, days.map((d) => d.day), today);
  const burntDays = burnt ? days.filter((d) => d.day !== today && burnt.has(d.day)).length : 0;
  const column = (d: (typeof days)[number], values: number[], note?: string): Column => ({
    label: shortDay(d.day),
    title: formatCivilDate(d.day),
    values,
    ...(note ? { note } : {}),
    current: d.day === day,
  });
  return el(
    "section",
    { class: "dash-week" },
    heading,
    el(
      "p",
      { class: "hint dash-summary" },
      average === undefined
        ? `Nothing logged from ${formatCivilDate(first)}.`
        : `Average ${energy(average)} a day, over the ${logged === 1 ? "one day" : `${logged} days`} with entries.`,
      // Today's figure is still growing, so it is left out of the average.
      burntAverage !== undefined && ` Burnt ${energy(burntAverage)} a day, over the ${burntDays === 1 ? "one complete day" : `${burntDays} complete days`} recorded.`,
    ),
    burntStatus && el("p", { class: "hint dash-summary" }, burntStatus),
    el(
      "div",
      { class: "dash-charts" },
      stackedColumns({
        title: "Macronutrients per day (g)",
        series: MACRO_SERIES,
        columns: days.map((d) => column(d, MACROS.map((m) => d.total.grams[m]), d.total.count ? `${energy(d.total.energyKcal)} logged` : "Nothing logged")),
        format: grams,
        formatTotal: grams,
        totalHeading: "Total",
      }),
      stackedColumns({
        title: `Energy per day by meal (${energyLabel()})`,
        series: MEAL_SERIES,
        columns: days.map((d) => column(d, MEAL_GROUPS.map((g) => energyValue(d.meals[g].energyKcal)))),
        format: energyShown,
        formatTotal: energyShown,
        totalHeading: "Total",
        ...(burnt
          ? {
              marker: {
                name: "Burnt",
                color: BURNT_COLOR,
                values: days.map((d) => {
                  const kcal = burnt.get(d.day);
                  return kcal === undefined ? undefined : energyValue(kcal);
                }),
                noteFor: (i: number) => (days[i]!.day === today ? "so far" : undefined),
              },
            }
          : {}),
      }),
    ),
  );
}

export function renderDashboard({ day, today, dayEntries, weekEntries, weekStatus, burnt, burntStatus = "" }: DashboardOptions): HTMLElement {
  return el("div", { class: "dashboard" }, daySection(day, today, dayEntries, burnt?.get(day)), weekSection(day, today, weekEntries, weekStatus, burnt, burntStatus));
}
