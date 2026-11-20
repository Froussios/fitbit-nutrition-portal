/**
 * The dashboard's charts, drawn without a library: a segmented bar and a ring (one whole split into parts) and a
 * stacked column chart (one column per day). Colours are CSS custom properties named by the caller, so they follow
 * the light and dark themes. Text goes through textContent, as everywhere else (dom.ts). Each chart can carry a
 * reference figure to set the parts against, such as the calories burnt (DR-46): a marker on the bar or the ring, a line
 * on each column.
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

/** A reference's entry in a legend: a line for a key, its name and an optional figure. */
interface LegendMarker {
  readonly name: string;
  readonly color: string;
  readonly figure?: string;
}

/** The legend: a key and the name of each series, with an optional figure after it, and the reference's line last. */
function legend(series: readonly Series[], figures?: readonly string[], marker?: LegendMarker): HTMLElement {
  return el(
    "ul",
    { class: "chart-legend" },
    ...series.map((s, i) => el("li", {}, el("span", { class: "chart-key", style: `background: ${fill(s)}` }), s.name, figures?.[i] && el("span", { class: "chart-figure" }, figures[i]))),
    marker &&
      el(
        "li",
        { class: "chart-legend-marker" },
        el("span", { class: "chart-marker-key", style: `background: var(${marker.color})` }),
        marker.name,
        marker.figure && el("span", { class: "chart-figure" }, marker.figure),
      ),
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
  /**
   * A figure to set the whole against, such as the calories burnt. The bar is drawn to the larger of the two, so a
   * whole short of it leaves an outlined gap up to it; a marker shows where it falls.
   */
  readonly reference?: BarReference;
}

export interface BarReference {
  readonly name: string;
  /** The custom property that holds its colour. */
  readonly color: string;
  readonly value: number;
  /** Its value and its difference from the whole, with their unit. */
  readonly format: (value: number) => string;
  /** How a reference above the whole is said to differ from it, e.g. "more than eaten". */
  readonly above: string;
  /** How a reference below the whole is said to differ from it, e.g. "less than eaten". */
  readonly below: string;
}

/** The gap of the surface between a segmented bar's blocks, in px, as in `.seg-bar`. */
const SEG_GAP = 2;

/**
 * Where `value` falls on a segmented bar of `blocks` (their values, in order), as a CSS length: the blocks share the
 * bar's width less its gaps, so each gap passed is added back. A value on a boundary between blocks sits in the gap.
 */
export function markerLeft(value: number, blocks: readonly number[]): string {
  const whole = blocks.reduce((a, b) => a + b, 0);
  if (!(whole > 0) || value >= whole) return "100%";
  let end = 0;
  let passed = 0;
  let onBoundary = false;
  for (const b of blocks.slice(0, -1)) {
    end += b;
    // Sums of floats: a value within a rounding error of a boundary is on it.
    const close = Math.abs(end - value) <= 1e-9 * whole;
    if (end < value && !close) passed++;
    else {
      onBoundary = close;
      break;
    }
  }
  const share = value / whole;
  const px = passed * SEG_GAP - share * SEG_GAP * (blocks.length - 1) + (onBoundary ? SEG_GAP / 2 : 0);
  const offset = Number(px.toFixed(3));
  return `calc(${share * 100}% ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}px)`;
}

/**
 * What a bar and a ring both work out from their parts: the whole, each part's share and description, the parts with
 * something in them, and the reference with its difference from the whole ("2,300 kcal, 450 kcal more than eaten").
 */
function wholeOf(series: readonly Series[], values: readonly number[], format: (value: number, index: number) => string, reference: BarReference | undefined) {
  const total = values.reduce((a, b) => a + b, 0);
  const share = (v: number) => (total > 0 ? v / total : 0);
  const pct = (v: number) => `${Math.round(share(v) * 100)}%`;
  const describe = (i: number) => `${series[i]!.name} ${format(values[i]!, i)}, ${pct(values[i]!)}`;
  const parts = series.flatMap((s, i) => (values[i]! > 0 ? [i] : []));
  const ref = reference && reference.value > 0 ? reference : undefined;
  const gap = ref ? ref.value - total : 0;
  const refText = ref && `${ref.format(ref.value)}, ${ref.format(Math.abs(gap))} ${gap >= 0 ? ref.above : ref.below}`;
  return { total, share, pct, describe, parts, ref, gap, refText };
}

/** A part narrower than this share of the bar prints no percentage: it would not fit. Its legend entry still has the amount. */
const MIN_LABELLED_SHARE = 0.09;

/**
 * One whole split into parts: a tall bar whose blocks are as wide as their share, each printing its share, with a
 * legend that names the parts and gives their amounts. Hover and the accessible name give every part's figures.
 */
export function segmentedBar({ title, series, values, format, emptyText, reference }: SegmentedBarOptions): HTMLElement {
  const { total, share, pct, describe, parts, ref, gap, refText } = wholeOf(series, values, format, reference);
  return el(
    "figure",
    { class: "chart segmented" },
    el("figcaption", { class: "chart-title" }, title),
    total > 0
      ? el(
          "div",
          { class: "seg-bar", role: "img", "aria-label": `${title}: ${parts.map(describe).join("; ")}${ref ? `; ${ref.name} ${refText}` : ""}` },
          ...parts.map((i) =>
            el(
              "div",
              { class: `seg seg-${series[i]!.key}`, style: `flex-grow: ${values[i]}; background: ${fill(series[i]!)}`, title: describe(i) },
              share(values[i]!) >= MIN_LABELLED_SHARE ? pct(values[i]!) : "",
            ),
          ),
          ref && gap > 0 && el("div", { class: "seg seg-rest", style: `flex-grow: ${gap}`, title: `${ref.name} ${ref.format(gap)} ${ref.above}` }),
          ref && el("div", { class: "seg-marker", style: `left: ${markerLeft(ref.value, [...parts.map((i) => values[i]!), ...(gap > 0 ? [gap] : [])])}; background: var(${ref.color})`, title: `${ref.name} ${ref.format(ref.value)}` }),
        )
      : el("p", { class: "chart-empty" }, emptyText),
    // The legend names the parts the bar draws, in its order: a part at 0 has no block to name.
    total > 0 &&
      legend(
        parts.map((i) => series[i]!),
        parts.map((i) => format(values[i]!, i)),
        ref && { name: ref.name, color: ref.color, figure: refText },
      ),
  );
}

export interface RingOptions {
  /** The start of its accessible name, e.g. "Energy by meal". */
  readonly title: string;
  readonly series: readonly Series[];
  /** One value per series, in the series' order. */
  readonly values: readonly number[];
  /** A value with its unit, e.g. "400 kcal". */
  readonly format: (value: number) => string;
  /**
   * A figure to set the whole against, such as the calories burnt. The ring goes round once for the larger of the two:
   * a whole short of it leaves an outlined gap up to it, and a whole past it a band outside the ring from it to the
   * end. A tick shows where it falls, and the middle gives the whole as a share of it ("80%", "of burnt").
   */
  readonly reference?: BarReference;
}

const RING_R = 40;
const RING_W = 12;
const RING_C = 2 * Math.PI * RING_R;
/** The gap of the surface after each part, along the ring, in the same units as its radius. */
const RING_GAP = 1.5;
/** How far the tick reaches past the ring on each side, and how far out the band past the reference sits. */
const RING_OUT = 3;

/** A point at `fraction` of the way round a circle of radius `r` about the ring's middle, clockwise from the top. */
function ringXY(r: number, fraction: number): [number, number] {
  const a = fraction * 2 * Math.PI - Math.PI / 2;
  return [Number((50 + r * Math.cos(a)).toFixed(3)), Number((50 + r * Math.sin(a)).toFixed(3))];
}

const ringPoint = (r: number, fraction: number) => ringXY(r, fraction).join(" ");

/** An arc of radius `r` from fraction `from` to `to` of the way round, clockwise. */
function ringArc(r: number, from: number, to: number): string {
  return `A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${ringPoint(r, to)}`;
}

/**
 * One whole split into parts, bent round into a ring: the segmented bar's shape for a square space (DR-49). It has no
 * legend of its own; hover and the accessible name give every part's figures, as the bar's do.
 */
export function ringChart({ title, series, values, format, reference }: RingOptions): HTMLElement {
  const { total, describe, parts, ref, gap, refText } = wholeOf(series, values, format, reference);
  const full = Math.max(total, ref?.value ?? 0);
  const ring = svg("svg", {
    class: "ring",
    viewBox: "-4 -4 108 108",
    role: "img",
    "aria-label": `${title}: ${parts.length ? parts.map(describe).join("; ") : "none"}${ref ? `; ${ref.name} ${refText}` : ""}`,
  });
  ring.append(svg("circle", { class: "ring-track", r: RING_R, cx: 50, cy: 50 }));
  let at = 0;
  for (const i of parts) {
    const len = (values[i]! / full) * RING_C;
    // A part too short for its gap keeps half its length, so that it still shows.
    const drawn = len > RING_GAP * 2 ? len - RING_GAP : len / 2;
    ring.append(
      svg(
        "circle",
        {
          class: `ring-part ring-${series[i]!.key}`,
          r: RING_R,
          cx: 50,
          cy: 50,
          style: `stroke: ${fill(series[i]!)}`,
          "stroke-dasharray": `${drawn.toFixed(3)} ${RING_C.toFixed(3)}`,
          "stroke-dashoffset": (-at).toFixed(3),
          transform: "rotate(-90 50 50)",
        },
        svg("title", {}, describe(i)),
      ),
    );
    at += len;
  }
  if (ref) {
    const outer = RING_R + RING_W / 2;
    const inner = RING_R - RING_W / 2;
    if (gap > 0) {
      // Less eaten than the reference: an outline of the ring from the end of the parts up to it, with nothing in it.
      // Just short of a full turn when nothing was eaten, since an arc can't end where it starts.
      const from = total / full + (total > 0 ? RING_GAP / RING_C / 2 : 0);
      const to = 1 - RING_GAP / RING_C / 2;
      const d = `M ${ringPoint(outer, from)} ${ringArc(outer, from, to)} L ${ringPoint(inner, to)} A ${inner} ${inner} 0 ${to - from > 0.5 ? 1 : 0} 0 ${ringPoint(inner, from)} Z`;
      ring.append(svg("path", { class: "ring-rest", d }, svg("title", {}, `${ref.name} ${ref.format(gap)} ${ref.above}`)));
    }
    const mark = ref.value / full;
    if (gap < 0) {
      // More eaten than the reference: a band outside the ring from the reference to the end.
      const band = outer + RING_OUT;
      ring.append(
        svg("path", { class: "ring-over", d: `M ${ringPoint(band, mark)} ${ringArc(band, mark, 1)}`, style: `stroke: var(${ref.color})` }, svg("title", {}, `${ref.name} ${ref.format(-gap)} ${ref.below}`)),
      );
    }
    const [x1, y1] = ringXY(inner - RING_OUT, mark);
    const [x2, y2] = ringXY(outer + RING_OUT, mark);
    const tick = { x1, y1, x2, y2 };
    ring.append(
      svg("line", { ...tick, class: "ring-tick-halo" }),
      svg("line", { ...tick, class: "ring-tick", style: `stroke: var(${ref.color})` }, svg("title", {}, `${ref.name} ${ref.format(ref.value)}`)),
      svg("text", { x: 50, y: 50, class: "ring-figure", "text-anchor": "middle", "aria-hidden": "true" }, `${Math.round((total / ref.value) * 100)}%`),
      svg("text", { x: 50, y: 62, class: "ring-caption", "text-anchor": "middle", "aria-hidden": "true" }, `of ${ref.name.toLowerCase()}`),
    );
  }
  return el("figure", { class: "chart ring-chart" }, ring);
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
  /** A figure to set each column against, such as the day's calories burnt: a line across the column. */
  readonly marker?: ColumnMarker;
}

export interface ColumnMarker {
  /** The legend's and the table's name for it, e.g. "Burnt". */
  readonly name: string;
  /** The custom property that holds its colour. */
  readonly color: string;
  /** One per column, in the columns' order; undefined draws no line on that column. */
  readonly values: readonly (number | undefined)[];
  /** Whether a column's figure is still growing, such as today's calories burnt: its line is dashed. */
  readonly partialFor?: (index: number) => boolean;
  /**
   * Also show each column's difference from its line, total − line, as a signed figure above it ("+200", "−340"), in
   * the tooltip and the accessible name ("200 kcal surplus") and in a table column. Worked out from the two figures
   * rounded to whole numbers, so it matches them as shown when `formatTotal` prints whole numbers, as the energy chart's
   * does. A column with nothing in it has none: an empty day is not a measured difference.
   */
  readonly difference?: ColumnDifference;
}

export interface ColumnDifference {
  /** What a total above the line is called, e.g. "surplus". */
  readonly above: string;
  /** What a total below the line is called, e.g. "deficit". */
  readonly below: string;
  /** The table's heading for it, e.g. "Difference". */
  readonly heading: string;
}

/** "+200", "−340" or "0": a difference as the label above a column prints it. */
export function signed(gap: number): string {
  return gap === 0 ? "0" : `${gap > 0 ? "+" : "−"}${formatNumber(Math.abs(gap), 0)}`;
}

const W = 460;
const H = 220;
const PAD = { left: 40, right: 6, top: 10, bottom: 24 };
/** The plot's top padding when columns carry a difference: room for its label above the tallest column. */
const PAD_TOP_DIFFERENCE = 22;
const BAR = 24;
const GAP = 2;
const RADIUS = 4;
/** How far a marker line reaches past each side of its column's bar. */
const MARK_OVERHANG = 5;

/** A column's top block: square at the bottom, 4px round corners at the top. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Columns of stacked parts, one per day, on one axis that starts at 0. Hovering or focusing a column shows a tooltip
 * with every part's figure; a table below holds them all.
 */
export function stackedColumns({ title, series, columns, format, formatTotal, totalHeading, marker }: ColumnChartOptions): HTMLElement {
  const totals = columns.map((c) => c.values.reduce((a, b) => a + b, 0));
  const marks = columns.map((_, i) => {
    const v = marker?.values[i];
    return v !== undefined && v > 0 ? v : undefined;
  });
  const markName = marker?.name ?? "";
  const difference = marker?.difference;
  // Total − line, from the two figures as shown; none on a column with nothing in it, or with no line.
  const diffs = columns.map((_, i) => (difference && marks[i] !== undefined && totals[i]! > 0 ? Math.round(totals[i]!) - Math.round(marks[i]!) : undefined));
  const describeDiff = (gap: number) => (gap === 0 ? "Even" : `${formatTotal(Math.abs(gap))} ${gap > 0 ? difference!.above : difference!.below}`);
  const scale = niceScale(Math.max(0, ...totals, ...marks.map((v) => v ?? 0)));
  const padTop = diffs.some((d) => d !== undefined) ? PAD_TOP_DIFFERENCE : PAD.top;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - padTop - PAD.bottom;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.min(BAR, band * 0.6);
  const y = (v: number) => padTop + plotH - (v / scale.max) * plotH;

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
      ...(marker && marks[i] !== undefined
        ? [el("div", { class: "chart-tooltip-row" }, el("span", { class: "chart-line-key", style: `background: var(${marker.color})` }), el("strong", {}, formatTotal(marks[i]!)), ` ${markName}`)]
        : []),
      ...(diffs[i] !== undefined ? [el("div", { class: "chart-tooltip-row chart-tooltip-diff" }, el("strong", {}, describeDiff(diffs[i]!)))] : []),
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
      "aria-label": `${c.title}: ${series.map((s, k) => `${s.name} ${format(c.values[k]!)}`).join(", ")}; total ${formatTotal(totals[i]!)}${marks[i] !== undefined ? `; ${markName} ${formatTotal(marks[i]!)}` : ""}${diffs[i] !== undefined ? `; ${describeDiff(diffs[i]!)}` : ""}${c.note ? `; ${c.note}` : ""}`,
    });
    // The hit target is the whole band, from the top of the plot to the day's label, not just the bar.
    column.append(svg("rect", { class: "chart-hit", x: PAD.left + band * i, y: padTop, width: band, height: plotH + PAD.bottom }));
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
    const mark = marks[i];
    if (marker && mark !== undefined) {
      // Wider than the bar, with a halo of the surface so that it shows over the parts as well as above them.
      const line = { x1: x - MARK_OVERHANG, x2: x + barW + MARK_OVERHANG, y1: y(mark), y2: y(mark) };
      column.append(svg("line", { ...line, class: "chart-marker-halo" }), svg("line", { ...line, class: `chart-marker${marker.partialFor?.(i) ? " partial" : ""}`, style: `stroke: var(${marker.color})` }));
    }
    const diff = diffs[i];
    if (diff !== undefined) {
      // Above whichever is higher, the column or its line.
      const at = Math.min(y(totals[i]!), y(marks[i]!)) - 6;
      // `over` and `under` carry no colour today (DR-46): they name the sign for tests and any later styling.
      column.append(svg("text", { x: x + barW / 2, y: at, class: `chart-diff${diff > 0 ? " over" : diff < 0 ? " under" : ""}`, "text-anchor": "middle" }, signed(diff)));
    }
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
    legend(series, undefined, marker && marks.some((v) => v !== undefined) ? { name: marker.name, color: marker.color } : undefined),
    el("div", { class: "chart-plot" }, svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": title }, grid, plot), tooltip),
    tableView(
      title,
      ["Day", ...series.map((s) => s.name), totalHeading, ...(marker ? [marker.name] : []), ...(difference ? [difference.heading] : [])],
      columns.map((c, i) => [
        c.title,
        ...c.values.map((v) => format(v)),
        formatTotal(totals[i]!),
        ...(marker ? [marks[i] === undefined ? "–" : formatTotal(marks[i]!)] : []),
        ...(difference ? [diffs[i] === undefined ? "–" : describeDiff(diffs[i]!)] : []),
      ]),
    ),
  );
}
