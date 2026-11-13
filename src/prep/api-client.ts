/**
 * The browser's side of the meal prep and saved meal API (DR-24, docs/ARCHITECTURE.md section 4.5). It sends the
 * Google ID token, which proves who the user is, and never the access token, which could use the diary.
 */

import type { SavedMeal } from "../core/meal";
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
  /** Whether the site has the API, once asked: it doesn't change while the page is open. */
  private present?: Promise<boolean>;

  constructor(
    /** e.g. https://food-index.froussios.com/api/ */
    private readonly base: string,
    private readonly idToken: () => string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /**
   * Whether this site serves the API. Asked without a token, so the browser sends it without a CORS preflight:
   * a site without the API refuses preflights, which would hide its 404 behind a network error. The API answers
   * a request without a token with its own JSON error (401). Throws PrepApiError (status 0) when nothing answers,
   * and asks again next time. Only list() asks; any other call runs once the card is shown.
   */
  available(): Promise<boolean> {
    this.present ??= (async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(new URL("preps", this.base), { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        log.warn("Checking for the meal prep API: no answer", describeError(e));
        throw new PrepApiError("The meal prep service did not answer. Check your connection and try again.", 0);
      }
      // A server error is a broken API, not a missing one: show it, and ask again next time.
      if (res.status >= 500) throw new PrepApiError(`The meal prep service failed (HTTP ${res.status}). Try again later.`, res.status);
      const json = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
      // Only the API answers with its own JSON error. Anything else, such as a 404 or an HTML page, is a site without it.
      const present = typeof json?.error === "string";
      log.info(present ? "This site has the meal prep API" : "This site has no meal prep API", { status: res.status });
      return present;
    })().catch((e: unknown) => {
      this.present = undefined;
      throw e;
    });
    return this.present;
  }

  async list(): Promise<Prep[]> {
    if (!(await this.available())) throw new PrepApiMissingError("Meal prep is not available on this site.");
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

  /**
   * The user's saved meals. Undefined when the site's API is older than saved meals: it answers its own 404, and the
   * app then shows meal prep without them. Throws PrepApiMissingError on a site with no API at all.
   */
  async listMeals(): Promise<SavedMeal[] | undefined> {
    if (!(await this.available())) throw new PrepApiMissingError("Saved meals are not available on this site.");
    try {
      const body = (await this.request("GET", "meals")) as { meals?: SavedMeal[] } | undefined;
      return body?.meals ?? [];
    } catch (e) {
      if (e instanceof PrepApiError && e.status === 404) {
        log.info("This site's API has no saved meals yet");
        return undefined;
      }
      throw e;
    }
  }

  async saveMeal(id: string, name: string, ingredients: readonly PrepIngredient[]): Promise<void> {
    await this.request("PUT", `meals/${id}`, { name, ingredients });
  }

  async deleteMeal(id: string): Promise<void> {
    await this.request("DELETE", `meals/${id}`);
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
    // A backstop: in a browser, available() is the real check, because on a site without the API the preflight fails first.
    if (res.status === 404 && json?.error === undefined) throw new PrepApiMissingError("Meal prep is not available on this site.");
    log.warn(`${method} ${path}: HTTP ${res.status}`, { error: json?.error });
    throw new PrepApiError(json?.error ?? `The meal prep service answered HTTP ${res.status}.`, res.status, json?.left);
  }
}
