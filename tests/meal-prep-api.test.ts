import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, GoogleKeys, verifyIdToken } from "../server/auth";
import type { D1Database, D1PreparedStatement, D1Result } from "../server/d1";
import { handle, type Env } from "../server/handler";
import { KEEP_ENDED_MS, type Prep } from "../src/core/prep";

/** D1's interface over a real SQLite database, with the real migration: D1 is SQLite. */
function localD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_meal_prep.sql", import.meta.url), "utf8"));
  const statement = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind: (...v) => statement(query, v.map((x) => (x === undefined ? null : x)) as SQLInputValue[]),
    first: async <T>() => (db.prepare(query).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(query).all(...values) as T[], meta: { changes: 0 } }) as D1Result<T>,
    run: async () => ({ results: [], meta: { changes: Number(db.prepare(query).run(...values).changes) } }),
  });
  return {
    prepare: (q) => statement(q),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const CLIENT = "client.apps.googleusercontent.com";
const ORIGIN = "https://froussios.github.io";
const NOW = 1_800_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function idToken(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: typeof privateKey; alg?: string } = {}): string {
  const head = `${part({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })}.${part({ iss: "https://accounts.google.com", aud: CLIENT, sub: "alice", iat: NOW / 1000, exp: NOW / 1000 + 3600, ...claims })}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), opts.key ?? privateKey).toString("base64url")}`;
}

let cryptoKey: CryptoKey;
const keys = async (kid: string) => (kid === "k1" ? cryptoKey : undefined);

describe("verifyIdToken", () => {
  beforeEach(async () => {
    cryptoKey ??= await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  });
  const verify = (token: string, now = NOW) => verifyIdToken(token, { clientIds: [CLIENT], now, keys });

  it("returns the user of a token Google signed for this app", async () => {
    await expect(verify(idToken())).resolves.toBe("alice");
  });

  it.each([
    ["another app's token", idToken({ aud: "another-app" })],
    ["the wrong issuer", idToken({ iss: "https://example.com" })],
    ["an expired token", idToken({ exp: NOW / 1000 - 120 })],
    ["a token issued in the future", idToken({ iat: NOW / 1000 + 600 })],
    ["a token with no user", idToken({ sub: "" })],
    ["a token signed by someone else", idToken({}, { key: other.privateKey })],
    ["a token with an unknown key", idToken({}, { kid: "k2" })],
    ["an unsigned token", idToken({}, { alg: "none" })],
    ["a forged claim", (() => { const [h, , s] = idToken().split("."); return `${h}.${part({ iss: "https://accounts.google.com", aud: CLIENT, sub: "mallory", exp: NOW / 1000 + 3600 })}.${s}`; })()],
    ["something that is not a token", "not-a-token"],
  ])("refuses %s", async (_name, token) => {
    await expect(verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it("allows a minute of clock difference", async () => {
    await expect(verify(idToken({ exp: NOW / 1000 - 30 }))).resolves.toBe("alice");
  });
});

describe("GoogleKeys", () => {
  it("fetches Google's keys once while Google says they are fresh, and again when a new key appears", async () => {
    let now = NOW;
    let calls = 0;
    const fetchKeys = (async () => {
      calls++;
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "public, max-age=3600" } });
    }) as typeof fetch;
    const g = new GoogleKeys(fetchKeys, () => now);
    expect(await g.lookup("k1")).toBeDefined();
    expect(await g.lookup("k1")).toBeDefined();
    expect(calls).toBe(1);
    expect(await g.lookup("unknown")).toBeUndefined();
    expect(calls).toBe(1); // a bad token can't make it fetch on every request
    now += 61_000;
    await g.lookup("unknown");
    expect(calls).toBe(2);
    now += 3_600_000;
    await g.lookup("k1");
    expect(calls).toBe(3);
  });
});

describe("meal prep API", () => {
  let env: Env;
  let now: number;
  const deps = () => ({ keys, now: () => now });
  const ingredients = [
    { ref: { source: "afcd", id: "f001" }, label: "Beef mince", quantity: 500, unit: "g", profile: { energyKcal: 1200, nutrients: { protein: 100, fat: 80 } } },
    { ref: { source: "manual", id: "custom" }, label: "Beans", quantity: 400, unit: "g", profile: { energyKcal: 360, nutrients: { protein: 24 } } },
  ];

  async function call(method: string, path: string, body?: unknown, opts: { user?: string; token?: string | null; origin?: string } = {}) {
    const headers: Record<string, string> = { Origin: opts.origin ?? ORIGIN };
    const token = opts.token === undefined ? idToken({ sub: opts.user ?? "alice", iat: now / 1000, exp: now / 1000 + 3600 }) : opts.token;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await handle(new Request(`https://food-index.froussios.com${path}`, { method, headers, body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body) }), env, deps());
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  }
  const preps = async (user = "alice") => ((await call("GET", "/api/preps", undefined, { user })).body!["preps"] as Prep[]);
  const reserve = (fraction: number | null, id: string, prepId = "chili001", user = "alice") =>
    call("POST", `/api/preps/${prepId}/portions`, { id, fraction, entryId: null, eatenAt: now }, { user });

  beforeEach(async () => {
    cryptoKey ??= await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    env = { DB: localD1(), GOOGLE_CLIENT_IDS: `${CLIENT}, other.apps.googleusercontent.com`, ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173` };
    now = NOW;
    expect((await call("PUT", "/api/preps/chili001", { name: "Chili", ingredients })).status).toBe(204);
  });

  it("stores a prep and returns it with nothing eaten", async () => {
    const [prep] = await preps();
    expect(prep).toMatchObject({ id: "chili001", name: "Chili", createdAt: NOW, discardedAt: null, portions: [] });
    expect(prep!.ingredients).toEqual(ingredients);
  });

  it("keeps each user's preps apart", async () => {
    expect(await preps("bob")).toEqual([]);
    expect((await reserve(0.5, "portion01", "chili001", "bob")).status).toBe(404);
    expect((await call("PATCH", "/api/preps/chili001", { discarded: true }, { user: "bob" })).status).toBe(404);
    // Bob may use the same prep ID; it's a different prep.
    expect((await call("PUT", "/api/preps/chili001", { name: "Bob's chili", ingredients }, { user: "bob" })).status).toBe(204);
    expect((await preps())[0]!.name).toBe("Chili");
    expect((await preps("bob"))[0]!.name).toBe("Bob's chili");
  });

  it("does not let a request name another user", async () => {
    await call("PUT", "/api/preps/chili001?user=bob", { name: "Chili", ingredients, user: "bob", userId: "bob" });
    expect(await preps("bob")).toEqual([]);
  });

  it("refuses requests without a valid ID token", async () => {
    expect((await call("GET", "/api/preps", undefined, { token: null })).status).toBe(401);
    expect((await call("GET", "/api/preps", undefined, { token: idToken({ aud: "another-app" }) })).status).toBe(401);
    expect((await call("GET", "/api/preps", undefined, { token: "an-access-token" })).status).toBe(401);
  });

  it("answers CORS only for the app's origins, and never caches", async () => {
    const ok = await call("GET", "/api/preps");
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    const elsewhere = await call("GET", "/api/preps", undefined, { origin: "https://evil.example" });
    expect(elsewhere.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await handle(new Request("https://food-index.froussios.com/api/preps", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } }), env, deps());
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("reserves portions until the batch is gone, then refuses with what is left", async () => {
    for (const id of ["portion01", "portion02", "portion03"]) expect((await reserve(1 / 3, id)).status).toBe(201);
    const refused = await reserve(0.01, "portion04");
    expect(refused.status).toBe(409);
    expect(refused.body!["left"]).toBe(0);
    expect((await preps())[0]!.portions.map((p) => p.state)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  it("refuses a portion bigger than what is left, and says how much that is", async () => {
    await reserve(0.75, "portion01");
    const refused = await reserve(0.5, "portion02");
    expect(refused.status).toBe(409);
    expect(refused.body!["left"]).toBeCloseTo(0.25);
  });

  it("takes the rest when no fraction is given", async () => {
    await reserve(1 / 6, "portion01");
    const rest = await reserve(null, "portion02");
    expect(rest.status).toBe(201);
    expect((rest.body!["portion"] as { fraction: number }).fraction).toBeCloseTo(5 / 6);
    expect((await reserve(null, "portion03")).status).toBe(409);
  });

  it("can't be overrun by requests sent at once", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserve(0.25, `portion0${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect((await preps())[0]!.portions.reduce((s, p) => s + p.fraction, 0)).toBeCloseTo(1);
  });

  it("returns the first reservation when the same portion is sent again", async () => {
    const first = await reserve(0.5, "portion01");
    const again = await reserve(0.5, "portion01");
    expect(again.status).toBe(201);
    expect(again.body!["portion"]).toEqual(first.body!["portion"]);
    expect((await preps())[0]!.portions).toHaveLength(1);
  });

  it("confirms a portion with its stored entry ID, and gives one back", async () => {
    await reserve(0.5, "portion01");
    expect((await call("PATCH", "/api/portions/portion01", { entryId: "e-abc-1234-prep-chili001" })).status).toBe(204);
    expect((await preps())[0]!.portions[0]).toMatchObject({ state: "confirmed", entryId: "e-abc-1234-prep-chili001" });
    expect((await call("DELETE", "/api/portions/portion01")).status).toBe(204);
    expect((await call("DELETE", "/api/portions/portion01")).status).toBe(204);
    expect((await preps())[0]!.portions).toEqual([]);
    expect((await call("PATCH", "/api/portions/portion01", { entryId: "e-abc-1234-prep-chili001" })).status).toBe(404);
  });

  it("can't touch another user's portion", async () => {
    await reserve(0.5, "portion01");
    expect((await call("PATCH", "/api/portions/portion01", { entryId: "e-x-1234-prep-chili001" }, { user: "bob" })).status).toBe(404);
    await call("DELETE", "/api/portions/portion01", undefined, { user: "bob" });
    expect((await preps())[0]!.portions).toHaveLength(1);
  });

  it("stops portions of a discarded prep, and brings it back", async () => {
    expect((await call("PATCH", "/api/preps/chili001", { discarded: true })).status).toBe(204);
    expect((await preps())[0]!.discardedAt).toBe(NOW);
    expect((await reserve(0.5, "portion01")).status).toBe(404);
    expect((await call("PATCH", "/api/preps/chili001", { discarded: false })).status).toBe(204);
    expect((await reserve(0.5, "portion01")).status).toBe(201);
  });

  it("replaces the name and ingredients, keeping what was eaten", async () => {
    await reserve(0.5, "portion01");
    now += 1000;
    await call("PUT", "/api/preps/chili001", { name: "Chili con carne", ingredients: ingredients.slice(0, 1) });
    const [prep] = await preps();
    expect(prep).toMatchObject({ name: "Chili con carne", createdAt: NOW, updatedAt: NOW + 1000 });
    expect(prep!.ingredients).toHaveLength(1);
    expect(prep!.portions).toHaveLength(1);
  });

  it("deletes preps 30 days after they were finished or discarded, and keeps the rest", async () => {
    await call("PUT", "/api/preps/soup0001", { name: "Soup", ingredients });
    await call("PUT", "/api/preps/stew0001", { name: "Stew", ingredients });
    await reserve(null, "portion01");
    await call("PATCH", "/api/preps/soup0001", { discarded: true });
    await call("POST", "/api/preps/stew0001/portions", { id: "portion02", fraction: 0.5, entryId: null, eatenAt: now });
    now += KEEP_ENDED_MS - 1;
    expect((await preps()).map((p) => p.id)).toEqual(["chili001", "soup0001", "stew0001"]);
    now += 2;
    expect((await preps()).map((p) => p.id)).toEqual(["stew0001"]);
  });

  it.each([
    ["no name", { ingredients }],
    ["a long name", { name: "x".repeat(81), ingredients }],
    ["no ingredients", { name: "Chili", ingredients: [] }],
    ["an unknown nutrient", { name: "Chili", ingredients: [{ ...ingredients[0], profile: { energyKcal: 1, nutrients: { arsenic: 1 } } }] }],
    ["a negative amount", { name: "Chili", ingredients: [{ ...ingredients[0], quantity: -1 }] }],
    ["an unknown food source", { name: "Chili", ingredients: [{ ...ingredients[0], ref: { source: "web", id: "x" } }] }],
  ])("refuses a prep with %s", async (_name, body) => {
    expect((await call("PUT", "/api/preps/chili002", body)).status).toBe(400);
  });

  it.each([
    ["a bad prep ID", "PUT", "/api/preps/BAD!", { name: "Chili", ingredients }],
    ["a fraction over 1", "POST", "/api/preps/chili001/portions", { id: "portion01", fraction: 1.5, entryId: null, eatenAt: NOW }],
    ["a fraction of 0", "POST", "/api/preps/chili001/portions", { id: "portion01", fraction: 0, entryId: null, eatenAt: NOW }],
    ["a bad portion ID", "POST", "/api/preps/chili001/portions", { id: "x", fraction: 0.5, entryId: null, eatenAt: NOW }],
    ["no time", "POST", "/api/preps/chili001/portions", { id: "portion01", fraction: 0.5, entryId: null }],
    ["a body that is not JSON", "PATCH", "/api/preps/chili001", "{"],
    ["a body that is too large", "PUT", "/api/preps/chili001", { name: "Chili", ingredients, padding: "x".repeat(70_000) }],
  ])("refuses %s", async (_name, method, path, body) => {
    expect([400, 413]).toContain((await call(method, path, body)).status);
  });

  it("answers 404 for anything else", async () => {
    expect((await call("GET", "/api/users")).status).toBe(404);
    expect((await call("DELETE", "/api/preps/chili001")).status).toBe(404);
  });
});
