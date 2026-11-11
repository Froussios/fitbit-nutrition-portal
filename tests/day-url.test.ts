import { describe, expect, it } from "vitest";
import { dayFromUrl, isCivilDate, urlWithDay } from "../src/core/day-url";

const base = "https://froussios.github.io/fitbit-nutrition-portal/";
const today = "2026-11-11";

describe("the day in the URL", () => {
  it("reads a past day", () => {
    expect(dayFromUrl(`${base}?day=2026-11-09`, today)).toBe("2026-11-09");
    expect(dayFromUrl(`${base}?x=1&day=2025-02-28#top`, today)).toBe("2025-02-28");
  });

  it("reads no day, today, a later day or a non-date as today", () => {
    expect(dayFromUrl(base, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=2026-11-11`, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=2026-11-12`, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=yesterday`, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=2026-02-30`, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=2026-1-9`, today)).toBeUndefined();
    expect(dayFromUrl(`${base}?day=`, today)).toBeUndefined();
  });

  it("checks calendar dates, leap years included", () => {
    expect(isCivilDate("2024-02-29")).toBe(true);
    expect(isCivilDate("2026-02-29")).toBe(false);
    expect(isCivilDate("2026-13-01")).toBe(false);
    expect(isCivilDate("2026-11-00")).toBe(false);
  });

  it("sets and removes the day, keeping the rest of the URL", () => {
    expect(urlWithDay(base, "2026-11-09")).toBe(`${base}?day=2026-11-09`);
    expect(urlWithDay(`${base}?x=1&day=2026-11-09#top`, "2026-11-08")).toBe(`${base}?x=1&day=2026-11-08#top`);
    expect(urlWithDay(`${base}?day=2026-11-09`, undefined)).toBe(base);
    expect(urlWithDay(`${base}?x=1&day=2026-11-09#top`, undefined)).toBe(`${base}?x=1#top`);
    expect(urlWithDay(base, undefined)).toBe(base);
  });
});
