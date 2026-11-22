import { describe, expect, it } from "vitest";
import { copiedEntryId, entryStep, ID_PATTERN, idFromName, newEntryId, parseEntryId } from "../src/core/ids";
import { addCivilDays, civilDate, civilDateOf, civilDateTime, dayLabel, formatCivilDate, formatShortDate, nextCivilDate, nutritionDayFilter, onCivilDate, parseDurationSeconds, utcOffsetDuration } from "../src/core/time";

describe("entry ids", () => {
  const now = Date.UTC(2026, 10, 1, 8, 30);

  it("gives a copy a new ID that records the same food", () => {
    const original = newEntryId({ source: "off", id: "9300633000001" }, now, "ab12");
    const copy = copiedEntryId(original, now + 60_000, "cd34");
    expect(copy).toMatch(ID_PATTERN);
    expect(copy).not.toBe(original);
    expect(parseEntryId(copy)).toEqual({ kind: "entry", loggedAt: new Date(now + 60_000), ref: { source: "off", id: "9300633000001" } });
  });

  it("keeps the source of an ID with no food, and a food ID with hyphens", () => {
    expect(copiedEntryId("e-abc-ab12-man", now, "cd34")).toBe(`e-${now.toString(36)}-cd34-man`);
    expect(parseEntryId(copiedEntryId("e-abc-ab12-afcd-f002-1", now, "cd34"))?.ref).toEqual({ source: "afcd", id: "f002-1" });
  });

  it("gives a copy of an ID the API chose no food reference", () => {
    const copy = copiedEntryId("1234567890123", now, "cd34");
    expect(copy).toMatch(ID_PATTERN);
    expect(parseEntryId(copy)?.ref).toBeUndefined();
  });

  it("round-trips the food reference", () => {
    const id = newEntryId({ source: "off", id: "9300633000001" }, now, "ab12");
    expect(id).toMatch(ID_PATTERN);
    expect(parseEntryId(id)).toEqual({ kind: "entry", loggedAt: new Date(now), ref: { source: "off", id: "9300633000001" } });
  });

  it("keeps generic sources apart, so usage can be counted per database", () => {
    const afcd = newEntryId({ source: "afcd", id: "F005634" });
    const fndds = newEntryId({ source: "fndds", id: "2705385" });
    expect(afcd).toMatch(ID_PATTERN);
    expect(parseEntryId(afcd)?.ref).toEqual({ source: "afcd", id: "f005634" });
    expect(parseEntryId(fndds)?.ref).toEqual({ source: "fndds", id: "2705385" });
  });

  it("keeps hyphenated food ids", () => {
    const id = newEntryId({ source: "sample", id: "milk-full-cream" }, now, "zz99");
    expect(parseEntryId(id)?.ref).toEqual({ source: "sample", id: "milk-full-cream" });
  });

  it("drops a food id that is too long or not ID-safe", () => {
    for (const foodId of ["x".repeat(60), "Has Spaces/Slash"]) {
      const id = newEntryId({ source: "manual", id: foodId }, now, "0000");
      expect(id).toMatch(ID_PATTERN);
      expect(parseEntryId(id)?.ref).toBeUndefined();
    }
  });

  it("ignores ids from other clients", () => {
    expect(parseEntryId("5f1c0b7e-91d4-4c1e-8f6d-3c0f0e0f8e21")).toBeUndefined();
    expect(parseEntryId("e-abc-def-unknownsrc")).toBeUndefined();
  });

  it("extracts the id from a resource name", () => {
    expect(idFromName("users/me/dataTypes/nutrition-log/dataPoints/e-1-2-smp")).toBe("e-1-2-smp");
  });
});

describe("time helpers", () => {
  it("writes a civil date as the API's civil date-time, at midnight or at a local clock time, and back", () => {
    expect(civilDateTime("2026-01-05")).toEqual({ date: { year: 2026, month: 1, day: 5 }, time: {} });
    expect(civilDateTime("2026-01-05", new Date(2026, 0, 5, 9, 7, 3))).toEqual({ date: { year: 2026, month: 1, day: 5 }, time: { hours: 9, minutes: 7, seconds: 3 } });
    expect(civilDateOf({ date: { year: 2026, month: 1, day: 5 } })).toBe("2026-01-05");
  });

  it("formats the UTC offset as a duration", () => {
    const d = new Date();
    expect(parseDurationSeconds(utcOffsetDuration(d))).toBe(-d.getTimezoneOffset() * 60 || 0);
    expect(parseDurationSeconds("-18000s")).toBe(-18000);
  });

  it("rolls civil dates over month and year ends", () => {
    expect(nextCivilDate("2026-02-28")).toBe("2026-03-01");
    expect(nextCivilDate("2026-12-31")).toBe("2027-01-01");
  });

  it("steps civil dates back and forth over month and year ends", () => {
    expect(addCivilDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCivilDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addCivilDays("2026-11-11", 0)).toBe("2026-11-11");
    expect(addCivilDays("2026-11-11", -11)).toBe("2026-10-31");
  });

  it("puts an entry for another day at the current clock time on that day", () => {
    const at = onCivilDate("2026-11-09", new Date(2026, 10, 11, 13, 45, 20));
    expect(civilDate(at)).toBe("2026-11-09");
    expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([13, 45, 20]);
  });

  it("names today and yesterday, and writes out other days", () => {
    expect(dayLabel("2026-11-11", "2026-11-11")).toBe("Today");
    expect(dayLabel("2026-11-10", "2026-11-11")).toBe("Yesterday");
    expect(dayLabel("2026-01-01", "2026-01-02")).toBe("Yesterday");
    expect(dayLabel("2026-11-09", "2026-11-11")).toBe("Monday, 9 Nov 2026");
    expect(dayLabel("2025-12-30", "2026-01-02")).toBe("Tuesday, 30 Dec 2025");
  });

  it("writes a date as weekday, day, short month and year", () => {
    expect(formatCivilDate("2026-11-12")).toBe("Thursday, 12 Nov 2026");
    expect(formatCivilDate("2024-02-29")).toBe("Thursday, 29 Feb 2024");
    expect(formatCivilDate("2027-01-03")).toBe("Sunday, 3 Jan 2027");
  });

  it("writes a civil date in the locale's short form, on that date whatever the time zone", () => {
    expect(formatShortDate("2026-11-09", "en-GB")).toBe("9 Nov 2026");
    expect(formatShortDate("2026-11-09", "en-US")).toBe("Nov 9, 2026");
    expect(formatShortDate("2026-11-09", "de-DE")).toBe("9. Nov. 2026");
    expect(formatShortDate("2026-01-01", "en-GB")).toBe("1 Jan 2026");
  });

  it("builds the day filter on civil start time", () => {
    expect(nutritionDayFilter("2026-11-01")).toBe(
      'nutrition_log.interval.civil_start_time >= "2026-11-01" AND nutrition_log.interval.civil_start_time < "2026-11-02"',
    );
  });
});

describe("entry step in the ID (DR-37)", () => {
  const now = Date.UTC(2026, 10, 19);

  it("records a step after the 4 random characters, in hundredths, and reads it back", () => {
    const id = newEntryId({ source: "off", id: "123" }, now, "ab12", 28.35);
    expect(id).toBe(`e-${now.toString(36)}-ab12${(2835).toString(36)}-off-123`);
    expect(entryStep(id)).toBe(28.35);
    expect(parseEntryId(id)?.ref).toEqual({ source: "off", id: "123" });
    expect(ID_PATTERN.test(id)).toBe(true);
  });

  it("records nothing for no step, and reads none from IDs without one", () => {
    expect(newEntryId({ source: "off", id: "123" }, now, "ab12")).toBe(`e-${now.toString(36)}-ab12-off-123`);
    expect(entryStep(`e-${now.toString(36)}-ab12-off-123`)).toBeUndefined();
    expect(entryStep("1234567890")).toBeUndefined();
    expect(newEntryId({ source: "off", id: "123" }, now, "ab12", 0.001)).toBe(`e-${now.toString(36)}-ab12-off-123`);
  });

  it("keeps the step in a copy, unless given another or null", () => {
    const original = newEntryId({ source: "manual", id: "toast" }, now, "ab12", 250);
    expect(entryStep(copiedEntryId(original, now, "cd34"))).toBe(250);
    expect(entryStep(copiedEntryId(original, now, "cd34", 35))).toBe(35);
    expect(copiedEntryId(original, now, "cd34", null)).toBe(`e-${now.toString(36)}-cd34-man-toast`);
    expect(entryStep(copiedEntryId("1234567890", now, "cd34", 60))).toBe(60);
  });

  it("drops the food reference rather than go past 63 characters", () => {
    const long = "f".repeat(40);
    const original = newEntryId({ source: "off", id: long }, now, "ab12");
    expect(parseEntryId(original)?.ref?.id).toBe(long);
    const copy = copiedEntryId(original, now, "cd34", 123456.78);
    expect(copy.length).toBeLessThanOrEqual(63);
    expect(entryStep(copy)).toBe(123456.78);
  });
});
