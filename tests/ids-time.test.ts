import { describe, expect, it } from "vitest";
import { copiedEntryId, ID_PATTERN, idFromName, newEntryId, parseEntryId } from "../src/core/ids";
import { addCivilDays, civilDate, dayLabel, nextCivilDate, nutritionDayFilter, onCivilDate, parseDurationSeconds, utcOffsetDuration } from "../src/core/time";

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
    expect(dayLabel("2026-11-09", "2026-11-11", "en-AU")).toBe("Monday 9 November");
    expect(dayLabel("2025-12-30", "2026-01-02", "en-AU")).toBe("Tuesday 30 December 2025");
  });

  it("builds the day filter on civil start time", () => {
    expect(nutritionDayFilter("2026-11-01")).toBe(
      'nutrition_log.interval.civil_start_time >= "2026-11-01" AND nutrition_log.interval.civil_start_time < "2026-11-02"',
    );
  });
});
