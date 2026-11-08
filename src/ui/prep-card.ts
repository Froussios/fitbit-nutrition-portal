import { formatFraction, isFinished, leftOf, parseFraction, portionProfile, type Prep, type PrepPortion } from "../core/prep";
import { MEAL_TYPES } from "../health/mapping";
import type { MealType } from "../health/types";
import { el, replaceChildren } from "./dom";
import { summary } from "./format";

const DAY_MS = 24 * 60 * 60_000;

export interface PrepCardState {
  readonly preps: readonly Prep[];
  readonly loading: boolean;
  readonly error: string;
  readonly offline: boolean;
  /** Preps discarded in this session: still shown, with an undo. */
  readonly discarded: ReadonlySet<string>;
  /** Preps with an action under way, so that a second click sends nothing. */
  readonly busy: ReadonlySet<string>;
  /** What happened last, by prep, e.g. "Logged 1/6." or why it failed. */
  readonly messages: ReadonlyMap<string, { readonly text: string; readonly error: boolean }>;
  /** The builder is open, so the list makes way for it. */
  readonly building: boolean;
}

export interface PrepCardActions {
  readonly onNew: () => void;
  readonly onEdit: (prep: Prep) => void;
  /** A null fraction eats the rest. */
  readonly onEat: (prep: Prep, fraction: number | null, mealType: MealType | undefined) => void;
  readonly onDiscard: (prep: Prep) => void;
  readonly onRestore: (prep: Prep) => void;
  readonly onRemovePortion: (prep: Prep, portion: PrepPortion) => void;
}

/** What one prep's row keeps across redraws, so a refresh doesn't lose what the user typed. */
interface Controls {
  readonly amount: HTMLInputElement;
  readonly meal: HTMLSelectElement;
  readonly preview: HTMLElement;
}

function age(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / DAY_MS);
  return days <= 0 ? "made today" : days === 1 ? "made yesterday" : `made ${days} days ago`;
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/**
 * The preps the user has made (#55): what is left of each, and a quick way to eat some. A fraction
 * is of the whole batch. Weights are not offered, because the ingredients don't add up to the cooked weight.
 */
export function createPrepCard(actions: PrepCardActions, builder: HTMLElement) {
  const controls = new Map<string, Controls>();
  const list = el("div", { class: "prep-list" });
  const status = el("p", { class: "status", role: "status" });
  const newButton = el("button", { type: "button", onclick: () => actions.onNew() }, "New prep");
  const element = el(
    "section",
    { class: "card prep-card", hidden: true },
    el("div", { class: "card-head" }, el("h2", {}, "Meal prep"), newButton),
    status,
    builder,
    list,
    el("p", { class: "hint" }, "A batch you cooked, eaten bit by bit. Each portion is one diary entry, such as “Chili (1/6)”, as a fraction of the whole batch."),
  );
  let state: PrepCardState | undefined;

  function controlsFor(prep: Prep): Controls {
    let c = controls.get(prep.id);
    if (!c) {
      const amount = el("input", { type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "1/6, 25% or 0.25", "aria-label": `How much of ${prep.name}`, size: 12 });
      const meal = el("select", { "aria-label": "Meal" }, el("option", { value: "" }, "No meal"), ...MEAL_TYPES.map((m) => el("option", { value: m.value }, m.label)));
      const preview = el("p", { class: "preview", "aria-live": "polite" });
      amount.addEventListener("input", () => showPreview(prep.id));
      amount.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          eat(prep.id, false);
        }
      });
      c = { amount, meal, preview };
      controls.set(prep.id, c);
    }
    return c;
  }

  function current(id: string): Prep | undefined {
    return state?.preps.find((p) => p.id === id);
  }

  function showPreview(id: string) {
    const prep = current(id);
    const c = controls.get(id);
    if (!prep || !c) return;
    const left = leftOf(prep.portions);
    const text = c.amount.value.trim();
    const fraction = text ? parseFraction(text) : undefined;
    c.preview.classList.toggle("error", Boolean(text) && (fraction === undefined || fraction > left + 1e-6));
    if (!text) c.preview.textContent = `The rest ≈ ${summary(portionProfile(prep.ingredients, left))}`;
    else if (fraction === undefined) c.preview.textContent = "Enter a fraction of the batch, such as 1/6, 25% or 0.25.";
    else if (fraction > left + 1e-6) c.preview.textContent = `Only ${percent(left)} is left.`;
    else c.preview.textContent = `≈ ${summary(portionProfile(prep.ingredients, fraction))} · leaves ${percent(left - fraction)}`;
  }

  function eat(id: string, rest: boolean) {
    const prep = current(id);
    const c = controls.get(id);
    if (!prep || !c || state?.busy.has(id) || state?.offline) return;
    const meal = (c.meal.value || undefined) as MealType | undefined;
    if (rest) {
      actions.onEat(prep, null, meal);
      return;
    }
    const fraction = parseFraction(c.amount.value);
    if (fraction === undefined || fraction > leftOf(prep.portions) + 1e-6) {
      showPreview(id);
      c.amount.focus();
      return;
    }
    actions.onEat(prep, fraction, meal);
  }

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

  function prepRow(prep: Prep, s: PrepCardState, now: number): HTMLElement {
    const c = controlsFor(prep);
    const busy = s.busy.has(prep.id);
    const discarded = prep.discardedAt !== null;
    const left = leftOf(prep.portions);
    const message = s.messages.get(prep.id);
    const head = el(
      "div",
      { class: "prep-head" },
      el("h3", {}, prep.name),
      el("span", { class: "prep-left" }, discarded ? "discarded" : `${percent(left)} left`),
      el("span", { class: "prep-age" }, age(prep.createdAt, now)),
    );
    if (discarded) {
      return el(
        "article",
        { class: "prep discarded", "data-prep": prep.id },
        head,
        el("div", { class: "actions" }, el("button", { type: "button", disabled: busy || s.offline, onclick: () => actions.onRestore(prep) }, "Undo discard")),
        message && el("p", { class: message.error ? "status error" : "status" }, message.text),
      );
    }
    c.amount.disabled = busy;
    showPreview(prep.id);
    return el(
      "article",
      { class: "prep", "data-prep": prep.id },
      head,
      el("meter", { min: 0, max: 1, value: left, "aria-label": `${percent(left)} of ${prep.name} left` }),
      el(
        "div",
        { class: "row prep-eat" },
        el("label", { class: "field" }, el("span", {}, "Amount"), c.amount),
        el("label", { class: "field" }, el("span", {}, "Meal"), c.meal),
      ),
      c.preview,
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", class: "primary", disabled: busy || s.offline, onclick: () => eat(prep.id, false) }, "Eat"),
        el("button", { type: "button", disabled: busy || s.offline, onclick: () => eat(prep.id, true) }, "Eat the rest"),
        el("button", { type: "button", disabled: busy || s.offline, onclick: () => actions.onEdit(prep) }, "Edit"),
        el("button", { type: "button", disabled: busy || s.offline, onclick: () => actions.onDiscard(prep) }, "Discard"),
      ),
      message && el("p", { class: message.error ? "status error" : "status", role: message.error ? "alert" : "status" }, message.text),
      prep.portions.length > 0 &&
        el(
          "details",
          { class: "prep-portions" },
          el("summary", {}, `Eaten so far (${prep.portions.length})`),
          el("ul", {}, ...prep.portions.map((p) => portionRow(prep, p, busy, s.offline))),
        ),
    );
  }

  function update(next: PrepCardState) {
    state = next;
    element.hidden = false;
    newButton.disabled = next.building || next.offline;
    status.textContent = next.loading ? "Loading…" : next.error;
    status.classList.toggle("error", !next.loading && Boolean(next.error));
    // Keep the open portion lists open across redraws.
    const openLists = new Set([...list.querySelectorAll<HTMLElement>("[data-prep]")].filter((a) => a.querySelector("details")?.open).map((a) => a.dataset["prep"]));
    const now = Date.now();
    const shown = next.preps.filter((p) => (p.discardedAt === null ? !isFinished(p) : next.discarded.has(p.id)));
    for (const id of controls.keys()) if (!shown.some((p) => p.id === id)) controls.delete(id);
    list.hidden = next.building;
    replaceChildren(list, shown.length === 0 && !next.loading ? el("p", { class: "empty" }, "Nothing prepared. Start one with New prep while you cook.") : shown.map((p) => prepRow(p, next, now)));
    for (const id of openLists) {
      const details = list.querySelector<HTMLDetailsElement>(`[data-prep="${CSS.escape(id ?? "")}"] details`);
      if (details) details.open = true;
    }
  }

  /** Clears what was typed for a prep, after a portion is logged. */
  function clearAmount(id: string) {
    const c = controls.get(id);
    if (c) {
      c.amount.value = "";
      c.meal.value = "";
    }
  }

  return {
    element,
    update,
    clearAmount,
    hide: () => (element.hidden = true),
    refreshPreview: () => state && update(state),
  };
}

export type PrepCard = ReturnType<typeof createPrepCard>;
