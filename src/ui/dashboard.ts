/**
 * The dashboard: the viewed day's totals by macronutrient and by meal, and the 7 days ending on it, each day's
 * macronutrients and each day's energy by meal (DR-38). The day's totals are also summed up in a few lines for the card
 * beside the log, so that they are seen at every entry (DR-47). With the activity scope, the calories burnt are set against
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


/** Civil date `day` in parts, as `formatCivilDate` writes it: "Thursday", "19", "Nov", "2026". */
function dateParts(day: string): { weekday: string; date: string; month: string; year: string } {
  const [weekday, rest] = formatCivilDate(day).split(", ") as [string, string];
  const [date, month, year] = rest.split(" ") as [string, string, string];
  return { weekday, date, month, year };
}

/** "Thu 19": a column's label. */
function shortDay(day: string): string {
  const { weekday, date } = dateParts(day);
  return `${weekday.slice(0, 3)} ${date}`;
}

function daySection(day: string, today: string, entries: readonly DashboardEntry[] | undefined, burnt: number | undefined): HTMLElement {
  const heading = el("h3", {}, dayLabel(day, today));
  if (!entries) return el("section", { class: "dash-day" }, heading, el("p", { class: "status" }, "Loading…"));
  if (entries.length === 0)
    return el(
      "section",
      { class: "dash-day" },
      heading,
      el("p", { class: "empty" }, day === today ? "Nothing logged today yet." : "Nothing logged on this day.", burnt !== undefined && ` ${energy(burnt)} burnt.`),
    );
  const t = totals(entries);
  const fromMacros = macroEnergy(t);
  const meals = byMealGroup(entries);
  return el(
    "section",
    { class: "dash-day" },
    heading,
    el("div", { class: "stats" }, stat("Energy", energy(t.energyKcal), "energy", burnt !== undefined ? `of ${energy(burnt)} burnt` : undefined), ...MACROS.map((m) => stat(MACRO_NAMES[m], grams(t.grams[m]), m))),
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
        ? { reference: { name: "Burnt", color: BURNT_COLOR, value: burnt, format: energy, above: "more than eaten", below: "less than eaten" } }
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
                // Today's figure is still growing.
                partialFor: (i: number) => days[i]!.day === today,
                // Each day's surplus or deficit above its column (DR-46).
                difference: { above: "surplus", below: "deficit", heading: "Difference" },
              },
            }
          : {}),
      }),
    ),
  );
}

/** The heading of the card beside the log, short enough for one line there: "Today's totals", "Yesterday's totals" or "Totals for Tue 17 Nov". */
export function dayTotalsHeading(day: string, today: string): string {
  if (day === today) return "Today's totals";
  if (day === addCivilDays(today, -1)) return "Yesterday's totals";
  const { weekday, date, month, year } = dateParts(day);
  return `Totals for ${weekday.slice(0, 3)} ${date} ${month}${year === today.slice(0, 4) ? "" : ` ${year}`}`;
}

/**
 * "340 kcal deficit" when more was burnt than eaten, "200 kcal surplus" when less, or "Even" when both show the same
 * figure.
 */
function balance(eatenKcal: number, burntKcal: number): HTMLElement {
  // From the figures as shown beside it, in the chosen unit, so that it is always Burnt − Eaten as the reader sees them.
  const gap = Math.round(energyValue(burntKcal)) - Math.round(energyValue(eatenKcal));
  if (gap === 0) return el("p", { class: "day-delta" }, el("strong", {}, "Even"));
  return el("p", { class: "day-delta" }, el("strong", {}, energyShown(Math.abs(gap))), gap > 0 ? " deficit" : " surplus");
}

/**
 * The viewed day's totals in a few lines, for the card beside the log (DR-47): the difference between the calories
 * burnt and the energy eaten, with both beside it alike; a slim bar of energy by meal drawn up to the calories burnt;
 * and the grams of each macronutrient. The dashboard below has the same day in full.
 */
export function renderDaySummary({
  day,
  today,
  dayEntries,
  burnt,
  dayStatus = "",
}: Pick<DashboardOptions, "day" | "today" | "dayEntries" | "burnt"> & {
  /** Said instead of "Loading…" while the day has no entries to show, e.g. that it could not be loaded. */
  readonly dayStatus?: string;
}): HTMLElement {
  if (!dayEntries) return el("div", { class: "day-summary" }, el("p", { class: dayStatus ? "status error" : "status" }, dayStatus || "Loading…"));
  const kcal = burnt?.get(day);
  if (dayEntries.length === 0)
    return el(
      "div",
      { class: "day-summary" },
      el("p", { class: "empty" }, day === today ? "Nothing logged today yet." : "Nothing logged on this day.", kcal !== undefined && ` ${energy(kcal)} burnt.`),
    );
  const t = totals(dayEntries);
  const meals = byMealGroup(dayEntries);
  return el(
    "div",
    { class: "day-summary" },
    el(
      "div",
      { class: "day-balance" },
      // The difference is the strongest figure; eaten and burnt are beside it, alike (DR-47).
      kcal !== undefined ? balance(t.energyKcal, kcal) : el("p", { class: "day-delta" }, el("strong", {}, energy(t.energyKcal)), " eaten"),
      kcal !== undefined &&
        el(
          "dl",
          { class: "day-inout" },
          el("div", {}, el("dt", {}, "Eaten"), el("dd", {}, energy(t.energyKcal))),
          el("div", {}, el("dt", {}, "Burnt"), el("dd", {}, energy(kcal))),
        ),
    ),
    segmentedBar({
      title: "Energy by meal",
      series: MEAL_SERIES,
      values: MEAL_GROUPS.map((g) => meals[g].energyKcal),
      format: (v) => energy(v),
      emptyText: "No energy logged.",
      compact: true,
      ...(kcal !== undefined
        ? { reference: { name: "Burnt", color: BURNT_COLOR, value: kcal, format: energy, above: "more than eaten", below: "less than eaten" } }
        : {}),
    }),
    el(
      "ul",
      { class: "day-macros" },
      ...MACROS.map((m) => el("li", {}, el("span", { class: "chart-key", style: `background: var(--macro-${m})` }), `${MACRO_NAMES[m]} `, el("strong", {}, grams(t.grams[m])))),
    ),
  );
}

export function renderDashboard({ day, today, dayEntries, weekEntries, weekStatus, burnt, burntStatus = "" }: DashboardOptions): HTMLElement {
  return el("div", { class: "dashboard" }, daySection(day, today, dayEntries, burnt?.get(day)), weekSection(day, today, weekEntries, weekStatus, burnt, burntStatus));
}
