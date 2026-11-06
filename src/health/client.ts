import type { DataPoint, Identity, ListDataPointsResponse, Operation } from "./types";
import { nutritionDayFilter } from "../core/time";
import { describeError, logger, truncate } from "../debug/log";

const log = logger("health-api");

export const HEALTH_API_BASE = "https://health.googleapis.com/v4";

export class HealthApiError extends Error {
  override name = "HealthApiError";
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly status?: string,
    readonly reasons: readonly string[] = [],
  ) {
    super(message);
  }

  /** The user has not signed in to the Google Health app yet (see docs/ARCHITECTURE.md). */
  get accountNotLinked(): boolean {
    return this.reasons.includes("ACCOUNT_NOT_LINKED") || /ACCOUNT_NOT_LINKED/.test(this.message);
  }

  /** The request got no answer: no connection, a CORS failure or a timeout. A write may still have arrived. */
  get connectionFailed(): boolean {
    return this.status === "NETWORK" || this.status === "TIMEOUT";
  }
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

type Query = Record<string, string | number | undefined>;

export interface ListOptions {
  /** Requested page size; the server may return fewer. */
  readonly pageSize?: number;
  /** Stop after this many pages even if more remain. */
  readonly maxPages?: number;
  /** Stop as soon as this returns true for the items fetched so far. */
  readonly stopWhen?: (items: readonly DataPoint[]) => boolean;
}

/**
 * Minimal browser client for the Google Health API.
 * The API sends CORS headers for any origin, so no proxy is needed.
 */
export class HealthClient {
  /** Told after each request whether it got an answer. Any HTTP response counts, even an error. */
  onRequestDone?: (answered: boolean) => void;

  constructor(
    private readonly getToken: TokenProvider,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly base: string = HEALTH_API_BASE,
    /** Covers the whole request, including reading the response body. */
    private readonly timeoutMs = 20_000,
  ) {}

  getIdentity(): Promise<Identity> {
    return this.request("GET", "users/me/identity");
  }

  /** All nutrition-log data points whose local start time falls on `date` (YYYY-MM-DD). */
  async listNutritionLogs(date: string): Promise<DataPoint[]> {
    return this.listAll("users/me/dataTypes/nutrition-log/dataPoints", { filter: nutritionDayFilter(date) });
  }

  createNutritionLog(point: DataPoint): Promise<Operation> {
    return this.request("POST", "users/me/dataTypes/nutrition-log/dataPoints", { body: point });
  }

  /** Deletes are only possible through batchDelete; a plain DELETE returns 404. */
  deleteNutritionLogs(names: readonly string[]): Promise<Operation> {
    return this.request("POST", "users/me/dataTypes/nutrition-log/dataPoints:batchDelete", { body: { names } });
  }

  /**
   * Google's food measurement units. This is the whole shared catalogue
   * (thousands of units, about 25 per page), so callers should stop early.
   */
  listFoodMeasurementUnits(opts: ListOptions = {}): Promise<DataPoint[]> {
    return this.listAll("users/me/dataTypes/food-measurement-unit/dataPoints", {}, { pageSize: 1000, ...opts });
  }

  private async listAll(path: string, query: Query, opts: ListOptions = {}): Promise<DataPoint[]> {
    const out: DataPoint[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page: ListDataPointsResponse = await this.request("GET", path, {
        query: { ...query, pageSize: opts.pageSize, pageToken },
      });
      out.push(...(page.dataPoints ?? []));
      pages++;
      pageToken = page.nextPageToken || undefined;
      if (pageToken && opts.stopWhen?.(out)) {
        log.debug(`${path}: stopped after ${pages} page(s), ${out.length} items: found what was needed`);
        break;
      }
      if (pageToken && opts.maxPages !== undefined && pages >= opts.maxPages) {
        log.warn(`${path}: stopped at the limit of ${opts.maxPages} page(s), ${out.length} items; more remain`);
        break;
      }
    } while (pageToken);
    return out;
  }

  private async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const call = `${method} ${path}`;
    const query = Object.fromEntries(url.searchParams);
    const details = {
      ...(Object.keys(query).length ? { query } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    };
    log.debug(`→ ${call}`, Object.keys(details).length ? details : undefined);
    const started = performance.now();

    // One deadline for the whole exchange, including reading the body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const send = (token: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      return this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    };

    let res: Response;
    let text: string;
    try {
      res = await send(await this.getToken());
      if (res.status === 401) {
        log.warn(`${call}: 401, the access token was rejected`, { body: truncate(await res.text()) });
        // Ask the provider for a fresh token. The current Google Identity Services provider cannot
        // refresh silently and throws SignInRequiredError (the UI then asks for a click); a
        // refresh-token provider (milestone M3) would return a new token, and we retry once.
        res = await send(await this.getToken({ forceRefresh: true }));
      }
      text = await res.text();
    } catch (e) {
      const ms = Math.round(performance.now() - started);
      const error = controller.signal.aborted
        ? new HealthApiError(`Google Health did not answer within ${this.timeoutMs / 1000} s (${call}).`, 0, "TIMEOUT")
        : e instanceof TypeError
          ? // fetch rejects with a bare TypeError on network and CORS failures.
            new HealthApiError(`Could not reach Google Health (${e.message}; ${call}).`, 0, "NETWORK")
          : e;
      log.error(`✗ ${call} failed after ${ms} ms`, describeError(error));
      if (error instanceof HealthApiError) this.onRequestDone?.(false);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - started);
    this.onRequestDone?.(true);

    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      log.error(`✗ ${call}: HTTP ${res.status} in ${ms} ms, response is not JSON`, { contentType: res.headers.get("content-type"), body: truncate(text) });
      // Proxies and some Google front ends answer errors with HTML.
      if (!res.ok) throw new HealthApiError(`HTTP ${res.status} from ${call}: ${text.slice(0, 200)}`, res.status);
      throw new HealthApiError(`Unreadable response from ${call}`, res.status);
    }
    if (!res.ok) {
      log.error(`✗ ${call}: HTTP ${res.status} in ${ms} ms`, json);
      throw toError(res.status, json, call);
    }
    log.info(`← ${call}: HTTP ${res.status} in ${ms} ms`, summarize(json));
    return json as T;
  }
}

/** Keeps successful responses readable in the log: counts for lists, the full object otherwise. */
function summarize(json: unknown): unknown {
  const page = json as { dataPoints?: unknown[]; nextPageToken?: string };
  if (Array.isArray(page.dataPoints)) {
    return { dataPoints: page.dataPoints.length, nextPageToken: page.nextPageToken || undefined, first: page.dataPoints[0] };
  }
  return json;
}


function toError(httpStatus: number, json: unknown, call: string): HealthApiError {
  const err = (json as { error?: { message?: string; status?: string; details?: { reason?: string }[] } }).error;
  const reasons = (err?.details ?? []).flatMap((d) => (d.reason ? [d.reason] : []));
  const code = [err?.status, ...reasons].filter(Boolean).join(", ");
  const message = `${err?.message ?? "Request failed"} (HTTP ${httpStatus}${code ? `, ${code}` : ""}; ${call})`;
  return new HealthApiError(message, httpStatus, err?.status, reasons);
}
