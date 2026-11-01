import { clearLog, formatEntry, formatLog, logEntries, onLog } from "../debug/log";
import { el } from "./dom";

/**
 * Collapsible "Debug log" panel at the bottom of every screen. Copy puts the
 * whole log, with an environment header, on the clipboard for a bug report.
 */
export function createDebugPanel(environment: () => Record<string, string>): HTMLElement {
  const summary = el("summary", {});
  const pre = el("pre", { class: "debug-log" });
  const status = el("span", { class: "hint" });

  const copy = el("button", {
    type: "button",
    onclick: async () => {
      const text = formatLog(environment());
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = "Copied.";
      } catch {
        // Clipboard blocked: select the text so the user can copy it by hand.
        pre.textContent = text;
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        status.textContent = "Clipboard unavailable: the log is selected, press Ctrl+C / Cmd+C.";
      }
    },
  }, "Copy log");
  const clear = el("button", { type: "button", onclick: () => clearLog() }, "Clear");

  const panel = el(
    "details",
    { class: "card debug" },
    summary,
    el("div", { class: "actions" }, copy, clear, status),
    pre,
  );

  const update = () => {
    const all = logEntries();
    const errors = all.filter((e) => e.level === "error").length;
    summary.textContent = `Debug log (${all.length} entries${errors ? `, ${errors} errors` : ""})`;
    summary.classList.toggle("error", errors > 0);
    pre.textContent = all.map(formatEntry).join("\n");
    pre.scrollTop = pre.scrollHeight;
  };
  onLog(update);
  update();
  return panel;
}
