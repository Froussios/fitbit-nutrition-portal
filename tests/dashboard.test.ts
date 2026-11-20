// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { averageBurnt, averageEnergy, byMealGroup, dailyTotals, macroEnergy, mealGroup, niceScale, totals, type DashboardEntry } from "../src/core/dashboard";
import { nutritionDaysFilter } from "../src/core/time";
import { markerLeft, stackedColumns } from "../src/ui/charts";
import { dayTotalsHeading, renderDashboard, renderDaySummary } from "../src/ui/dashboard";
import { setEnergyUnit } from "../src/ui/energy-unit";

/** An entry at local noon on `day`, so that it falls on that civil date in any time zone the tests run in. */
function entry(day: string, mealType: string, energyKcal: number, protein = 0, carbohydrates = 0, fat = 0): DashboardEntry {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d, 12), day, mealType, profile: { energyKcal, nutrients: { protein, carbohydrates, fat } } };
}

describe("dashboard sums", () => {
  it("adds up energy and macronutrients, counting a missing one as 0 g", () => {
    const t = totals([entry("2026-11-19", "LUNCH", 500, 30, 50, 20), { start: new Date(), day: "2026-11-19", mealType: "SNACK", profile: { energyKcal: 100, nutrients: {} } }]);
    expect(t).toEqual({ energyKcal: 600, grams: { protein: 30, carbohydrates: 50, fat: 20 }, count: 2 });
  });

  it("gives each macronutrient's energy by the Atwater factors", () => {
    expect(macroEnergy(totals([entry("2026-11-19", "LUNCH", 500, 10, 20, 10)]))).toEqual({ protein: 40, carbohydrates: 80, fat: 90 });
  });

  it("groups Google Health's snack times as snacks, and anything without a meal as other", () => {
    expect(["BREAKFAST", "LUNCH", "DINNER", "SNACK", "BEFORE_LUNCH", "AFTER_DINNER", "ANYTIME", "MEAL_TYPE_UNSPECIFIED", "BRUNCH"].map(mealGroup)).toEqual([
      "breakfast",
      "lunch",
      "dinner",
      "snacks",
      "snacks",
      "snacks",
      "other",
      "other",
      "other",
    ]);
  });

  it("totals every meal group, with zeros for the empty ones", () => {
    const meals = byMealGroup([entry("2026-11-19", "BREAKFAST", 300), entry("2026-11-19", "BREAKFAST", 100), entry("2026-11-19", "BEFORE_DINNER", 150)]);
    expect(meals.breakfast.energyKcal).toBe(400);
    expect(meals.snacks.energyKcal).toBe(150);
    expect(meals.lunch).toEqual({ energyKcal: 0, grams: { protein: 0, carbohydrates: 0, fat: 0 }, count: 0 });
  });

  it("splits a week into its 7 days, oldest first, leaving out entries outside it", () => {
    const days = dailyTotals([entry("2026-11-19", "LUNCH", 500), entry("2026-11-13", "DINNER", 700), entry("2026-11-12", "DINNER", 999), entry("2026-11-20", "DINNER", 999)], "2026-11-19");
    expect(days.map((d) => d.day)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(days.map((d) => d.total.energyKcal)).toEqual([700, 0, 0, 0, 0, 0, 500]);
    expect(days[0]!.meals.dinner.energyKcal).toBe(700);
  });

  it("crosses a month and a year end", () => {
    expect(dailyTotals([], "2027-01-02").map((d) => d.day)).toEqual(["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("averages energy over the days with entries only", () => {
    expect(averageEnergy(dailyTotals([entry("2026-11-19", "LUNCH", 2000), entry("2026-11-17", "LUNCH", 1000)], "2026-11-19"))).toBe(1500);
    expect(averageEnergy(dailyTotals([], "2026-11-19"))).toBeUndefined();
  });

  it("averages calories burnt over the complete days with a figure, leaving out today's", () => {
    const burnt = new Map([
      ["2026-11-17", 2000],
      ["2026-11-18", 2400],
      ["2026-11-19", 900],
    ]);
    expect(averageBurnt(burnt, ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"], "2026-11-19")).toBe(2200);
    expect(averageBurnt(burnt, ["2026-11-19"], "2026-11-19")).toBeUndefined();
    // Viewing a past week, its last day is complete.
    expect(averageBurnt(burnt, ["2026-11-18", "2026-11-19"], "2026-11-25")).toBe(1650);
  });

  it("picks a round axis maximum", () => {
    expect(niceScale(173)).toEqual({ max: 200, step: 50 });
    expect(niceScale(0.3)).toEqual({ max: 0.3, step: 0.1 });
    expect(niceScale(2140)).toEqual({ max: 2500, step: 500 });
    expect(niceScale(100)).toEqual({ max: 100, step: 20 });
    expect(niceScale(101)).toEqual({ max: 125, step: 25 });
    expect(niceScale(0)).toEqual({ max: 4, step: 1 });
  });

  it("lists a range of days by civil start time", () => {
    expect(nutritionDaysFilter("2026-11-13", "2026-11-19")).toBe(
      'nutrition_log.interval.civil_start_time >= "2026-11-13" AND nutrition_log.interval.civil_start_time < "2026-11-20"',
    );
  });
});

describe("dashboard view", () => {
  const day = "2026-11-19";
  const dayEntries = [entry(day, "BREAKFAST", 400, 20, 50, 10), entry(day, "DINNER", 800, 40, 60, 30)];
  const week = [...dayEntries, entry("2026-11-15", "LUNCH", 600, 30, 40, 20)];

  it("shows the day's totals and its shares by macronutrient and by meal", () => {
    setEnergyUnit("kcal");
    const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "" });
    expect([...view.querySelectorAll(".stat-value")].map((s) => s.textContent)).toEqual(["1,200 kcal", "60 g", "110 g", "40 g"]);
    const [macros, meals] = view.querySelectorAll(".seg-bar");
    // 240 kcal of protein, 440 of carbs and 360 of fat.
    expect([...macros!.querySelectorAll(".seg")].map((s) => s.textContent)).toEqual(["23%", "42%", "35%"]);
    // Meals with nothing logged draw no block.
    expect([...meals!.querySelectorAll(".seg")].map((s) => s.className)).toEqual(["seg seg-breakfast", "seg seg-dinner"]);
    expect(meals!.getAttribute("aria-label")).toBe("Energy by meal: Breakfast 400 kcal, 33%; Dinner 800 kcal, 67%");
  });

  it("draws a column per day with a table of the same figures", () => {
    const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "" });
    const charts = view.querySelectorAll(".chart.columns");
    expect(charts).toHaveLength(2);
    expect(charts[0]!.querySelectorAll(".chart-column")).toHaveLength(7);
    // The 15th has one entry; the 19th, the day shown, is drawn as current.
    expect(charts[0]!.querySelectorAll(".chart-column")[2]!.getAttribute("aria-label")).toBe("Sunday, 15 Nov 2026: Protein 30 g, Carbs 40 g, Fat 20 g; total 90 g; 600 kcal logged");
    expect(charts[0]!.querySelector(".chart-column.current .chart-day")?.textContent).toBe("Thu 19");
    const rows = [...charts[1]!.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows[6]).toEqual(["Thursday, 19 Nov 2026", "400 kcal", "0 kcal", "800 kcal", "0 kcal", "0 kcal", "1,200 kcal"]);
    expect(view.textContent).toContain("Average 900 kcal a day, over the 2 days with entries.");
  });

  it("charts energy in kJ when that is the chosen unit", () => {
    setEnergyUnit("kj");
    const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "" });
    expect(view.querySelector(".stat-value")?.textContent).toBe("5,021 kJ");
    expect(view.querySelectorAll(".chart.columns")[1]!.querySelector(".chart-title")?.textContent).toBe("Energy per day by meal (kJ)");
    setEnergyUnit("kcal");
  });

  it("shows a tooltip for the hovered or focused day", () => {
    const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "" });
    const chart = view.querySelector(".chart.columns")!;
    const tip = chart.querySelector<HTMLElement>(".chart-tooltip")!;
    expect(tip.hidden).toBe(true);
    chart.querySelectorAll(".chart-column")[6]!.dispatchEvent(new Event("focus"));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("Thursday, 19 Nov 2026");
    expect(tip.textContent).toContain("60 g Protein");
    chart.querySelectorAll(".chart-column")[6]!.dispatchEvent(new Event("blur"));
    expect(tip.hidden).toBe(true);
  });

  it("says what is missing while the day or the week loads, or when nothing is logged", () => {
    const loading = renderDashboard({ day, today: day, dayEntries: undefined, weekEntries: undefined, weekStatus: "" });
    expect(loading.querySelectorAll(".status")).toHaveLength(2);
    const failed = renderDashboard({ day, today: day, dayEntries: [], weekEntries: undefined, weekStatus: "The week could not be loaded." });
    expect(failed.textContent).toContain("Nothing logged today yet.");
    expect(failed.textContent).toContain("The week could not be loaded.");
  });

  describe("with calories burnt (DR-46)", () => {
    const burnt = new Map([
      ["2026-11-15", 2300],
      ["2026-11-18", 2500],
      [day, 1500],
    ]);

    it("sets today's energy against what was burnt, on the tile and the bar by meal", () => {
      setEnergyUnit("kcal");
      const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "", burnt });
      expect(view.querySelector(".stat-energy .stat-note")?.textContent).toBe("of 1,500 kcal burnt");
      const meals = view.querySelectorAll(".seg-bar")[1]!;
      // 1,200 eaten of 1,500 burnt: an outlined gap of 300 up to the marker at the bar's end.
      expect(meals.querySelector<HTMLElement>(".seg-rest")?.style.flexGrow).toBe("300");
      expect(meals.querySelector<HTMLElement>(".seg-marker")?.style.left).toBe("100%");
      expect(meals.getAttribute("aria-label")).toBe("Energy by meal: Breakfast 400 kcal, 33%; Dinner 800 kcal, 67%; Burnt 1,500 kcal, 300 kcal more than eaten");
      // The macronutrient bar is in grams' shares and has no reference.
      expect(view.querySelectorAll(".seg-bar")[0]!.querySelector(".seg-marker")).toBeNull();
    });

    it("marks where the calories burnt fall when more was eaten", () => {
      const view = renderDashboard({ day, today: "2026-11-20", dayEntries, weekEntries: week, weekStatus: "", burnt: new Map([[day, 1000]]) });
      expect(view.querySelector(".stat-energy .stat-note")?.textContent).toBe("of 1,000 kcal burnt");
      const meals = view.querySelectorAll(".seg-bar")[1]!;
      expect(meals.querySelector(".seg-rest")).toBeNull();
      // Past breakfast's block and the gap after it: 1000 of 1200, less its share of the one gap, plus that gap.
      expect(meals.querySelector<HTMLElement>(".seg-marker")?.style.left).toBe(`calc(${(1000 / 1200) * 100}% + ${Number((2 - (1000 / 1200) * 2).toFixed(3))}px)`);
      expect(meals.getAttribute("aria-label")).toContain("; Burnt 1,000 kcal, 200 kcal less than eaten");
    });

    it("signs each column's difference from its line, and says even when the figures as shown are equal", () => {
      const fmt = (v: number) => `${Math.round(v).toLocaleString("en")} kcal`;
      const chart = stackedColumns({
        title: "Energy",
        series: [{ key: "a", name: "A", color: "--meal-lunch" }],
        columns: [
          { label: "1", title: "Day 1", values: [2200] },
          { label: "2", title: "Day 2", values: [1999.6] },
          { label: "3", title: "Day 3", values: [0] },
        ],
        format: fmt,
        formatTotal: fmt,
        totalHeading: "Total",
        marker: { name: "Burnt", color: "--burnt", values: [2000, 2000.4, 1800], difference: { above: "surplus", below: "deficit", heading: "Difference" } },
      });
      expect([...chart.querySelectorAll(".chart-diff")].map((t) => [t.textContent, t.getAttribute("class")])).toEqual([
        ["+200", "chart-diff over"],
        ["0", "chart-diff"],
      ]);
      expect([...chart.querySelectorAll("tbody tr")].map((r) => r.lastElementChild?.textContent)).toEqual(["200 kcal surplus", "Even", "–"]);
    });

    it("places the bar's marker allowing for the gaps between blocks", () => {
      expect(markerLeft(1500, [400, 800, 300])).toBe("100%");
      expect(markerLeft(100, [400, 800])).toBe("calc(8.333333333333332% - 0.167px)");
      // On a boundary reached by a sum of floats (0.1 + 0.2 is not 0.3): still the middle of the gap.
      expect(markerLeft(0.3, [0.1, 0.2, 0.3])).toMatch(/ \+ 1px\)$/);
      // On the boundary between two blocks: the middle of the gap.
      expect(markerLeft(400, [400, 800])).toBe(`calc(${(400 / 1200) * 100}% + ${Number((1 - (400 / 1200) * 2).toFixed(3))}px)`);
    });

    it("draws a line on each day's energy column that has a figure, with the figure in the tooltip and the table", () => {
      const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "", burnt });
      const [macros, energy] = view.querySelectorAll(".chart.columns");
      expect(macros!.querySelectorAll(".chart-marker")).toHaveLength(0);
      expect(energy!.querySelectorAll(".chart-marker")).toHaveLength(3);
      // Only today's line is dashed: its figure is still growing.
      expect([...energy!.querySelectorAll(".chart-marker")].map((l) => l.classList.contains("partial"))).toEqual([false, false, true]);
      expect(energy!.querySelector(".chart-legend-marker")?.textContent).toBe("Burnt");
      const columns = energy!.querySelectorAll(".chart-column");
      expect(columns[6]!.getAttribute("aria-label")).toBe(
        "Thursday, 19 Nov 2026: Breakfast 400 kcal, Lunch 0 kcal, Dinner 800 kcal, Snacks 0 kcal, Other 0 kcal; total 1,200 kcal; Burnt 1,500 kcal; 300 kcal deficit",
      );
      // The axis reaches the highest line, 2,500, above every column.
      expect([...energy!.querySelectorAll(".chart-grid text")].map((t) => t.textContent).at(-1)).toBe("2,500");
      columns[2]!.dispatchEvent(new Event("focus"));
      expect(energy!.querySelector(".chart-tooltip")?.textContent).toContain("2,300 kcal Burnt");
      const rows = [...energy!.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent).slice(-2));
      // The 18th has a figure but nothing logged, so it has no difference: an empty day is not a measured deficit.
      expect(rows).toEqual([
        ["–", "–"],
        ["–", "–"],
        ["2,300 kcal", "1,700 kcal deficit"],
        ["–", "–"],
        ["–", "–"],
        ["2,500 kcal", "–"],
        ["1,500 kcal", "300 kcal deficit"],
      ]);
      expect([...energy!.querySelectorAll("thead th")].slice(-2).map((th) => th.textContent)).toEqual(["Burnt", "Difference"]);
      // A signed figure above each day that has one; the macronutrient chart has none.
      expect([...energy!.querySelectorAll(".chart-diff")].map((t) => t.textContent)).toEqual(["−1,700", "−300"]);
      expect(macros!.querySelector(".chart-diff")).toBeNull();
      expect(energy!.querySelector(".chart-tooltip")?.textContent).toContain("1,700 kcal deficit");
      expect(view.textContent).toContain("Burnt 2,400 kcal a day, over the 2 complete days recorded.");
    });

    it("charts calories burnt in kJ when that is the chosen unit", () => {
      setEnergyUnit("kj");
      const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "", burnt });
      expect(view.querySelector(".stat-energy .stat-note")?.textContent).toBe("of 6,276 kJ burnt");
      const rows = [...view.querySelectorAll(".chart.columns")[1]!.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent).slice(-2));
      // 5,021 kJ eaten, 6,276 kJ burnt: the difference is worked out in kJ from the figures as shown.
      expect(rows[6]).toEqual(["6,276 kJ", "1,255 kJ deficit"]);
      setEnergyUnit("kcal");
    });

    it("says what was burnt on a day with nothing logged", () => {
      const view = renderDashboard({ day, today: day, dayEntries: [], weekEntries: [], weekStatus: "", burnt });
      expect(view.querySelector(".dash-day .empty")?.textContent).toBe("Nothing logged today yet. 1,500 kcal burnt.");
    });

    it("leaves calories burnt out entirely without them, and says when they failed", () => {
      const view = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "" });
      expect(view.querySelector(".stat-note, .seg-marker, .seg-rest, .chart-marker, .chart-legend-marker")).toBeNull();
      expect(view.textContent).not.toContain("Burnt");
      expect([...view.querySelectorAll(".chart.columns")[1]!.querySelectorAll("thead th")].map((th) => th.textContent).at(-1)).toBe("Total");
      const failed = renderDashboard({ day, today: day, dayEntries, weekEntries: week, weekStatus: "", burntStatus: "Calories burnt could not be loaded." });
      expect(failed.textContent).toContain("Calories burnt could not be loaded.");
    });
  });

  describe("summary beside the log (DR-47, DR-49)", () => {
    const burnt = new Map([
      ["2026-11-15", 2300],
      ["2026-11-18", 2500],
      [day, 1500],
    ]);
    const ring = (view: HTMLElement) => view.querySelector("svg.ring")!;

    it("heads the card with the day, short enough for one line", () => {
      expect(dayTotalsHeading(day, day)).toBe("Today's totals");
      expect(dayTotalsHeading("2026-11-18", day)).toBe("Yesterday's totals");
      expect(dayTotalsHeading("2026-11-17", day)).toBe("Totals for Tue 17 Nov");
      expect(dayTotalsHeading("2025-12-31", day)).toBe("Totals for Wed 31 Dec 2025");
    });

    it("without calories burnt, leads with the energy eaten and draws a plain ring by meal", () => {
      setEnergyUnit("kcal");
      const view = renderDaySummary({ day, today: day, dayEntries });
      expect(view.querySelector(".day-delta")?.textContent).toBe("1,200 kcal eaten");
      expect(view.querySelector(".day-inout")).toBeNull();
      // A part per meal with something in it; hover and the accessible name give every figure.
      expect([...ring(view).querySelectorAll(".ring-part")].map((c) => c.getAttribute("class"))).toEqual(["ring-part ring-breakfast", "ring-part ring-dinner"]);
      expect([...ring(view).querySelectorAll(".ring-part title")].map((t) => t.textContent)).toEqual(["Breakfast 400 kcal, 33%", "Dinner 800 kcal, 67%"]);
      expect(ring(view).getAttribute("aria-label")).toBe("Energy by meal: Breakfast 400 kcal, 33%; Dinner 800 kcal, 67%");
      expect(ring(view).querySelector(".ring-tick, .ring-rest, .ring-over, .ring-figure")).toBeNull();
    });

    it("leads with the signed difference, with eaten and burnt beside it alike", () => {
      const view = renderDaySummary({ day, today: day, dayEntries, burnt });
      expect(view.querySelector(".day-delta")?.textContent).toBe("−300 kcal deficit");
      expect([...view.querySelectorAll(".day-inout > div")].map((d) => d.textContent)).toEqual(["Eaten1,200 kcal", "Burnt1,500 kcal"]);
      expect(view.textContent).not.toContain("so far");
    });

    it("signs a surplus, and says even when the figures as shown are equal", () => {
      expect(renderDaySummary({ day, today: day, dayEntries, burnt: new Map([[day, 1000]]) }).querySelector(".day-delta")?.textContent).toBe("+200 kcal surplus");
      expect(renderDaySummary({ day, today: day, dayEntries, burnt: new Map([[day, 1200.4]]) }).querySelector(".day-delta")?.textContent).toBe("Even");
      // Worked out from the figures as shown: 1,199.6 and 1,200.4 both show as 1,200, so they are even, not 1 apart.
      const close = [{ ...dayEntries[0]!, profile: { energyKcal: 1199.6, nutrients: {} } }];
      const view = renderDaySummary({ day, today: day, dayEntries: close, burnt: new Map([[day, 1200.4]]) });
      expect([...view.querySelectorAll(".day-inout dd")].map((d) => d.textContent)).toEqual(["1,200 kcal", "1,200 kcal"]);
      expect(view.querySelector(".day-delta")?.textContent).toBe("Even");
      // 1,200.4 and 1,500.6 show as 1,200 and 1,501: the headline says 301, not the raw 300.2 rounded to 300.
      expect(renderDaySummary({ day, today: day, dayEntries: [{ ...dayEntries[0]!, profile: { energyKcal: 1200.4, nutrients: {} } }], burnt: new Map([[day, 1500.6]]) }).querySelector(".day-delta")?.textContent).toBe("−301 kcal deficit");
      setEnergyUnit("kj");
      expect(renderDaySummary({ day, today: day, dayEntries, burnt }).querySelector(".day-delta")?.textContent).toBe("−1,255 kJ deficit");
      setEnergyUnit("kcal");
    });

    it("draws the ring round to the calories burnt, with an outlined gap up to them after a deficit", () => {
      const view = renderDaySummary({ day, today: day, dayEntries, burnt });
      const parts = [...ring(view).querySelectorAll(".ring-part")];
      // The ring goes round once for 1,500 kcal: breakfast's 400 is 4/15 of it, less the gap after it.
      const circumference = 2 * Math.PI * 40;
      expect(Number(parts[0]!.getAttribute("stroke-dasharray")!.split(" ")[0])).toBeCloseTo((400 / 1500) * circumference - 1.5, 2);
      expect(Number(parts[1]!.getAttribute("stroke-dashoffset"))).toBeCloseTo(-(400 / 1500) * circumference, 2);
      expect(ring(view).querySelector(".ring-rest title")?.textContent).toBe("Burnt 300 kcal more than eaten");
      expect(ring(view).querySelector(".ring-over")).toBeNull();
      // The tick at the top, where the turn ends.
      const tick = ring(view).querySelector(".ring-tick")!;
      expect([tick.getAttribute("x1"), tick.getAttribute("x2")]).toEqual(["50", "50"]);
      expect(ring(view).querySelector(".ring-figure")?.textContent).toBe("80%");
      expect(ring(view).querySelector(".ring-caption")?.textContent).toBe("of burnt");
      expect(ring(view).getAttribute("aria-label")).toBe("Energy by meal: Breakfast 400 kcal, 33%; Dinner 800 kcal, 67%; Burnt 1,500 kcal, 300 kcal more than eaten");
    });

    it("marks a surplus with a band outside the ring from the calories burnt to the end", () => {
      const view = renderDaySummary({ day, today: day, dayEntries, burnt: new Map([[day, 1000]]) });
      expect(ring(view).querySelector(".ring-rest")).toBeNull();
      const band = ring(view).querySelector(".ring-over")!;
      // 1,000 of 1,200 is 5/6 of the way round, at 10 o'clock, on a circle of radius 49.
      expect(band.getAttribute("d")).toMatch(/^M 7\.565 25\.5 A 49 49 0 0 1 50 1$/);
      expect(band.querySelector("title")?.textContent).toBe("Burnt 200 kcal less than eaten");
      expect(ring(view).querySelector(".ring-figure")?.textContent).toBe("120%");
    });

    it("outlines the whole ring when the entries have no energy", () => {
      const noEnergy = [{ ...dayEntries[0]!, profile: { energyKcal: 0, nutrients: {} } }];
      const view = renderDaySummary({ day, today: day, dayEntries: noEnergy, burnt });
      expect(ring(view).querySelectorAll(".ring-part")).toHaveLength(0);
      expect(ring(view).querySelector(".ring-rest")?.getAttribute("d")).not.toContain("NaN");
      expect(ring(view).querySelector(".ring-figure")?.textContent).toBe("0%");
      expect(ring(view).getAttribute("aria-label")).toBe("Energy by meal: none; Burnt 1,500 kcal, 1,500 kcal more than eaten");
    });

    it("gives each macronutrient's grams and share of the energy, with a bar of that share", () => {
      const view = renderDaySummary({ day, today: day, dayEntries });
      // 240 kcal of protein, 440 of carbs and 360 of fat.
      const rows = [...view.querySelectorAll(".day-macros li")];
      expect(rows.map((li) => li.textContent)).toEqual(["Protein60 g23%", "Carbs110 g42%", "Fat40 g35%"]);
      expect(rows[0]!.getAttribute("title")).toBe("Protein 60 g, 23% of the energy from protein, carbs and fat");
      expect(view.querySelector<HTMLElement>(".day-macro-bar > span")?.style.width).toMatch(/^23\.07/);
      const none = renderDaySummary({ day, today: day, dayEntries: [{ ...dayEntries[0]!, profile: { energyKcal: 300, nutrients: {} } }] });
      expect([...none.querySelectorAll(".day-macros li")].map((li) => li.textContent)).toEqual(["Protein0 g", "Carbs0 g", "Fat0 g"]);
    });

    it("has a legend of the four main meals, Other only when it has some, and the calories burnt's key", () => {
      const legend = (view: HTMLElement) => [...view.querySelectorAll(".day-meals li")].map((li) => li.textContent);
      expect(legend(renderDaySummary({ day, today: day, dayEntries }))).toEqual(["Breakfast 400", "Lunch –", "Dinner 800", "Snacks –"]);
      expect(legend(renderDaySummary({ day, today: day, dayEntries: [...dayEntries, entry(day, "ANYTIME", 150)], burnt }))).toEqual(["Breakfast 400", "Lunch –", "Dinner 800", "Snacks –", "Other 150", "Burnt"]);
    });

    it("ends with the week: each day's energy eaten, a line at its calories burnt, and the signed difference", () => {
      expect(renderDaySummary({ day, today: day, dayEntries, burnt }).querySelector(".day-week")).toBeNull();
      const view = renderDaySummary({ day, today: day, dayEntries, weekEntries: week, burnt });
      const days = [...view.querySelectorAll(".day-week-day")];
      expect(days.map((d) => d.querySelector(".day-week-label")?.textContent)).toEqual(["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]);
      expect(days.map((d) => d.classList.contains("current"))).toEqual([false, false, false, false, false, false, true]);
      // None on a day with nothing eaten, though it has calories burnt.
      expect(days.map((d) => d.querySelector(".day-week-diff")?.textContent ?? null)).toEqual([null, null, "−1,700", null, null, null, "−300"]);
      expect(days[5]!.querySelector(".day-week-burnt")).not.toBeNull();
      expect(days[5]!.getAttribute("aria-label")).toBe("Wednesday, 18 Nov 2026: nothing logged, 2,500 kcal burnt");
      expect(days[6]!.getAttribute("aria-label")).toBe("Thursday, 19 Nov 2026: 1,200 kcal eaten, 1,500 kcal burnt, 300 kcal deficit");
      // Scaled to the week's largest figure, 2,500 kcal burnt; today's line is dashed, still growing.
      expect(days[6]!.querySelector<HTMLElement>(".day-week-bar")?.style.height).toBe("48%");
      expect(days[6]!.querySelector<HTMLElement>(".day-week-burnt")?.style.bottom).toBe("60%");
      expect(days.map((d) => d.querySelector(".day-week-burnt.partial") !== null)).toEqual([false, false, false, false, false, false, true]);
      // Today's difference is left out of the average.
      expect(view.querySelector(".day-week-head")?.textContent).toBe("Last 7 daysaverage −1,700 kcal a day");
    });

    it("averages every complete day on a past day, and the energy eaten without calories burnt", () => {
      const past = renderDaySummary({ day, today: "2026-11-20", dayEntries, weekEntries: week, burnt });
      expect(past.querySelector(".day-week-head")?.textContent).toBe("7 days to Thu 19average −1,000 kcal a day");
      expect(past.querySelector(".day-week-burnt.partial")).toBeNull();
      const plain = renderDaySummary({ day, today: day, dayEntries, weekEntries: week });
      expect(plain.querySelector(".day-week-head")?.textContent).toBe("Last 7 daysaverage 900 kcal eaten a day");
      expect(plain.querySelectorAll(".day-week-burnt, .day-week-diff")).toHaveLength(0);
      setEnergyUnit("kj");
      const kj = renderDaySummary({ day, today: day, dayEntries, weekEntries: week, burnt });
      expect([...kj.querySelectorAll(".day-week-diff")].map((d) => d.textContent)).toEqual(["−7,113", "−1,255"]);
      setEnergyUnit("kcal");
    });

    it("says when nothing is logged or the day is loading", () => {
      expect(renderDaySummary({ day, today: day, dayEntries: [], burnt: new Map([[day, 900]]) }).textContent).toBe("Nothing logged today yet. 900 kcal burnt.");
      expect(renderDaySummary({ day, today: "2026-11-20", dayEntries: [] }).textContent).toBe("Nothing logged on this day.");
      expect(renderDaySummary({ day, today: day, dayEntries: undefined }).textContent).toBe("Loading…");
      const failed = renderDaySummary({ day, today: day, dayEntries: undefined, dayStatus: "The day could not be loaded." });
      expect(failed.textContent).toBe("The day could not be loaded.");
      expect(failed.querySelector(".status")?.classList.contains("error")).toBe(true);
    });
  });
});
