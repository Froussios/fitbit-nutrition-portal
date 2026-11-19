/**
 * A change the chat proposes, shown in full so the user can tell exactly which entry it touches, with Accept and
 * Reject (DR-41). Entries are named by what the user sees in the diary (food, amount, meal, day and time, nutrients),
 * never by ID.
 */

import { clockTime, energyRecorded } from "../ai/chat-protocol";
import type { Proposal } from "../ai/chat-tools";
import { dayLabel } from "../core/time";
import { entryDay, mealLabel, type DiaryEntry } from "../health/mapping";
import { el } from "./dom";
import { amountText, energyLabel, fmtEnergy, fmtGrams } from "./format";

export type ProposalState =
  | { readonly kind: "waiting" }
  | { readonly kind: "applying" }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "rejected" };

export interface ProposalCard {
  readonly element: HTMLElement;
  set(state: ProposalState): void;
}

const mealText = (e: DiaryEntry) => (e.mealType === "MEAL_TYPE_UNSPECIFIED" ? "No meal" : mealLabel(e.mealType));
const whenText = (e: DiaryEntry, today: string) => `${dayLabel(entryDay(e), today)}, ${clockTime(e.start)}`;

/** What identifies an entry to the user: everything its diary row shows, and when it was eaten. */
function facts(e: DiaryEntry, today: string): [string, string][] {
  return [
    ["Food", e.displayName],
    ["Amount", amountText(e)],
    ["Meal", mealText(e)],
    ["When", whenText(e, today)],
    ["Nutrients", nutrients(e)],
  ];
}

/** Energy and the main nutrients. A value the entry doesn't state says so, rather than showing as 0. */
function nutrients(e: DiaryEntry): string {
  const n = e.profile.nutrients;
  const energy = energyRecorded(e) ? `${fmtEnergy(e.profile.energyKcal)} ${energyLabel()}` : "energy not recorded";
  const grams = (g: number | undefined) => (g === undefined ? "not recorded" : fmtGrams(g));
  return `${energy} · protein ${grams(n.protein)} · carbs ${grams(n.carbohydrates)} · fat ${grams(n.fat)}`;
}

function list(rows: readonly (readonly [string, string | HTMLElement])[]): HTMLElement {
  return el("dl", { class: "proposal-facts" }, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

/** "before → after", with each side marked for screen readers. */
function change(before: string, after: string): HTMLElement {
  return el("span", { class: "change" }, el("span", { class: "before" }, before), el("span", { "aria-hidden": "true" }, " → "), el("span", { class: "visually-hidden" }, " becomes "), el("span", { class: "after" }, after));
}

function body(p: Proposal, today: string): { title: string; content: HTMLElement[] } {
  switch (p.kind) {
    case "log":
      return { title: "Log this?", content: [list(facts(p.preview, today))] };
    case "delete":
      return { title: "Delete this entry?", content: [list(facts(p.entry, today))] };
    case "edit": {
      const before = facts(p.entry, today);
      const after = new Map(facts(p.preview, today));
      // The entry as it is, then only what changes. "When" changes only with the day: the time stays.
      const changes = before.filter(([k, v]) => k !== "Food" && after.get(k) !== v).map(([k, v]) => [k, change(v, after.get(k) ?? "–")] as const);
      return {
        title: "Change this entry?",
        content: [list(before), el("p", { class: "proposal-sub" }, "Changes"), list(changes)],
      };
    }
  }
}

const ACCEPT_LABEL: Readonly<Record<Proposal["kind"], string>> = { log: "Log it", edit: "Save change", delete: "Delete it" };

export function createProposalCard(proposal: Proposal, today: string, onDecide: (accept: boolean) => void): ProposalCard {
  const { title, content } = body(proposal, today);
  const name = proposal.kind === "log" ? proposal.preview.displayName : proposal.entry.displayName;
  const accept = el("button", { type: "button", class: proposal.kind === "delete" ? "primary danger" : "primary", "aria-label": `${ACCEPT_LABEL[proposal.kind]}: ${name}`, onclick: () => onDecide(true) }, ACCEPT_LABEL[proposal.kind]);
  const reject = el("button", { type: "button", "aria-label": `Reject: ${name}`, onclick: () => onDecide(false) }, "Reject");
  const actions = el("div", { class: "actions" }, accept, reject);
  const status = el("p", { class: "proposal-status", role: "status" });
  const element = el("section", { class: `proposal proposal-${proposal.kind}`, "aria-label": title }, el("h3", {}, title), ...content, actions, status);

  return {
    element,
    set(state) {
      actions.hidden = state.kind !== "waiting" && state.kind !== "applying";
      accept.disabled = reject.disabled = state.kind === "applying";
      element.classList.toggle("settled", state.kind !== "waiting" && state.kind !== "applying");
      status.classList.toggle("error", state.kind === "failed");
      status.textContent =
        state.kind === "applying" ? "Saving…" : state.kind === "done" ? state.text : state.kind === "failed" ? state.text : state.kind === "rejected" ? "Rejected. Nothing was changed." : "";
    },
  };
}
