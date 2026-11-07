import { SOURCE_TAGS } from "../core/food";
import { sumProfiles } from "../core/nutrients";
import { byTime, mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { fmtGrams, fmtKcal, fmtKj, fmtTime } from "./format";

export interface DiaryTableOptions {
  readonly entries: readonly DiaryEntry[];
  /** IDs written in this session that the API has not returned yet. */
  readonly pendingIds: ReadonlySet<string>;
  /** Entries deleted in this session: still shown, crossed out, with an Undo. They do not count towards the totals. */
  readonly deleted: readonly DiaryEntry[];
  /** IDs of the entries with a delete or undo under way: disabled until it succeeds or fails. */
  readonly busyIds: ReadonlySet<string>;
  /** Deleting and undoing need a connection, so the buttons are disabled while the browser is offline. */
  readonly offline: boolean;
  readonly onDelete: (entry: DiaryEntry) => void;
  readonly onUndo: (entry: DiaryEntry) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ...SOURCE_TAGS,
  sample: "sample food",
  manual: "custom food",
};

/** What a row is going through, if anything. */
function rowTag(id: string, deleted: ReadonlySet<string>, busy: ReadonlySet<string>, pending: ReadonlySet<string>): HTMLElement | undefined {
  const text = deleted.has(id) ? "deleted" : busy.has(id) ? "deleting…" : pending.has(id) ? "syncing" : undefined;
  return text ? el("span", { class: "tag" }, text) : undefined;
}

export function renderDiaryTable({ entries, pendingIds, deleted, busyIds, offline, onDelete, onUndo }: DiaryTableOptions): HTMLElement {
  if (entries.length === 0 && deleted.length === 0) {
    return el("p", { class: "empty" }, "Nothing logged today yet.");
  }

  const total = sumProfiles(entries.map((e) => e.profile));
  const deletedIds = new Set(deleted.map((e) => e.id));
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
        ...[...entries, ...deleted].sort(byTime).map((e) =>
          el(
            "tr",
            { class: [deletedIds.has(e.id) && "deleted", (pendingIds.has(e.id) || busyIds.has(e.id)) && "pending"].filter(Boolean).join(" ") || undefined },
            el("td", {}, fmtTime(e.start)),
            el("td", {}, mealLabel(e.mealType)),
            el("td", {}, e.displayName, rowTag(e.id, deletedIds, busyIds, pendingIds)),
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
                (deletedIds.has(e.id)
                  ? el(
                      "button",
                      { type: "button", class: "link", "data-entry": e.id, title: offline ? "Undoing needs a connection" : "Log this entry again", "aria-label": `Undo deleting ${e.displayName}`, "aria-busy": String(busyIds.has(e.id)), disabled: offline || busyIds.has(e.id), onclick: () => onUndo(e) },
                      "Undo",
                    )
                  : el(
                      "button",
                      { type: "button", class: "icon", "data-entry": e.id, title: offline ? "Deleting needs a connection" : "Delete entry", "aria-label": `Delete ${e.displayName}`, "aria-busy": String(busyIds.has(e.id)), disabled: offline || busyIds.has(e.id), onclick: () => onDelete(e) },
                      "✕",
                    )),
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
