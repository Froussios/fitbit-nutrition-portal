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

const SVG_NS = "http://www.w3.org/2000/svg";

function lockIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("d", "M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4ZM5.5 7V5a2.5 2.5 0 0 1 5 0v2Z");
  svg.append(path);
  return svg;
}

/**
 * Stands in for the delete button on an entry from another app, which the write scope does not cover.
 * A tap or a key opens the explanation, since a title alone never shows on a touch screen.
 */
function notOwnedMark(e: DiaryEntry): DocumentFragment {
  const note = e.sourceLabel ? `Logged by ${e.sourceLabel}, not this app, so it can't be deleted here.` : "Logged by another app, so it can't be deleted here.";
  const id = `not-owned-${e.id}`;
  const mark = document.createDocumentFragment();
  mark.append(
    el("button", { type: "button", class: "icon not-owned", "data-entry": e.id, title: note, "aria-label": `Why ${e.displayName} can't be deleted`, popovertarget: id }, lockIcon()),
    el("div", { id, class: "not-owned-note", popover: "auto" }, note),
  );
  return mark;
}

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
  const head = ["Time", "Meal", "Food", "Amount", "kcal", "kJ", "Protein", "Carbs", "Fat", ""];

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
            el(
              "td",
              {},
              // The write scope only covers entries this app created.
              !e.own
                ? notOwnedMark(e)
                : deletedIds.has(e.id)
                  ? el(
                      "button",
                      { type: "button", class: "link", "data-entry": e.id, title: offline ? "Undoing needs a connection" : "Log this entry again", "aria-label": `Undo deleting ${e.displayName}`, "aria-busy": String(busyIds.has(e.id)), disabled: offline || busyIds.has(e.id), onclick: () => onUndo(e) },
                      "Undo",
                    )
                  : el(
                      "button",
                      { type: "button", class: "icon", "data-entry": e.id, title: offline ? "Deleting needs a connection" : "Delete entry", "aria-label": `Delete ${e.displayName}`, "aria-busy": String(busyIds.has(e.id)), disabled: offline || busyIds.has(e.id), onclick: () => onDelete(e) },
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
          el("td", {}),
        ),
      ),
    ),
  );
}
