/**
 * Keyboard model of the food search field (docs/FOOD_SEARCH.md section 3.2),
 * as a pure reducer so every rule is unit-testable without a DOM.
 *
 * Rows are the search hits (0 .. hits-1) followed by the "Custom food" row
 * (index `hits`), when there is one. `active` is -1 when no row is active: the
 * field then shows what the user typed (`query`); otherwise the active hit's label.
 */

export interface ComboState {
  /** What the user typed. */
  readonly query: string;
  readonly open: boolean;
  /** -1 for none, else a row index. */
  readonly active: number;
  /** Number of search hits shown (the custom-food row comes after them). */
  readonly hits: number;
  /** Whether the custom-food row follows the hits. */
  readonly custom: boolean;
}

export type ComboEvent =
  | { readonly type: "input"; readonly text: string }
  | { readonly type: "results"; readonly hits: number; readonly custom?: boolean }
  | { readonly type: "down" }
  | { readonly type: "up" }
  | { readonly type: "escape" }
  | { readonly type: "focus" }
  | { readonly type: "close" }
  /** A row was chosen; the field now shows `text`. */
  | { readonly type: "chosen"; readonly text: string };

export const INITIAL: ComboState = { query: "", open: false, active: -1, hits: 0, custom: true };

/** Searches start at this many characters. */
export const MIN_QUERY = 2;

const searchable = (q: string) => q.trim().length >= MIN_QUERY;

export function reduce(s: ComboState, e: ComboEvent): ComboState {
  const rows = s.hits + (s.custom ? 1 : 0);
  switch (e.type) {
    case "input":
      return { ...s, query: e.text, active: -1, open: searchable(e.text) };
    case "results": {
      const custom = e.custom ?? true;
      return { ...s, hits: e.hits, custom, active: s.active >= e.hits + (custom ? 1 : 0) ? -1 : s.active };
    }
    case "focus":
      return searchable(s.query) ? { ...s, open: true } : s;
    case "down":
      if (!s.open) return searchable(s.query) ? { ...s, open: true, active: -1 } : s;
      return { ...s, active: s.active + 1 >= rows ? -1 : s.active + 1 };
    case "up":
      if (!s.open) return s;
      return { ...s, active: s.active - 1 < -1 ? rows - 1 : s.active - 1 };
    case "escape":
      if (s.open && s.active >= 0) return { ...s, active: -1 };
      if (s.open) return { ...s, open: false };
      return { ...s, query: "" };
    case "close":
      return { ...s, open: false, active: -1 };
    case "chosen":
      return { ...s, query: e.text, open: false, active: -1 };
  }
}

/** What the input field should show for a state. */
export function fieldText(s: ComboState, hitLabel: (row: number) => string): string {
  return s.open && s.active >= 0 && s.active < s.hits ? hitLabel(s.active) : s.query;
}
