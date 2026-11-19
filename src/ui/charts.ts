/**
 * The dashboard's two kinds of chart, drawn without a library: a segmented bar (one whole split into parts) and a
 * stacked column chart (one column per day). Colours are CSS custom properties named by the caller, so they follow
 * the light and dark themes. Text goes through textContent, as everywhere else (dom.ts).
 */

import { niceScale } from "../core/dashboard";
import { formatNumber } from "../core/units";
import { el } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}

/** A series' identity: its name, and the custom property that holds its colour (e.g. `--macro-protein`). */
export interface Series {
  readonly key: string;
  readonly name: string;
  readonly color: string;
}

const fill = (s: Series) => `var(${s.color})`;

/** The legend: a key and the name of each series, with an optional figure after it. */
function legend(series: readonly Series[], figures?: readonly string[]): HTMLElement {
  return el(
    "ul",
    { class: "chart-legend" },
    ...series.map((s, i) => el("li", {}, el("span", { class: "chart-key", style: `background: ${fill(s)}` }), s.name, figures?.[i] && el("span", { class: "chart-figure" }, figures[i]))),
  );
}

/** A hidden-by-default table with every number the chart shows, for reading without colour or hover. */
function tableView(caption: string, head: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  return el(
    "details",
    { class: "chart-table" },
    el("summary", {}, "Table"),
    el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el("caption", { class: "visually-hidden" }, caption),
        el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { scope: "col", class: i > 0 ? "num" : undefined }, h)))),
        el("tbody", {}, ...rows.map(([first, ...rest]) => el("tr", {}, el("th", { scope: "row" }, first ?? ""), ...rest.map((c) => el("td", { class: "num" }, c))))),
      ),
    ),
  );
}

export interface SegmentedBarOptions {
  readonly title: string;
  readonly series: readonly Series[];
  /** One value per series, in the series' order. */
  readonly values: readonly number[];
  /** A value as the legend prints it, e.g. "32 g". */
  readonly format: (value: number, index: number) => string;
  /** Said instead of the bar when every value is 0. */
  readonly emptyText: string;
}

/** A part narrower than this share of the bar prints no percentage: it would not fit. Its legend entry still has the amount. */
const MIN_LABELLED_SHARE = 0.09;

/**
 * One whole split into parts: a tall bar whose blocks are as wide as their share, each printing its share, with a
 * legend that names the parts and gives their amounts. Hover and the accessible name give every part's figures.
 */
export function segmentedBar({ title, series, values, format, emptyText }: SegmentedBarOptions): HTMLElement {
  const total = values.reduce((a, b) => a + b, 0);
  const share = (v: number) => (total > 0 ? v / total : 0);
  const pct = (v: number) => `${Math.round(share(v) * 100)}%`;
  const describe = (i: number) => `${series[i]!.name} ${format(values[i]!, i)}, ${pct(values[i]!)}`;
  const parts = series.flatMap((s, i) => (values[i]! > 0 ? [i] : []));
  return el(
    "figure",
    { class: "chart segmented" },
    el("figcaption", { class: "chart-title" }, title),
    total > 0
      ? el(
          "div",
          { class: "seg-bar", role: "img", "aria-label": `${title}: ${parts.map(describe).join("; ")}` },
          ...parts.map((i) =>
            el(
              "div",
              { class: `seg seg-${series[i]!.key}`, style: `flex-grow: ${values[i]}; background: ${fill(series[i]!)}`, title: describe(i) },
              share(values[i]!) >= MIN_LABELLED_SHARE ? pct(values[i]!) : "",
            ),
          ),
        )
      : el("p", { class: "chart-empty" }, emptyText),
    // The legend names the parts the bar draws, in its order: a part at 0 has no block to name.
    total > 0 &&
      legend(
        parts.map((i) => series[i]!),
        parts.map((i) => format(values[i]!, i)),
      ),
  );
}

export interface Column {
  /** Under the column, e.g. "Thu 19". */
  readonly label: string;
  /** The tooltip's and table's heading, e.g. "Thursday, 19 Nov 2026". */
  readonly title: string;
  /** One value per series, in the series' order. */
  readonly values: readonly number[];
  /** A line under the tooltip's figures, e.g. the day's logged energy. */
  readonly note?: string;
  /** Drawn in a stronger ink: the day the diary shows. */
  readonly current?: boolean;
}

export interface ColumnChartOptions {
  readonly title: string;
  readonly series: readonly Series[];
  readonly columns: readonly Column[];
  /** A value with its unit, e.g. "32 g". */
  readonly format: (value: number) => string;
  /** The total of a column, with its unit, as the tooltip's last line. */
  readonly formatTotal: (value: number) => string;
  /** The table's column for the total, e.g. "Total (g)"; the table's other headings are the series' names. */
  readonly totalHeading: string;
}

const W = 460;
const H = 220;
const PAD = { left: 40, right: 6, top: 10, bottom: 24 };
const BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** A column's top block: square at the bottom, 4px round corners at the top. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Columns of stacked parts, one per day, on one axis that starts at 0. Hovering or focusing a column shows a tooltip
 * with every part's figure; a table below holds them all.
 */
export function stackedColumns({ title, series, columns, format, formatTotal, totalHeading }: ColumnChartOptions): HTMLElement {
  const totals = columns.map((c) => c.values.reduce((a, b) => a + b, 0));
  const scale = niceScale(Math.max(0, ...totals));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.min(BAR, band * 0.6);
  const y = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;

  const grid = svg("g", { class: "chart-grid" });
  for (let i = 0; i * scale.step <= scale.max + 1e-9; i++) {
    const v = i * scale.step;
    grid.append(
      svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v), class: v === 0 ? "chart-baseline" : undefined }),
      svg("text", { x: PAD.left - 6, y: y(v), class: "chart-tick", "text-anchor": "end", "dominant-baseline": "middle" }, formatNumber(v, 1)),
    );
  }

  const tooltip = el("div", { class: "chart-tooltip", hidden: true, "aria-hidden": "true" });
  const showTip = (i: number, target: SVGElement) => {
    const c = columns[i]!;
    tooltip.replaceChildren(
      el("div", { class: "chart-tooltip-title" }, c.title),
      ...series
        .map((s, k) => ({ s, v: c.values[k]! }))
        .reverse() // Top of the stack first, as it is drawn.
        .map(({ s, v }) => el("div", { class: "chart-tooltip-row" }, el("span", { class: "chart-line-key", style: `background: ${fill(s)}` }), el("strong", {}, format(v)), ` ${s.name}`)),
      el("div", { class: "chart-tooltip-row chart-tooltip-total" }, el("strong", {}, formatTotal(totals[i]!)), " total"),
      ...(c.note ? [el("div", { class: "chart-tooltip-note" }, c.note)] : []),
    );
    // Beside the column, on the side with more room, so that it hides neither the column nor the text above the chart.
    const right = i < columns.length / 2;
    tooltip.style.left = `${((PAD.left + band * (right ? i + 1 : i)) / W) * 100}%`;
    tooltip.classList.toggle("flip", !right);
    tooltip.hidden = false;
    for (const g of plot.querySelectorAll(".chart-column")) g.classList.toggle("active", g === target);
  };
  const hideTip = () => {
    tooltip.hidden = true;
    for (const g of plot.querySelectorAll(".chart-column.active")) g.classList.remove("active");
  };

  const plot = svg("g", {});
  columns.forEach((c, i) => {
    const x = PAD.left + band * i + (band - barW) / 2;
    const top = c.values.reduce((last, v, k) => (v > 0 ? k : last), -1);
    const column = svg("g", {
      class: `chart-column${c.current ? " current" : ""}`,
      tabindex: 0,
      role: "img",
      "aria-label": `${c.title}: ${series.map((s, k) => `${s.name} ${format(c.values[k]!)}`).join(", ")}; total ${formatTotal(totals[i]!)}${c.note ? `; ${c.note}` : ""}`,
    });
    // The hit target is the whole band, from the top of the plot to the day's label, not just the bar.
    column.append(svg("rect", { class: "chart-hit", x: PAD.left + band * i, y: PAD.top, width: band, height: plotH + PAD.bottom }));
    let base = 0;
    c.values.forEach((v, k) => {
      if (!(v > 0)) return;
      // A 2px gap of the surface between stacked parts: each part gives up 1px at each end it shares.
      const y0 = y(base) - (base > 0 ? GAP / 2 : 0);
      base += v;
      const y1 = y(base) + (k === top ? 0 : GAP / 2);
      const h = y0 - y1;
      if (h <= 0) return;
      const style = `fill: ${fill(series[k]!)}`;
      column.append(k === top ? svg("path", { d: roundedTop(x, y1, barW, h), style }) : svg("rect", { x, y: y1, width: barW, height: h, style }));
    });
    column.append(svg("text", { x: x + barW / 2, y: H - 6, class: "chart-tick chart-day", "text-anchor": "middle" }, c.label));
    column.addEventListener("pointerenter", () => showTip(i, column));
    column.addEventListener("focus", () => showTip(i, column));
    column.addEventListener("pointerleave", hideTip);
    column.addEventListener("blur", hideTip);
    plot.append(column);
  });

  return el(
    "figure",
    { class: "chart columns" },
    el("figcaption", { class: "chart-title" }, title),
    legend(series),
    el("div", { class: "chart-plot" }, svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": title }, grid, plot), tooltip),
    tableView(
      title,
      ["Day", ...series.map((s) => s.name), totalHeading],
      columns.map((c, i) => [c.title, ...c.values.map((v) => format(v)), formatTotal(totals[i]!)]),
    ),
  );
}
