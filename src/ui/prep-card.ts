import { formatFraction, isFinished, leftOf, type Prep, type PrepPortion } from "../core/prep";
import { el, replaceChildren } from "./dom";
import { madeAgo, percent } from "./format";

export interface PrepCardState {
  readonly preps: readonly Prep[];
  readonly loading: boolean;
  readonly error: string;
  readonly offline: boolean;
  /** Preps discarded in this session: still shown, with an undo. */
  readonly discarded: ReadonlySet<string>;
  /** Preps with an action under way, so that a second click sends nothing. */
  readonly busy: ReadonlySet<string>;
  /** What happened last, by prep, e.g. "Saved." or why something failed. */
  readonly messages: ReadonlyMap<string, { readonly text: string; readonly error: boolean }>;
  /** The builder is open, so the list makes way for it. */
  readonly building: boolean;
}

export interface PrepCardActions {
  readonly onNew: () => void;
  /** Log a portion: the log form takes over, with the prep chosen. */
  readonly onLog: (prep: Prep) => void;
  readonly onEdit: (prep: Prep) => void;
  readonly onDiscard: (prep: Prep) => void;
  readonly onRestore: (prep: Prep) => void;
  readonly onRemovePortion: (prep: Prep, portion: PrepPortion) => void;
}

/**
 * The Meal prep tab (#55): each batch the user made on one line, with what is left. Portions are logged from the log
 * form, which "Log a portion" opens with the batch chosen. Here a batch is made, edited and discarded, and the
 * portions eaten so far can be given back.
 */
export function createPrepCard(actions: PrepCardActions, builder: HTMLElement) {
  const list = el("div", { class: "prep-list" });
  const status = el("p", { class: "status", role: "status" });
  const newButton = el("button", { type: "button", onclick: () => actions.onNew() }, "New prep");
  const element = el(
    "div",
    { class: "prep-card" },
    el("div", { class: "prep-card-head" }, el("p", { class: "hint" }, "A batch you cooked, eaten bit by bit. Each portion is one diary entry, such as “Chili (1/6)”, as a share of the whole batch."), newButton),
    status,
    builder,
    list,
  );

  function portionRow(prep: Prep, portion: PrepPortion, busy: boolean, offline: boolean): HTMLElement {
    const when = new Date(portion.eatenAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    return el(
      "li",
      {},
      el("span", {}, `${formatFraction(portion.fraction)} · ${when}`),
      portion.state === "unconfirmed" && el("span", { class: "tag", title: "Google Health did not confirm this entry. If it is not in the diary, give it back." }, "not confirmed"),
      el(
        "button",
        { type: "button", class: "link", disabled: busy || offline, onclick: () => actions.onRemovePortion(prep, portion) },
        portion.state === "unconfirmed" ? "Give back" : "Remove",
      ),
    );
  }

  function prepRow(prep: Prep, s: PrepCardState, now: number, openLists: ReadonlySet<string | undefined>): HTMLElement {
    const busy = s.busy.has(prep.id);
    const off = busy || s.offline;
    const discarded = prep.discardedAt !== null;
    const left = leftOf(prep.portions);
    const message = s.messages.get(prep.id);
    const name = el("div", { class: "prep-name" }, el("strong", {}, prep.name), el("span", { class: "prep-age" }, madeAgo(prep.createdAt, now)));
    const buttons = discarded
      ? [el("button", { type: "button", disabled: off, onclick: () => actions.onRestore(prep) }, "Undo discard")]
      : [
          el("button", { type: "button", class: "primary", disabled: busy, onclick: () => actions.onLog(prep) }, "Log a portion"),
          el("button", { type: "button", disabled: off, onclick: () => actions.onEdit(prep) }, "Edit"),
          el("button", { type: "button", disabled: off, onclick: () => actions.onDiscard(prep) }, "Discard"),
        ];
    return el(
      "article",
      { class: discarded ? "prep discarded" : "prep", "data-prep": prep.id },
      el(
        "div",
        { class: "prep-line" },
        name,
        discarded ? el("span", { class: "prep-left" }, "discarded") : el("meter", { min: 0, max: 1, value: left, "aria-label": `${percent(left)} of ${prep.name} left` }),
        el("span", { class: "prep-left" }, discarded ? "" : `${percent(left)} left`),
        el("div", { class: "actions" }, ...buttons),
      ),
      message && el("p", { class: message.error ? "status error" : "status", role: message.error ? "alert" : "status" }, message.text),
      !discarded &&
        prep.portions.length > 0 &&
        el(
          "details",
          { class: "prep-portions", open: openLists.has(prep.id) },
          el("summary", {}, `Eaten so far (${prep.portions.length})`),
          el("ul", {}, ...prep.portions.map((p) => portionRow(prep, p, busy, s.offline))),
        ),
    );
  }

  function update(next: PrepCardState) {
    newButton.disabled = next.building || next.offline;
    status.textContent = next.loading ? "Loading…" : next.error;
    status.classList.toggle("error", !next.loading && Boolean(next.error));
    // Keep the open portion lists open across redraws.
    const openLists = new Set([...list.querySelectorAll<HTMLElement>("[data-prep]")].filter((a) => a.querySelector("details")?.open).map((a) => a.dataset["prep"]));
    const now = Date.now();
    const shown = next.preps.filter((p) => (p.discardedAt === null ? !isFinished(p) : next.discarded.has(p.id)));
    list.hidden = next.building;
    replaceChildren(list, shown.length === 0 && !next.loading ? el("p", { class: "empty" }, "Nothing prepared. Start one with New prep while you cook.") : shown.map((p) => prepRow(p, next, now, openLists)));
  }

  return { element, update };
}

export type PrepCard = ReturnType<typeof createPrepCard>;
