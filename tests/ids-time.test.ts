import { describe, expect, it } from "vitest";
import { ID_PATTERN, idFromName, newEntryId, parseEntryId } from "../src/core/ids";
import { nextCivilDate, nutritionDayFilter, parseDurationSeconds, utcOffsetDuration } from "../src/core/time";

describe("entry ids", () => {
  const now = Date.UTC(2026, 10, 1, 8, 30);

  it("round-trips the food reference", () => {
    const id = newEntryId({ source: "off", id: "9300633000001" }, now, "ab12");
    expect(id).toMatch(ID_PATTERN);
    expect(parseEntryId(id)).toEqual({ kind: "entry", loggedAt: new Date(now), ref: { source: "off", id: "9300633000001" } });
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

  it("builds the day filter on civil start time", () => {
    expect(nutritionDayFilter("2026-11-01")).toBe(
      'nutrition_log.interval.civil_start_time >= "2026-11-01" AND nutrition_log.interval.civil_start_time < "2026-11-02"',
    );
  });
});
