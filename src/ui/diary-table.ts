import { sumProfiles } from "../core/nutrients";
import { byMeal, isSavedMeal, mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { formatAmount } from "../core/units";
import { amountText, energyLabel, fmtEnergy, fmtGrams } from "./format";
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
  /** Logs the same food, amount and meal again, today at the current time (DR-36). */
  readonly onRepeat: (entry: DiaryEntry) => void;
  /** Whether the day shown is today: only today's entries have a + button. */
  readonly today?: boolean;
  /** Adds the entry's step to its amount (DR-37). */
  readonly onIncrement?: (entry: DiaryEntry) => void;
  /** What an empty day says. */
  readonly emptyText?: string;
  /** Opens the chat about this entry (DR-41). Left out while the chat can't be used, and the rows then have no chat button. */
  readonly onAsk?: (entry: DiaryEntry) => void;
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

/** Two sheets, the front one with a plus: another of this entry. */
function repeatIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute(
    "d",
    "M2.5 1A1.5 1.5 0 0 0 1 2.5v7A1.5 1.5 0 0 0 2.5 11H4V9.5H2.5v-7h7V4H11V2.5A1.5 1.5 0 0 0 9.5 1ZM6.5 5A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 5Zm2.75 2h1.5v2.25H13v1.5h-2.25V13h-1.5v-2.25H7v-1.5h2.25Z",
  );
  svg.append(path);
  return svg;
}

/** A speech bubble: ask the chat about this entry. */
function askIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12H4v3l3.6-3h5.9a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 2Z");
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

/**
 * The Amount cell outside the editor: the serving, a mark for a saved meal, which has no amount of its own (DR-44), or
 * "–" when the entry recorded none.
 */
function amountCell(e: DiaryEntry): HTMLElement | string {
  const text = amountText(e);
  return e.amount === undefined && isSavedMeal(e) ? el("span", { class: "from-meal", title: "Logged from a saved meal, as one entry with no amount of its own" }, text) : text;
}

export function renderDiaryTable({ entries, pendingIds, deleted, busy, offline, editing, onEdit, onDelete, onUndo, onRepeat, today = false, onIncrement, emptyText = "Nothing logged today yet.", onAsk }: DiaryTableOptions): HTMLElement {
  if (entries.length === 0 && deleted.length === 0) {
    return el("p", { class: "empty" }, emptyText);
  }

  const total = sumProfiles(entries.map((e) => e.profile));
  const deletedIds = new Set(deleted.map((e) => e.id));
  // No time column: entries are grouped by meal, and a time that disagrees with its meal only confuses.
  const head = ["Meal", "Food", "Amount", energyLabel(), "Protein", "Carbs", "Fat", ""];

  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { scope: "col", class: i >= 2 && i <= 6 ? "num" : undefined }, h)))),
      el(
        "tbody",
        {},
        ...[...entries, ...deleted].sort(byMeal).map((e) => {
          const editor = editing?.id === e.id ? editing : undefined;
          // Whether the row has an Edit button (a meal prep share is changed from its batch), and whether it is enabled.
          // A double-click on the row opens the editor under the same conditions.
          const hasEdit = e.own && !deletedIds.has(e.id) && e.ref?.source !== "prep";
          const canEdit = !offline && !busy.has(e.id) && !editing;
          const editable = hasEdit && canEdit;
          // On today's entries, + adds one more of what was logged (DR-37). It replaces the entry, like an edit.
          const step = today && onIncrement && !deletedIds.has(e.id) ? e.increment : undefined;
          const stepText = step && `${formatAmount(step.amount)} ${step.unit}`;
          const incrementButton =
            step &&
            el(
              "button",
              { type: "button", class: "icon increment", "data-entry-increment": e.id, title: offline ? "Changing needs a connection" : `Add ${stepText}`, "aria-label": `Add ${stepText} to ${e.displayName}`, "aria-busy": String(busy.has(e.id)), disabled: offline || busy.has(e.id), onclick: () => onIncrement?.(e) },
              `+${stepText}`,
            );
          // Any entry can be logged again, whichever app logged it, but a meal prep share would need a portion of its batch.
          const repeatButton =
            !deletedIds.has(e.id) &&
            e.ref?.source !== "prep" &&
            el(
              "button",
              { type: "button", class: "icon repeat", "data-entry-repeat": e.id, title: offline ? "Logging needs a connection" : "Log again today", "aria-label": `Log ${e.displayName} again today`, "aria-busy": String(busy.has(e.id)), disabled: offline || busy.has(e.id), onclick: () => onRepeat(e) },
              repeatIcon(),
            );
          // Any entry can be asked about, whichever app logged it: the chat says what it can't change.
          const askButton =
            onAsk &&
            !deletedIds.has(e.id) &&
            el(
              "button",
              { type: "button", class: "icon ask", "data-entry-ask": e.id, title: "Ask the chat about this entry", "aria-label": `Ask the chat about ${e.displayName}`, onclick: () => onAsk(e) },
              askIcon(),
            );
          return el(
            "tr",
            {
              class: [deletedIds.has(e.id) && "deleted", (pendingIds.has(e.id) || busy.has(e.id)) && "pending", editor && "editing"].filter(Boolean).join(" ") || undefined,
              // A double-click anywhere on the row but its buttons opens it for editing, like its Edit button.
              ondblclick: editable
                ? (ev: Event) => {
                    if (ev.target instanceof Element && ev.target.closest("button, [popover]")) return;
                    // The double-click also selected a word, which would stay highlighted behind the editor.
                    window.getSelection()?.removeAllRanges();
                    onEdit(e);
                  }
                : undefined,
            },
            el("td", {}, editor ? el("div", { class: "when-edit" }, editor.meal, editor.day) : mealLabel(e.mealType)),
            el("td", {}, e.displayName, rowTag(e.id, deletedIds, busy, pendingIds)),
            el("td", { class: "num" }, editor ? editor.amount : amountCell(e)),
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
                  ? [askButton, repeatButton, notOwnedMark(e)]
                  : deletedIds.has(e.id)
                    ? el(
                        "button",
                        { type: "button", class: "icon undo", "data-entry": e.id, title: offline ? "Undoing needs a connection" : "Undo delete (logs this entry again)", "aria-label": `Undo deleting ${e.displayName}`, "aria-busy": String(busy.has(e.id)), disabled: offline || busy.has(e.id), onclick: () => onUndo(e) },
                        // U+FE0E: as text, because some phones would otherwise draw this one as an emoji.
                        "↩\uFE0E",
                      )
                    : [
                        incrementButton,
                        askButton,
                        repeatButton,
                        hasEdit &&
                        el(
                          "button",
                          { type: "button", class: "icon edit", "data-entry-edit": e.id, title: offline ? "Editing needs a connection" : editing ? "Finish the edit you started first" : "Edit entry", "aria-label": `Edit ${e.displayName}`, disabled: !canEdit, onclick: () => onEdit(e) },
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
          el("th", { scope: "row", colspan: 3 }, `Total (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`),
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
