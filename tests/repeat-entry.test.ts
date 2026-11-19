// @vitest-environment happy-dom
/**
 * Logging a diary entry again for today (DR-36), and adding to one with + (DR-37), driven through the whole app with a fake Google Health API that lists
 * each day's entries by their local civil start, as the real day filter does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import { entryStep } from "../src/core/ids";
import { addCivilDays, civilDate } from "../src/core/time";
import { buildNutritionLogPoint } from "../src/health/mapping";

const CLIENT = "test-client";
const custom: FoodItem = { ref: { source: "manual", id: "custom" }, name: "Toast", basis: "g", per100: { energyKcal: 250, nutrients: { protein: 9 } }, portions: [] };
const yogurt: FoodItem = { ref: { source: "manual", id: "custom" }, name: "Yogurt", basis: "g", per100: { energyKcal: 60, nutrients: { protein: 4 } }, portions: [] };

type Stored = Record<string, unknown> & { nutritionLog: { interval: { startTime: string }; mealType?: string; foodDisplayName?: string; energy?: { kcal: number }; food?: string } };

function fakeGoogleHealth() {
  let failCreate = false;
  const diary = new Map<string, Stored>();
  const yesterdayMorning = new Date();
  yesterdayMorning.setDate(yesterdayMorning.getDate() - 1);
  yesterdayMorning.setHours(9, 15, 0, 0);
  const todayMorning = new Date();
  todayMorning.setHours(0, 5, 0, 0);
  const toast = buildNutritionLogPoint({ food: custom, quantity: 60, unit: "g", time: yesterdayMorning, mealType: "BREAKFAST" }, { id: "e-seed-ab12-m" });
  diary.set("e-seed-ab12-m", { ...toast, dataSource: { application: { googleWebClientId: CLIENT } } } as Stored);
  // Logged by the Google Health app, against one of Google's foods.
  const other = buildNutritionLogPoint({ food: yogurt, quantity: 150, unit: "g", time: yesterdayMorning, mealType: "SNACK" }, { id: "1234567890" });
  diary.set("1234567890", { ...other, nutritionLog: { ...other.nutritionLog!, food: "users/me/foods/42" }, dataSource: { application: { packageName: "com.google.fitbit" } } } as Stored);
  const early = buildNutritionLogPoint({ food: custom, quantity: 30, unit: "g", time: todayMorning, mealType: "BREAKFAST" }, { id: "e-early-cd34-m" });
  diary.set("e-early-cd34-m", { ...early, dataSource: { application: { googleWebClientId: CLIENT } } } as Stored);
  // Logged as 2 cups: its ID records a cup, 250 ml.
  const milkId = `e-milk-ab12${(25000).toString(36)}-man`;
  const milk = buildNutritionLogPoint({ food: { ...custom, name: "Milk", basis: "ml" }, quantity: 500, unit: "ml", time: todayMorning, mealType: "BREAKFAST" }, { id: milkId });
  diary.set(milkId, { ...milk, dataSource: { application: { googleWebClientId: CLIENT } } } as Stored);
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host !== "health.googleapis.com") return reply(404, "");
    if (url.pathname.endsWith("/identity")) return reply(200, { healthUserId: "1" });
    if (url.pathname.includes("food-measurement-unit")) return reply(200, { dataPoints: [] });
    if (url.pathname.endsWith(":batchDelete")) {
      for (const name of body.names as string[]) diary.delete(name.split("/").pop()!);
      return reply(200, { done: true });
    }
    if (method === "POST") {
      if (failCreate) return reply(400, { error: { code: 400, message: "Invalid nutrition log", status: "INVALID_ARGUMENT" } });
      const id = String(body.name).split("/").pop()!;
      const stored = { ...body, dataSource: { application: { googleWebClientId: CLIENT } } };
      diary.set(id, stored);
      return reply(200, { done: true, response: stored });
    }
    const day = /"(\d{4}-\d{2}-\d{2})"/.exec(url.searchParams.get("filter") ?? "")?.[1];
    const points = [...diary.values()].filter((p) => !day || civilDate(new Date(p.nutritionLog.interval.startTime)) === day);
    return reply(200, { dataPoints: points });
  }
  return { fetch, diary, failCreates: () => (failCreate = true) };
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
};

const button = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

async function startApp(day?: string) {
  const services = fakeGoogleHealth();
  if (day) history.replaceState(null, "", `${location.pathname}?day=${day}`);
  vi.resetModules();
  vi.stubEnv("VITE_FOOD_INDEX_URL", "http://idx.test/");
  vi.stubGlobal("fetch", vi.fn(services.fetch));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  document.body.innerHTML = `<main id="app"></main>`;
  localStorage.clear();
  localStorage.setItem("foodDiary.clientId", CLIENT);
  sessionStorage.setItem(
    "foodDiary.token",
    JSON.stringify({
      accessToken: "a",
      idToken: "i",
      subject: "u1",
      expiresAt: Date.now() + 3600e3,
      scope: "openid https://www.googleapis.com/auth/googlehealth.nutrition.readonly https://www.googleapis.com/auth/googlehealth.nutrition.writeonly",
      clientId: CLIENT,
    }),
  );
  await import("../src/main");
  await settle();
  return services;
}

const rows = () => [...document.querySelectorAll(".diary tbody tr")].map((r) => r.querySelector("td:nth-child(2)")?.textContent);
const onDay = (diary: Map<string, Stored>, day: string) => [...diary.values()].filter((p) => civilDate(new Date(p.nutritionLog.interval.startTime)) === day);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  history.replaceState(null, "", location.pathname);
});

describe("logging an entry again for today", () => {
  it("logs a past entry today at the current time, keeps the original, and says where the copy went", async () => {
    const yesterday = addCivilDays(civilDate(new Date()), -1);
    const { diary } = await startApp(yesterday);
    expect(rows()).toEqual(["Toast (60 g)", "Yogurt (150 g)"]);

    const before = Date.now();
    button(/^Log Toast \(60 g\) again today$/)!.click();
    await settle();

    expect(rows()).toEqual(["Toast (60 g)", "Yogurt (150 g)"]);
    expect(onDay(diary, yesterday)).toHaveLength(2);
    const copies = onDay(diary, civilDate(new Date())).filter((p) => p.nutritionLog.foodDisplayName === "Toast (60 g)" && p.nutritionLog.energy?.kcal === 150);
    expect(copies).toHaveLength(1);
    const copy = copies[0]!.nutritionLog;
    expect(copy.mealType).toBe("BREAKFAST");
    expect(Date.parse(copy.interval.startTime)).toBeGreaterThanOrEqual(before - 1000);
    const notice = document.querySelector(".moved-notice")!;
    expect(notice.textContent).toBe("Logged Toast (60 g) again for today. Show today");
    expect(document.querySelector(".row-alert")?.hasAttribute("hidden")).toBe(true);

    button(/^Show today$/)!.click();
    await settle();
    expect(document.querySelector(".day-nav h2")?.textContent).toBe("Today");
    expect(rows().filter((r) => r === "Toast (60 g)")).toHaveLength(1);
  });

  it("logs another app's entry again as this app's own, without its food reference", async () => {
    const yesterday = addCivilDays(civilDate(new Date()), -1);
    const { diary } = await startApp(yesterday);
    button(/^Log Yogurt \(150 g\) again today$/)!.click();
    await settle();
    const copies = onDay(diary, civilDate(new Date())).filter((p) => p.nutritionLog.foodDisplayName === "Yogurt (150 g)");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.nutritionLog).not.toHaveProperty("food");
    expect(copies[0]!.nutritionLog.mealType).toBe("SNACK");
    expect(diary.get("1234567890")).toBeDefined();
  });

  it("adds the copy to today's diary when today is shown", async () => {
    const { diary } = await startApp();
    expect(rows()).toEqual(["Toast (30 g)", "Milk (500 ml)"]);
    button(/^Log Toast \(30 g\) again today$/)!.click();
    await settle();
    expect(rows()).toEqual(["Toast (30 g)", "Milk (500 ml)", "Toast (30 g)"]);
    expect(onDay(diary, civilDate(new Date()))).toHaveLength(3);
    expect((document.querySelector(".moved-notice") as HTMLElement).hidden).toBe(true);
  });

  it("says so when Google Health refuses the copy", async () => {
    const services = await startApp(addCivilDays(civilDate(new Date()), -1));
    services.failCreates();
    button(/^Log Toast \(60 g\) again today$/)!.click();
    await settle();
    expect(document.querySelector(".row-alert")?.textContent).toContain('Could not log again "Toast (60 g)"');
    expect(onDay(services.diary, civilDate(new Date()))).toHaveLength(2);
    expect(button(/^Log Toast \(60 g\) again today$/)!.disabled).toBe(false);
  });
});

describe("adding to an entry with +", () => {
  it("adds the amount as logged, and keeps adding that much", async () => {
    const { diary } = await startApp();
    const plus = () => [...document.querySelectorAll<HTMLButtonElement>("[data-entry-increment]")].find((b) => b.getAttribute("aria-label") === "Add 30 g to Toast (30 g)");
    expect(plus()!.textContent).toBe("+30 g");
    plus()!.click();
    await settle();
    expect(rows().sort()).toEqual(["Milk (500 ml)", "Toast (60 g)"]);
    const today = civilDate(new Date());
    const toast = () => [...diary.entries()].filter(([, p]) => p.nutritionLog.foodDisplayName?.startsWith("Toast") && civilDate(new Date(p.nutritionLog.interval.startTime)) === today);
    expect(toast()).toHaveLength(1);
    expect(entryStep(toast()[0]![0])).toBe(30);
    expect(toast()[0]![1].nutritionLog.energy?.kcal).toBe(150);
    expect(toast()[0]![1].nutritionLog.mealType).toBe("BREAKFAST");

    const again = [...document.querySelectorAll<HTMLButtonElement>("[data-entry-increment]")].find((b) => b.getAttribute("aria-label") === "Add 30 g to Toast (60 g)")!;
    again.click();
    await settle();
    expect(rows().sort()).toEqual(["Milk (500 ml)", "Toast (90 g)"]);
    expect(toast()).toHaveLength(1);
  });

  it("adds one of the unit an entry was logged in", async () => {
    await startApp();
    const plus = [...document.querySelectorAll<HTMLButtonElement>("[data-entry-increment]")].find((b) => b.getAttribute("aria-label") === "Add 250 ml to Milk (500 ml)")!;
    expect(plus.textContent).toBe("+250 ml");
    plus.click();
    await settle();
    expect(rows().sort()).toEqual(["Milk (750 ml)", "Toast (30 g)"]);
  });

  it("is only on today", async () => {
    await startApp(addCivilDays(civilDate(new Date()), -1));
    expect(document.querySelector("[data-entry-increment]")).toBeNull();
  });

  it("says so when Google Health refuses the larger entry, and keeps the original", async () => {
    const services = await startApp();
    services.failCreates();
    [...document.querySelectorAll<HTMLButtonElement>("[data-entry-increment]")].find((b) => b.textContent === "+30 g")!.click();
    await settle();
    expect(document.querySelector(".row-alert")?.textContent).toContain('Could not add to "Toast (30 g)"');
    expect(rows().sort()).toEqual(["Milk (500 ml)", "Toast (30 g)"]);
  });
});
