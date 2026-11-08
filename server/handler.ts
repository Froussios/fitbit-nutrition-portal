/**
 * The meal prep API (DR-24), served by a Pages Function at /api/* on the food index's site.
 *
 *   GET    /api/preps                      the user's preps and their portions
 *   PUT    /api/preps/:id                  create a prep, or replace its name and ingredients
 *   PATCH  /api/preps/:id                  { discarded: boolean }
 *   POST   /api/preps/:id/portions         reserve { id, fraction | null, entryId, eatenAt }; 409 if too much
 *   PATCH  /api/portions/:id               { entryId }: the diary entry exists
 *   DELETE /api/portions/:id               give a portion back
 *
 * Every request carries a Google ID token, and the user is whoever it names. Nothing in the
 * request can choose another user.
 */

import { ENTRY_ID, FRACTION_EPSILON, MAX_NAME, PORTION_ID, PREP_ID, checkIngredients } from "../src/core/prep";
import { AuthError, GoogleKeys, verifyIdToken, type KeyLookup } from "./auth";
import type { D1Database } from "./d1";
import { PrepStore } from "./store";

export interface Env {
  readonly DB: D1Database;
  /** Comma-separated OAuth client IDs whose ID tokens are accepted. */
  readonly GOOGLE_CLIENT_IDS: string;
  /** Comma-separated origins allowed to call the API. */
  readonly ALLOWED_ORIGINS: string;
}

export interface Deps {
  readonly keys: KeyLookup;
  readonly now: () => number;
}

const MAX_BODY = 64 * 1024;
/** Shared by every request this Function instance serves, so that Google's keys are fetched rarely. */
const googleKeys = new GoogleKeys();
const defaults: Deps = { keys: googleKeys.lookup, now: Date.now };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const list = (value: string) => value.split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !list(env.ALLOWED_ORIGINS).includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, PATCH, POST, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function reply(request: Request, env: Env, status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request, env), "Cache-Control": "no-store", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "The request is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request is not JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "The request is not an object.");
  return value as Record<string, unknown>;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e14;

async function userOf(request: Request, env: Env, deps: Deps): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "Sign in first.");
  try {
    return await verifyIdToken(token, { clientIds: list(env.GOOGLE_CLIENT_IDS), now: deps.now(), keys: deps.keys });
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(401, "Sign in again.");
    throw e;
  }
}

export async function handle(request: Request, env: Env, deps: Deps = defaults): Promise<Response> {
  if (request.method === "OPTIONS") return reply(request, env, 204);
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const user = await userOf(request, env, deps);
    const store = new PrepStore(env.DB);
    const now = deps.now();
    const method = request.method;
    let m: RegExpExecArray | null;

    if (path === "/api/preps" && method === "GET") return reply(request, env, 200, { preps: await store.list(user, now) });

    if ((m = /^\/api\/preps\/([^/]+)$/.exec(path))) {
      const id = m[1]!;
      if (!PREP_ID.test(id)) throw new HttpError(400, "Bad prep ID.");
      if (method === "PUT") {
        const body = await readBody(request);
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (!name || name.length > MAX_NAME) throw new HttpError(400, `A prep needs a name of up to ${MAX_NAME} characters.`);
        let ingredients;
        try {
          ingredients = checkIngredients(body["ingredients"]);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : "Bad ingredients.");
        }
        await store.save(user, id, name, ingredients, now);
        return reply(request, env, 204);
      }
      if (method === "PATCH") {
        const { discarded } = await readBody(request);
        if (typeof discarded !== "boolean") throw new HttpError(400, "Say whether the prep is discarded.");
        if (!(await store.setDiscarded(user, id, discarded, now))) throw new HttpError(404, "No such prep.");
        return reply(request, env, 204);
      }
    }

    if ((m = /^\/api\/preps\/([^/]+)\/portions$/.exec(path)) && method === "POST") {
      const prepId = m[1]!;
      const { id, fraction, entryId, eatenAt } = await readBody(request);
      if (!PREP_ID.test(prepId) || typeof id !== "string" || !PORTION_ID.test(id)) throw new HttpError(400, "Bad prep or portion ID.");
      if (fraction !== null && (typeof fraction !== "number" || !(fraction > FRACTION_EPSILON) || fraction > 1)) throw new HttpError(400, "A portion is more than 0 and at most the whole batch.");
      if (entryId !== null && (typeof entryId !== "string" || !ENTRY_ID.test(entryId))) throw new HttpError(400, "Bad entry ID.");
      if (!isTime(eatenAt)) throw new HttpError(400, "Bad time.");
      const result = await store.reserve(user, prepId, { id, fraction, entryId, eatenAt }, now);
      if (result.kind === "no-prep") throw new HttpError(404, "No such prep, or it was discarded.");
      if (result.kind === "too-much") throw new HttpError(409, "That is more than is left.", { left: result.left });
      return reply(request, env, 201, { portion: result.portion });
    }

    if ((m = /^\/api\/portions\/([^/]+)$/.exec(path))) {
      const id = m[1]!;
      if (!PORTION_ID.test(id)) throw new HttpError(400, "Bad portion ID.");
      if (method === "PATCH") {
        const { entryId } = await readBody(request);
        if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) throw new HttpError(400, "Bad entry ID.");
        if (!(await store.confirm(user, id, entryId))) throw new HttpError(404, "No such portion.");
        return reply(request, env, 204);
      }
      if (method === "DELETE") {
        await store.remove(user, id);
        return reply(request, env, 204);
      }
    }

    throw new HttpError(404, "No such endpoint.");
  } catch (e) {
    if (e instanceof HttpError) return reply(request, env, e.status, { error: e.message, ...e.extra });
    // Never echo internal errors: they could contain request data.
    console.error("meal prep API error", e instanceof Error ? e.name : "unknown");
    return reply(request, env, 500, { error: "Something went wrong." });
  }
}
