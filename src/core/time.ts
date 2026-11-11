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

/** The civil date `days` after `date` (YYYY-MM-DD; negative for before), independent of the local time zone. */
export function addCivilDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The civil date after `date` (YYYY-MM-DD), independent of the local time zone. */
export function nextCivilDate(date: string): string {
  return addCivilDays(date, 1);
}

/** The moment on civil date `date` with the clock time of `now`: where an entry logged for a past day goes by default. */
export function onCivilDate(date: string, now: Date): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Civil date `date` (YYYY-MM-DD) written out as "Monday, 12 Nov 2026", the owner's preferred form, whatever the locale. */
export function formatCivilDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** A heading for civil date `date` seen on `today`: "Today", "Yesterday", or the date written out (`formatCivilDate`). */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addCivilDays(today, -1)) return "Yesterday";
  return formatCivilDate(date);
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
