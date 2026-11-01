import { sumProfiles } from "../core/nutrients";
import { mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { fmtGrams, fmtKcal, fmtKj, fmtTime } from "./format";

export interface DiaryTableOptions {
  readonly entries: readonly DiaryEntry[];
  /** IDs written in this session that the API has not returned yet. */
  readonly pendingIds: ReadonlySet<string>;
  readonly onDelete: (entry: DiaryEntry) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  off: "Open Food Facts",
  ausnut: "AUSNUT",
  usda: "USDA",
  sample: "Sample",
  manual: "Custom",
};

export function renderDiaryTable({ entries, pendingIds, onDelete }: DiaryTableOptions): HTMLElement {
  if (entries.length === 0) {
    return el("p", { class: "empty" }, "Nothing logged today yet.");
  }

  const total = sumProfiles(entries.map((e) => e.profile));
  const head = ["Time", "Meal", "Food", "kcal", "kJ", "Protein", "Carbs", "Fat", "Source", ""];

  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { scope: "col", class: i >= 3 && i <= 7 ? "num" : undefined }, h)))),
      el(
        "tbody",
        {},
        ...entries.map((e) =>
          el(
            "tr",
            { class: pendingIds.has(e.id) ? "pending" : undefined },
            el("td", {}, fmtTime(e.start)),
            el("td", {}, mealLabel(e.mealType)),
            el("td", {}, e.displayName, pendingIds.has(e.id) && el("span", { class: "tag" }, "syncing")),
            el("td", { class: "num" }, fmtKcal(e.profile.energyKcal)),
            el("td", { class: "num" }, fmtKj(e.profile.energyKcal)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.protein)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.carbohydrates)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.fat)),
            el("td", {}, e.ref ? (SOURCE_LABELS[e.ref.source] ?? e.ref.source) : (e.platform ?? "Other app")),
            el(
              "td",
              {},
              el("button", { type: "button", class: "icon", title: "Delete entry", "aria-label": `Delete ${e.displayName}`, onclick: () => onDelete(e) }, "✕"),
            ),
          ),
        ),
      ),
      el(
        "tfoot",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "row", colspan: 3 }, `Total (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`),
          el("td", { class: "num" }, fmtKcal(total.energyKcal)),
          el("td", { class: "num" }, fmtKj(total.energyKcal)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.protein)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.carbohydrates)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.fat)),
          el("td", { colspan: 2 }),
        ),
      ),
    ),
  );
}
