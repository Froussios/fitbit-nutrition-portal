/** Tiny DOM helpers. Text always goes through textContent, so user and API data cannot inject HTML. */

type Child = Node | string | number | null | undefined | false | readonly Child[];
type Attrs = Record<string, string | number | boolean | undefined | EventListener>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = String(v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  append(node, ...children);
  return node;
}

export function append(parent: ParentNode, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, ...(c as readonly Child[]));
    else parent.append(typeof c === "number" ? String(c) : (c as Node | string));
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

const TABBABLE = "a[href], button, input, select, textarea, summary, [contenteditable], [tabindex]";

const tabbable = (node: HTMLElement): boolean =>
  node.tabIndex >= 0 &&
  !(node as HTMLInputElement).disabled &&
  // Tab stops only on the chosen radio of a group.
  !(node instanceof HTMLInputElement && node.type === "radio" && node.name && !node.checked) &&
  !node.closest("[hidden]") &&
  (typeof node.checkVisibility !== "function" || node.checkVisibility({ visibilityProperty: true }));

/**
 * Makes Tab and Shift+Tab leave a control in one step. Browsers give each part of a
 * date or time input (day, month, year, hour, minute, AM/PM) its own Tab stop; with this,
 * the arrow keys move between those parts instead, as they already do once inside.
 */
export function singleTabStop(control: HTMLElement): void {
  control.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const order = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((n) => n === control || tabbable(n));
    const next = order[order.indexOf(control) + (e.shiftKey ? -1 : 1)];
    e.preventDefault();
    // First or last on the page: the browser's own Tab would only move to another part, so let go of focus.
    if (next) next.focus();
    else control.blur();
  });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
