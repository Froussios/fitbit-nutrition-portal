import { SOURCE_TAGS } from "../core/food";
import { sumProfiles } from "../core/nutrients";
import { mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { fmtGrams, fmtKcal, fmtKj, fmtTime } from "./format";

export interface DiaryTableOptions {
  readonly entries: readonly DiaryEntry[];
  /** IDs written in this session that the API has not returned yet. */
  readonly pendingIds: ReadonlySet<string>;
  /** Deleting needs a connection, so the buttons are disabled while the browser is offline. */
  readonly offline: boolean;
  readonly onDelete: (entry: DiaryEntry) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ...SOURCE_TAGS,
  sample: "sample food",
  manual: "custom food",
};

export function renderDiaryTable({ entries, pendingIds, offline, onDelete }: DiaryTableOptions): HTMLElement {
  if (entries.length === 0) {
    return el("p", { class: "empty" }, "Nothing logged today yet.");
  }

  const total = sumProfiles(entries.map((e) => e.profile));
  const head = ["Time", "Meal", "Food", "Amount", "kcal", "kJ", "Protein", "Carbs", "Fat", "Logged by", ""];

  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { scope: "col", class: i >= 3 && i <= 8 ? "num" : undefined }, h)))),
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
            el("td", { class: "num" }, e.amount ?? "–"),
            el("td", { class: "num" }, fmtKcal(e.profile.energyKcal)),
            el("td", { class: "num" }, fmtKj(e.profile.energyKcal)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.protein)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.carbohydrates)),
            el("td", { class: "num" }, fmtGrams(e.profile.nutrients.fat)),
            el("td", {}, e.own ? `This app${e.ref ? ` · ${SOURCE_LABELS[e.ref.source] ?? e.ref.source}` : ""}` : (e.sourceLabel ?? "Other app")),
            el(
              "td",
              {},
              // The write scope only covers entries this app created.
              e.own &&
                el(
                  "button",
                  { type: "button", class: "icon", title: offline ? "Deleting needs a connection" : "Delete entry", "aria-label": `Delete ${e.displayName}`, disabled: offline, onclick: () => onDelete(e) },
                  "✕",
                ),
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
          el("th", { scope: "row", colspan: 4 }, `Total (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`),
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
