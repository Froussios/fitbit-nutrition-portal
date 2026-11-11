/**
 * The diary's day in the page URL, as `?day=YYYY-MM-DD`, so that a day can be linked to or bookmarked.
 * A query parameter, not a path: GitHub Pages serves static files, so an unknown path would not find the app.
 * Without the parameter the diary shows today.
 */

const PARAM = "day";

/** Whether `date` is a real calendar date written as YYYY-MM-DD. */
export function isCivilDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d); // not Date.UTC, which reads years 0–99 as 1900–1999
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * The past day `url` links to, if any. Today, a later day, or anything that isn't a date shows today,
 * so it reads as no day.
 */
export function dayFromUrl(url: string, today: string): string | undefined {
  const day = new URL(url).searchParams.get(PARAM);
  return day !== null && isCivilDate(day) && day < today ? day : undefined;
}

/** `url` linking to `day`, or with no day (today) when it is undefined. Everything else in the URL is kept. */
export function urlWithDay(url: string, day: string | undefined): string {
  const u = new URL(url);
  if (day) u.searchParams.set(PARAM, day);
  else u.searchParams.delete(PARAM);
  return u.href;
}
