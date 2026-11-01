/** Time helpers for the Google Health API's interval and civil-time fields. */

/** The local UTC offset at `d` as a google-duration string, e.g. "39600s" for AEDT (+11:00). */
export function utcOffsetDuration(d: Date): string {
  const seconds = -d.getTimezoneOffset() * 60;
  return `${seconds === 0 ? 0 : seconds}s`; // avoid "-0s"
}

/** Parses a google-duration ("39600s", "-18000.5s") into seconds. */
export function parseDurationSeconds(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration: ${s}`);
  return Number(m[1]);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Local calendar date as YYYY-MM-DD. */
export function civilDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The civil date after `date` (YYYY-MM-DD), independent of the local time zone. */
export function nextCivilDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** List filter for nutrition logs whose civil (local) start falls on `date`. */
export function nutritionDayFilter(date: string): string {
  const f = "nutrition_log.interval.civil_start_time";
  return `${f} >= "${date}" AND ${f} < "${nextCivilDate(date)}"`;
}

/** Value for <input type="datetime-local">, in local time. */
export function toDateTimeLocalValue(d: Date): string {
  return `${civilDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
