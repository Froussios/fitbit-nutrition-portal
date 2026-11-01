import type { DataPoint, Identity, ListDataPointsResponse, Operation } from "./types";
import { nutritionDayFilter } from "../core/time";

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
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

type Query = Record<string, string | number | undefined>;

/**
 * Minimal browser client for the Google Health API.
 * The API sends CORS headers for any origin, so no proxy is needed.
 */
export class HealthClient {
  constructor(
    private readonly getToken: TokenProvider,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly base: string = HEALTH_API_BASE,
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

  listFoodMeasurementUnits(): Promise<DataPoint[]> {
    return this.listAll("users/me/dataTypes/food-measurement-unit/dataPoints", {});
  }

  private async listAll(path: string, query: Query): Promise<DataPoint[]> {
    const out: DataPoint[] = [];
    let pageToken: string | undefined;
    do {
      const page: ListDataPointsResponse = await this.request("GET", path, { query: { ...query, pageToken } });
      out.push(...(page.dataPoints ?? []));
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }

  private async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const send = async (forceRefresh: boolean) => {
      const token = await this.getToken({ forceRefresh });
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      return this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    };

    let res = await send(false);
    if (res.status === 401) res = await send(true); // token expired or revoked: one retry

    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) throw toError(res.status, json);
    return json as T;
  }
}

function toError(httpStatus: number, json: unknown): HealthApiError {
  const err = (json as { error?: { message?: string; status?: string; details?: { reason?: string }[] } }).error;
  const reasons = (err?.details ?? []).flatMap((d) => (d.reason ? [d.reason] : []));
  return new HealthApiError(err?.message ?? `HTTP ${httpStatus}`, httpStatus, err?.status, reasons);
}
