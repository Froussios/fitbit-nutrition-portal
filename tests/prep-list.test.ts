// @vitest-environment happy-dom
/**
 * The meal prep and saved meal lists follow what was saved, and leave with the user who signs out (#133). Driven
 * through the whole app with fake Google Health and meal prep APIs, as in prep-delete.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const CLIENT = "test-client";
const USER = "u1";

const INGREDIENT = { ref: { source: "manual", id: "x" }, label: "Beans", quantity: 1000, unit: "g", profile: { energyKcal: 1200, nutrients: { protein: 80 } } };

function fakeServices() {
  const preps: Record<string, unknown>[] = [];
  const meals: Record<string, unknown>[] = [{ id: "porridge0001", name: "Porridge", ingredients: [INGREDIENT], createdAt: 1, updatedAt: 1 }];
  /** While set, GET /api/preps answers only when it is called: with the list as it was when the request came in. */
  let hold: ((release: () => void) => void) | undefined;
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host === "health.googleapis.com") {
      if (url.pathname.endsWith("/identity")) return reply(200, { healthUserId: "1" });
      return reply(200, { dataPoints: [] });
    }
    if (url.host === "idx.test" && url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api/".length);
      if (!new Headers(init.headers).get("Authorization")) return reply(401, { error: "Sign in first." });
      let m: RegExpExecArray | null;
      if (path === "preps" && method === "GET") {
        const snapshot = structuredClone(preps);
        if (hold) {
          const gate = hold;
          hold = undefined;
          await new Promise<void>((release) => gate(release));
        }
        return reply(200, { preps: snapshot });
      }
      if ((m = /^preps\/(\w+)$/.exec(path)) && method === "PUT") {
        preps.push({ id: m[1], name: body.name, ingredients: body.ingredients, createdAt: Date.now(), updatedAt: Date.now(), discardedAt: null, portions: [] });
        return reply(204);
      }
      if (path === "meals") return reply(200, { meals: structuredClone(meals) });
    }
    return reply(404, "");
  }
  return {
    fetch,
    preps,
    /** Holds the next listing of preps until the returned function is called. */
    holdNextList(): Promise<() => void> {
      return new Promise((resolve) => (hold = resolve));
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
};

async function startApp() {
  const services = fakeServices();
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
      subject: USER,
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

/** Opens a builder on an unsaved draft of `name`, as if it had been typed before a reload, so no search is needed. */
function openDraft(kind: "prep" | "meal", name: string) {
  localStorage.setItem(`foodDiary.${kind}Draft.${USER}.new`, JSON.stringify({ name, ingredients: [INGREDIENT] }));
  button(kind === "prep" ? /^New prep$/ : /^New meal$/)!.click();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the meal prep list", () => {
  it("shows a prep saved while an earlier listing was under way", async () => {
    const services = await startApp();
    // A diary refresh lists the preps after the day. Its listing is read now, before the save, and answers later.
    const held = services.holdNextList();
    button(/^Refresh$/)!.click();
    const release = await held;

    openDraft("prep", "Chili");
    button(/^Save prep$/)!.click();
    await settle();
    expect(services.preps.map((p) => p["name"])).toEqual(["Chili"]);

    release();
    await settle();
    expect([...document.querySelectorAll(".prep-card .prep-name strong")].map((n) => n.textContent)).toEqual(["Chili"]);
  });
});

describe("signing out", () => {
  it("closes the saved meal builder and forgets the saved meals", async () => {
    await startApp();
    openDraft("meal", "Toast");
    const builders = [...document.querySelectorAll<HTMLElement>(".prep-builder")];
    const mealBuilder = builders.find((b) => !b.hidden);
    expect(mealBuilder?.querySelector("h3")?.textContent).toBe("New saved meal");
    const mealCard = document.querySelector<HTMLElement>(".meal-card")!;
    expect(mealCard.textContent).toContain("Porridge");

    button(/^Sign out$/)!.click();
    await settle();
    // Left open, Save would write this user's meal into the next account that signs in on this tab.
    expect(mealBuilder!.hidden).toBe(true);
    expect(mealCard.textContent).not.toContain("Porridge");
  });
});
