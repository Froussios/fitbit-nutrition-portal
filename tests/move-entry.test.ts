// @vitest-environment happy-dom
/**
 * Moving a diary entry to another day, driven through the whole app with a fake Google Health API that lists
 * each day's entries by their local civil start, as the real day filter does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import { addCivilDays, civilDate } from "../src/core/time";
import { buildNutritionLogPoint } from "../src/health/mapping";

const CLIENT = "test-client";
const custom: FoodItem = { ref: { source: "manual", id: "custom" }, name: "Toast", basis: "g", per100: { energyKcal: 250, nutrients: { protein: 9 } }, portions: [] };

function fakeGoogleHealth() {
  const diary = new Map<string, Record<string, unknown>>();
  const now = new Date();
  now.setHours(9, 15, 0, 0);
  const seed = buildNutritionLogPoint({ food: custom, quantity: 60, unit: "g", time: now, mealType: "BREAKFAST" }, { id: "e-seed-ab12-m" });
  diary.set("e-seed-ab12-m", { ...seed, dataSource: { application: { googleWebClientId: CLIENT } } });
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
      const id = String(body.name).split("/").pop()!;
      const stored = { ...body, dataSource: { application: { googleWebClientId: CLIENT } } };
      diary.set(id, stored);
      return reply(200, { done: true, response: stored });
    }
    const day = /"(\d{4}-\d{2}-\d{2})"/.exec(url.searchParams.get("filter") ?? "")?.[1];
    const points = [...diary.values()].filter((p) => !day || civilDate(new Date((p["nutritionLog"] as { interval: { startTime: string } }).interval.startTime)) === day);
    return reply(200, { dataPoints: points });
  }
  return { fetch, diary };
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
};

const button = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

async function startApp() {
  const services = fakeGoogleHealth();
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  history.replaceState(null, "", location.pathname);
});

describe("moving an entry to another day", () => {
  it("takes it off the day shown, says where it went, and shows it there", async () => {
    const { diary } = await startApp();
    expect(rows()).toEqual(["Toast (60 g)"]);

    button(/^Edit Toast/)!.click();
    const day = document.querySelector<HTMLInputElement>("#edit-day")!;
    const yesterday = addCivilDays(civilDate(new Date()), -1);
    day.value = yesterday;
    day.dispatchEvent(new Event("input", { bubbles: true }));
    button(/^Save changes to Toast/)!.click();
    await settle();

    expect(rows()).toEqual([]);
    const notice = document.querySelector(".moved-notice")!;
    expect(notice.textContent).toBe("Moved Toast (60 g) to yesterday. Show yesterday");
    expect(document.activeElement?.textContent).toBe("Show yesterday");
    const stored = [...diary.values()];
    expect(stored).toHaveLength(1);
    const log = stored[0]!["nutritionLog"] as { interval: { startTime: string }; mealType: string };
    const start = new Date(log.interval.startTime);
    expect(civilDate(start)).toBe(yesterday);
    expect([start.getHours(), start.getMinutes()]).toEqual([9, 15]);
    expect(log.mealType).toBe("BREAKFAST");

    button(/^Show yesterday$/)!.click();
    await settle();
    expect(document.querySelector(".day-nav h2")?.textContent).toBe("Yesterday");
    expect(rows()).toEqual(["Toast (60 g)"]);
    expect((document.querySelector(".moved-notice") as HTMLElement).hidden).toBe(true);
  });
});
