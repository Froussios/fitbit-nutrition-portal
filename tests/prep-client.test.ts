import { describe, expect, it, vi } from "vitest";
import { canReload } from "../src/core/food";
import { newEntryId, parseEntryId } from "../src/core/ids";
import { randomId } from "../src/core/prep";
import { buildPortionPoint, toLoggedFoods } from "../src/health/mapping";
import { PrepApi, PrepApiError, PrepApiMissingError } from "../src/prep/api-client";

const BASE = "https://food-index.example/api/";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PrepApi", () => {
  it("sends the ID token, and only that", async () => {
    // Like the API: without a token it answers its JSON 401, with one it answers.
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => ((init?.headers as Record<string, string> | undefined)?.["Authorization"] ? json({ preps: [] }) : json({ error: "Sign in first." }, 401)));
    await new PrepApi(BASE, () => "ID.TOKEN.SIG", fetchMock as typeof fetch).list();
    // The first request only asks whether the API exists, without a token (PrepApi.available).
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect(url.href).toBe(`${BASE}preps`);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ID.TOKEN.SIG");
  });

  it("sends a portion to reserve, and returns the API's portion", async () => {
    const portion = { id: "p1234567", fraction: 0.25, entryId: "e-x-1234-prep-abc", state: "unconfirmed", eatenAt: 1, createdAt: 1 };
    const fetchMock = vi.fn(async () => json({ portion }, 201));
    const got = await new PrepApi(BASE, () => "t", fetchMock as typeof fetch).reserve("abcd1234", { id: "p1234567", fraction: null, entryId: "e-x-1234-prep-abc", eatenAt: 1 });
    expect(got).toEqual(portion);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`${BASE}preps/abcd1234/portions`);
    expect(JSON.parse(String(init.body))).toEqual({ id: "p1234567", fraction: null, entryId: "e-x-1234-prep-abc", eatenAt: 1 });
  });

  it("says how much is left when a portion is too big", async () => {
    const api = new PrepApi(BASE, () => "t", (async () => json({ error: "That is more than is left.", left: 0.25 }, 409)) as typeof fetch);
    const e = await api.reserve("abcd1234", { id: "p1234567", fraction: 0.5, entryId: "e-x-1234-prep-abc", eatenAt: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PrepApiError);
    expect((e as PrepApiError).status).toBe(409);
    expect((e as PrepApiError).left).toBe(0.25);
  });

  it("tells a site without the API from an API that found nothing", async () => {
    const missing = new PrepApi(BASE, () => "t", (async () => new Response("<h1>Not found</h1>", { status: 404 })) as typeof fetch);
    await expect(missing.list()).rejects.toBeInstanceOf(PrepApiMissingError);
    const notFound = new PrepApi(BASE, () => "t", (async () => json({ error: "No such prep." }, 404)) as typeof fetch);
    await expect(notFound.setDiscarded("abcd1234", true)).rejects.toBeInstanceOf(PrepApiError);
  });

  it("lists saved meals, and tells an API that predates them", async () => {
    const meals = [{ id: "bowl0001", name: "Bowl", ingredients: [], createdAt: 1, updatedAt: 1 }];
    const api = (answer: Response) => new PrepApi(BASE, () => "t", (async (_u: URL, init?: RequestInit) => ((init?.headers as Record<string, string> | undefined)?.["Authorization"] ? answer.clone() : json({ error: "Sign in first." }, 401))) as typeof fetch);
    await expect(api(json({ meals })).listMeals()).resolves.toEqual(meals);
    await expect(api(json({ error: "No such endpoint." }, 404)).listMeals()).resolves.toBeUndefined();
    await expect(api(json({ error: "Something went wrong." }, 500)).listMeals()).rejects.toBeInstanceOf(PrepApiError);
  });

  it("sends a saved meal, and deletes one", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new PrepApi(BASE, () => "t", fetchMock as unknown as typeof fetch);
    const ingredient = { ref: { source: "afcd" as const, id: "f1" }, label: "Rice", quantity: 150, unit: "g", profile: { energyKcal: 167, nutrients: {} } };
    await api.saveMeal("bowl0001", "Bowl", [ingredient]);
    await api.deleteMeal("bowl0001");
    const [[putUrl, put], [delUrl, del]] = fetchMock.mock.calls as unknown as [[URL, RequestInit], [URL, RequestInit]];
    expect([putUrl!.href, put!.method, JSON.parse(String(put!.body))]).toEqual([`${BASE}meals/bowl0001`, "PUT", { name: "Bowl", ingredients: [ingredient] }]);
    expect([delUrl!.href, del!.method]).toEqual([`${BASE}meals/bowl0001`, "DELETE"]);
  });

  it("marks a request that got no answer", async () => {
    const api = new PrepApi(BASE, () => "t", (async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch);
    const e = (await api.list().catch((x: unknown) => x)) as PrepApiError;
    expect(e.connectionFailed).toBe(true);
  });

  it("sends no request with a token when the session has expired", async () => {
    const fetchMock = vi.fn(async () => json({ error: "Sign in first." }, 401));
    const api = new PrepApi(
      BASE,
      () => {
        throw new Error("signed out");
      },
      fetchMock as unknown as typeof fetch,
    );
    await expect(api.list()).rejects.toThrow("signed out");
    const withToken = fetchMock.mock.calls.filter((c) => ((c as unknown as [URL, RequestInit])[1]?.headers as Record<string, string> | undefined)?.["Authorization"]);
    expect(withToken).toHaveLength(0);
  });
});

describe("a portion's diary entry", () => {
  const profile = { energyKcal: 438.04, nutrients: { protein: 20.123456, fat: 10, carbohydrates: 50, sodium: 0.5 } };

  it("is one entry named for its fraction, with no serving", () => {
    const point = buildPortionPoint({ name: "Chili (1/6)", profile, mealType: "DINNER", time: new Date("2026-11-08T08:00:00Z") }, "e-abc-1234-prep-chili001");
    expect(point.name).toBe("users/me/dataTypes/nutrition-log/dataPoints/e-abc-1234-prep-chili001");
    const log = point.nutritionLog!;
    expect(log.foodDisplayName).toBe("Chili (1/6)");
    expect(log.mealType).toBe("DINNER");
    expect(log.energy).toEqual({ kcal: 438, userProvidedUnit: "KILOCALORIE" });
    expect(log.totalFat).toEqual({ grams: 10 });
    expect(log.totalCarbohydrate).toEqual({ grams: 50 });
    expect(log.nutrients).toContainEqual({ nutrient: "PROTEIN", quantity: { grams: 20.1235 } });
    expect(log.serving).toBeUndefined();
    expect(log.interval.startTime).toBe("2026-11-08T08:00:00.000Z");
  });

  it("leaves out the meal when none was chosen", () => {
    expect(buildPortionPoint({ name: "Chili (1/6)", profile, time: new Date() }, "e-abc-1234-prep-chili001").nutritionLog!.mealType).toBeUndefined();
  });

  it("records the prep in its ID", () => {
    const id = newEntryId({ source: "prep", id: "chili001" }, 1_800_000_000_000, "ab12");
    expect(parseEntryId(id)?.ref).toEqual({ source: "prep", id: "chili001" });
  });

  it("is not a food that search can boost", () => {
    const point = { ...buildPortionPoint({ name: "Chili (1/6)", profile, time: new Date() }, newEntryId({ source: "prep", id: "chili001" })), dataSource: { application: { googleWebClientId: "me" } } };
    expect(toLoggedFoods([point], "me")).toEqual([]);
    expect(canReload("prep")).toBe(false);
    expect(canReload("manual")).toBe(false);
    expect(canReload("afcd")).toBe(true);
  });
});

describe("randomId", () => {
  it("makes IDs the API accepts", () => {
    for (let i = 0; i < 50; i++) expect(randomId(16)).toMatch(/^[a-z0-9]{16}$/);
    expect(new Set(Array.from({ length: 50 }, () => randomId(12))).size).toBe(50);
  });
});

describe("PrepApi.available", () => {
  /** A browser: a request with an Authorization header needs a CORS preflight, which a site without the API refuses. */
  const site = (hasApi: boolean) =>
    vi.fn(async (_url: URL, init?: RequestInit) => {
      const authorised = Boolean((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      if (!hasApi) {
        if (authorised) throw new TypeError("Failed to fetch"); // preflight refused (405)
        return new Response("", { status: 404 });
      }
      return authorised ? json({ preps: [] }) : json({ error: "Sign in first." }, 401);
    });

  it("finds a site without the API, although its preflights fail", async () => {
    const fetchMock = site(false);
    const api = new PrepApi(BASE, () => "t", fetchMock as unknown as typeof fetch);
    await expect(api.list()).rejects.toBeInstanceOf(PrepApiMissingError);
    // It asked without a token, so no preflight was needed.
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string> | undefined)?.["Authorization"]).toBeUndefined();
  });

  it("finds the API, and then lists with the token", async () => {
    const fetchMock = site(true);
    await expect(new PrepApi(BASE, () => "t", fetchMock as unknown as typeof fetch).list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 200 page", new Response("<html>app</html>", { status: 200, headers: { "Content-Type": "text/html" } }), false],
    ["a 404 with no body", new Response("", { status: 404 }), false],
    ["the API's 404 for a wrong path", json({ error: "No such endpoint." }, 404), true],
    ["the API's 401", json({ error: "Sign in first." }, 401), true],
  ])("counts the API present only for its own JSON error: %s", async (_name, answer, present) => {
    await expect(new PrepApi(BASE, () => "t", (async () => answer) as typeof fetch).available()).resolves.toBe(present);
  });

  it("shows a broken API as an error, and asks again next time", async () => {
    let broken = true;
    const api = new PrepApi(BASE, () => "t", (async () => (broken ? new Response("<html>Error 1101</html>", { status: 500 }) : json({ error: "Sign in first." }, 401))) as typeof fetch);
    await expect(api.available()).rejects.toMatchObject({ status: 500 });
    broken = false;
    await expect(api.available()).resolves.toBe(true);
  });

  it("asks once per page", async () => {
    const fetchMock = site(true);
    const api = new PrepApi(BASE, () => "t", fetchMock as unknown as typeof fetch);
    await api.list();
    await api.list();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("asks again after no answer", async () => {
    let up = false;
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      if (!up) throw new TypeError("Failed to fetch");
      return (init?.headers as Record<string, string> | undefined)?.["Authorization"] ? json({ preps: [] }) : json({ error: "Sign in first." }, 401);
    });
    const api = new PrepApi(BASE, () => "t", fetchMock as unknown as typeof fetch);
    const e = (await api.list().catch((x: unknown) => x)) as PrepApiError;
    expect(e.connectionFailed).toBe(true);
    up = true;
    await expect(api.list()).resolves.toEqual([]);
  });
});
