import { sumProfiles } from "../core/nutrients";
import { byTime, mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { energyLabel, fmtEnergy, fmtGrams, fmtTime } from "./format";
import type { RowEditor } from "./row-editor";

export interface DiaryTableOptions {
  readonly entries: readonly DiaryEntry[];
  /** IDs written in this session that the API has not returned yet. */
  readonly pendingIds: ReadonlySet<string>;
  /** Entries deleted in this session: still shown, crossed out, with an Undo. They do not count towards the totals. */
  readonly deleted: readonly DiaryEntry[];
  /** The entries with a delete, undo or edit under way, by ID, each with the tag to show: disabled until it succeeds or fails. */
  readonly busy: ReadonlyMap<string, string>;
  /** These actions need a connection, so the buttons are disabled while the browser is offline. */
  readonly offline: boolean;
  /** The row being edited, whose cells hold the editor's own controls. Only one at a time. */
  readonly editing?: RowEditor;
  readonly onEdit: (entry: DiaryEntry) => void;
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

function pencilIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M11.3 1.3a1.5 1.5 0 0 1 2.1 0l1.3 1.3a1.5 1.5 0 0 1 0 2.1l-1.2 1.2-3.4-3.4ZM9 3.6 12.4 7l-7.6 7.6-4 .8.8-4Z");
  svg.append(path);
  return svg;
}

/**
 * Stands in for the delete button on an entry from another app, which the write scope does not cover.
 * A tap or a key opens the explanation, since a title alone never shows on a touch screen.
 */
function notOwnedMark(e: DiaryEntry): DocumentFragment {
  const note = e.sourceLabel ? `Logged by ${e.sourceLabel}, not this app, so it can't be changed here.` : "Logged by another app, so it can't be changed here.";
  const id = `not-owned-${e.id}`;
  const mark = document.createDocumentFragment();
  mark.append(
    el("button", { type: "button", class: "icon not-owned", "data-entry": e.id, title: note, "aria-label": `Why ${e.displayName} can't be changed`, popovertarget: id }, lockIcon()),
    el("div", { id, class: "not-owned-note", popover: "auto" }, note),
  );
  return mark;
}

/** What a row is going through, if anything. */
function rowTag(id: string, deleted: ReadonlySet<string>, busy: ReadonlyMap<string, string>, pending: ReadonlySet<string>): HTMLElement | undefined {
  const text = deleted.has(id) ? "deleted" : (busy.get(id) ?? (pending.has(id) ? "syncing" : undefined));
  return text ? el("span", { class: "tag" }, text) : undefined;
}

export function renderDiaryTable({ entries, pendingIds, deleted, busy, offline, editing, onEdit, onDelete, onUndo }: DiaryTableOptions): HTMLElement {
  if (entries.length === 0 && deleted.length === 0) {
    return el("p", { class: "empty" }, "Nothing logged today yet.");
  }

  const total = sumProfiles(entries.map((e) => e.profile));
  const deletedIds = new Set(deleted.map((e) => e.id));
  const head = ["Time", "Meal", "Food", "Amount", energyLabel(), "Protein", "Carbs", "Fat", ""];

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
        ...[...entries, ...deleted].sort(byTime).map((e) => {
          const editor = editing?.id === e.id ? editing : undefined;
          return el(
            "tr",
            { class: [deletedIds.has(e.id) && "deleted", (pendingIds.has(e.id) || busy.has(e.id)) && "pending", editor && "editing"].filter(Boolean).join(" ") || undefined },
            el("td", {}, fmtTime(e.start)),
            el("td", {}, editor ? editor.meal : mealLabel(e.mealType)),
            el("td", {}, e.displayName, rowTag(e.id, deletedIds, busy, pendingIds)),
            el("td", { class: "num" }, editor ? editor.amount : (e.amount ?? "–")),
            el("td", { class: "num" }, editor ? editor.energy : fmtEnergy(e.profile.energyKcal)),
            el("td", { class: "num" }, editor ? editor.protein : fmtGrams(e.profile.nutrients.protein)),
            el("td", { class: "num" }, editor ? editor.carbs : fmtGrams(e.profile.nutrients.carbohydrates)),
            el("td", { class: "num" }, editor ? editor.fat : fmtGrams(e.profile.nutrients.fat)),
            el(
              "td",
              {},
              el(
                "div",
                { class: "row-actions" },
                editor
                  ? editor.actions
                  : // The write scope only covers entries this app created.
                    !e.own
                  ? notOwnedMark(e)
                  : deletedIds.has(e.id)
                    ? el(
                        "button",
                        { type: "button", class: "icon undo", "data-entry": e.id, title: offline ? "Undoing needs a connection" : "Undo delete (logs this entry again)", "aria-label": `Undo deleting ${e.displayName}`, "aria-busy": String(busy.has(e.id)), disabled: offline || busy.has(e.id), onclick: () => onUndo(e) },
                        // U+FE0E: as text, because some phones would otherwise draw this one as an emoji.
                        "↩\uFE0E",
                      )
                    : [
                        el(
                          "button",
                          { type: "button", class: "icon edit", "data-entry-edit": e.id, title: offline ? "Editing needs a connection" : editing ? "Finish the edit you started first" : "Edit entry", "aria-label": `Edit ${e.displayName}`, disabled: offline || busy.has(e.id) || Boolean(editing), onclick: () => onEdit(e) },
                          pencilIcon(),
                        ),
                        el(
                          "button",
                          { type: "button", class: "icon", "data-entry": e.id, title: offline ? "Deleting needs a connection" : "Delete entry", "aria-label": `Delete ${e.displayName}`, "aria-busy": String(busy.has(e.id)), disabled: offline || busy.has(e.id), onclick: () => onDelete(e) },
                          "✕",
                        ),
                      ],
              ),
            ),
          );
        }),
      ),
      el(
        "tfoot",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "row", colspan: 4 }, `Total (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`),
          el("td", { class: "num" }, fmtEnergy(total.energyKcal)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.protein)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.carbohydrates)),
          el("td", { class: "num" }, fmtGrams(total.nutrients.fat)),
          el("td", {}),
        ),
      ),
    ),
  );
}
