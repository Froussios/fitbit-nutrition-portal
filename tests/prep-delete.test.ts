// @vitest-environment happy-dom
/**
 * Deleting a portion's diary entry gives the portion back (#55), driven through the whole app with fake Google Health
 * and meal prep APIs. Google may store an entry under its own ID, saying so in its answer or not: the portion must
 * still be found.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const CLIENT = "test-client";
type Ids = "ours" | "google, answered" | "google, unanswered";

function fakeServices(ids: Ids) {
  const diary = new Map<string, Record<string, unknown>>();
  const portions: Record<string, unknown>[] = [];
  const prep = {
    id: "chiliprep01",
    name: "Chili",
    createdAt: 1,
    updatedAt: 1,
    discardedAt: null,
    portions,
    ingredients: [{ ref: { source: "manual", id: "x" }, label: "Beans", quantity: 1000, unit: "g", profile: { energyKcal: 1200, nutrients: { protein: 80 } } }],
  };
  let googleId = 1000;
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host === "health.googleapis.com") {
      if (url.pathname.endsWith("/identity")) return reply(200, { healthUserId: "1" });
      if (url.pathname.includes("food-measurement-unit")) return reply(200, { dataPoints: [] });
      if (url.pathname.endsWith(":batchDelete")) {
        for (const name of body.names as string[]) diary.delete(name.split("/").pop()!);
        return reply(200, { done: true });
      }
      if (method === "POST") {
        const id = ids === "ours" ? String(body.name).split("/").pop()! : String(googleId++);
        const stored = { ...body, name: `users/1/dataTypes/nutrition-log/dataPoints/${id}`, dataSource: { application: { googleWebClientId: CLIENT } } };
        diary.set(id, stored);
        return reply(200, ids === "google, unanswered" ? { done: false } : { done: true, response: stored });
      }
      return reply(200, { dataPoints: [...diary.values()] });
    }
    if (url.host === "idx.test" && url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api/".length);
      if (!new Headers(init.headers).get("Authorization")) return reply(401, { error: "Sign in first." });
      let m: RegExpExecArray | null;
      if (path === "preps") return reply(200, { preps: [structuredClone(prep)] });
      if (/^preps\/\w+\/portions$/.test(path)) {
        const portion = { id: body.id, fraction: body.fraction, entryId: body.entryId, state: "unconfirmed", eatenAt: body.eatenAt, createdAt: Date.now() };
        portions.push(portion);
        return reply(201, { portion });
      }
      if ((m = /^portions\/(\w+)$/.exec(path))) {
        const i = portions.findIndex((p) => p["id"] === m![1]);
        if (i >= 0 && method === "PATCH") portions[i] = { ...portions[i], state: "confirmed", entryId: body.entryId };
        if (i >= 0 && method === "DELETE") portions.splice(i, 1);
        return reply(204);
      }
    }
    return reply(404, "");
  }
  return { fetch, portions };
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
};

async function startApp(ids: Ids) {
  const services = fakeServices(ids);
  vi.resetModules();
  vi.stubEnv("VITE_FOOD_INDEX_URL", "http://idx.test/");
  vi.stubGlobal("fetch", vi.fn(services.fetch));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

const button = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

/** Picks the prep in the Meal prep tab, which opens the log form with it chosen, and logs `amount` of it. */
async function eat(amount: string) {
  button(/^Log a portion$/)!.click();
  const input = document.querySelector<HTMLInputElement>("#portion");
  expect(input).toBeTruthy();
  input!.value = amount;
  input!.dispatchEvent(new Event("input"));
  button(/^Log portion$/)!.click();
  await settle();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each<Ids>(["ours", "google, answered", "google, unanswered"])("deleting a portion's entry, with %s IDs", (ids) => {
  it("gives the portion back, and Undo takes it again", async () => {
    const { portions } = await startApp(ids);
    await eat("1/4");
    expect(portions).toHaveLength(1);
    expect(document.querySelector(".prep-left")?.textContent).toBe("75% left");

    button(/^Delete Chili \(1\/4\)/)!.click();
    await settle();
    expect(portions).toHaveLength(0);
    expect(document.querySelector(".prep-left")?.textContent).toBe("100% left");

    button(/^Undo deleting Chili \(1\/4\)/)!.click();
    await settle();
    expect(portions).toHaveLength(1);
    expect(document.querySelector(".prep-left")?.textContent).toBe("75% left");
  });
});
