/**
 * The browser's side of the meal prep API (DR-24, docs/ARCHITECTURE.md section 4.5). It sends the
 * Google ID token, which proves who the user is, and never the access token, which could use the diary.
 */

import type { Prep, PrepIngredient, PrepPortion } from "../core/prep";
import { describeError, logger } from "../debug/log";

const log = logger("meal-prep");
const TIMEOUT_MS = 20_000;

export class PrepApiError extends Error {
  override name = "PrepApiError";
  constructor(
    message: string,
    /** 0 when there was no answer. */
    readonly status: number,
    /** What is left of the batch, when a portion was too big. */
    readonly left?: number,
  ) {
    super(message);
  }

  /** No answer: the request may still have arrived. */
  get connectionFailed(): boolean {
    return this.status === 0;
  }
}

/** The API is not deployed on this site, so the app shows no meal prep at all. */
export class PrepApiMissingError extends Error {
  override name = "PrepApiMissingError";
}

export class PrepApi {
  constructor(
    /** e.g. https://food-index.froussios.com/api/ */
    private readonly base: string,
    private readonly idToken: () => string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async list(): Promise<Prep[]> {
    const body = (await this.request("GET", "preps")) as { preps?: Prep[] } | undefined;
    return body?.preps ?? [];
  }

  async save(id: string, name: string, ingredients: readonly PrepIngredient[]): Promise<void> {
    await this.request("PUT", `preps/${id}`, { name, ingredients });
  }

  async setDiscarded(id: string, discarded: boolean): Promise<void> {
    await this.request("PATCH", `preps/${id}`, { discarded });
  }

  /** With a null fraction, takes what is left. Throws PrepApiError with `left` when the portion is too big. */
  async reserve(prepId: string, portion: { id: string; fraction: number | null; entryId: string; eatenAt: number }): Promise<PrepPortion> {
    const body = (await this.request("POST", `preps/${prepId}/portions`, portion)) as { portion: PrepPortion };
    return body.portion;
  }

  async confirm(portionId: string, entryId: string): Promise<void> {
    await this.request("PATCH", `portions/${portionId}`, { entryId });
  }

  async remove(portionId: string): Promise<void> {
    await this.request("DELETE", `portions/${portionId}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.idToken(); // throws SignInRequiredError when the session has expired
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(new URL(path, this.base), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      log.warn(`${method} ${path}: no answer`, describeError(e));
      throw new PrepApiError("The meal prep service did not answer. Check your connection and try again.", 0);
    } finally {
      clearTimeout(timer);
    }
    let json: { error?: string; left?: number } | undefined;
    try {
      json = text ? (JSON.parse(text) as typeof json) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) {
      log.debug(`${method} ${path}: HTTP ${res.status}`);
      return json;
    }
    // A site without the API answers its own 404 page, not the API's JSON.
    if (res.status === 404 && json?.error === undefined) throw new PrepApiMissingError("Meal prep is not available on this site.");
    log.warn(`${method} ${path}: HTTP ${res.status}`, { error: json?.error });
    throw new PrepApiError(json?.error ?? `The meal prep service answered HTTP ${res.status}.`, res.status, json?.left);
  }
}
