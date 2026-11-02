import { describe, expect, it } from "vitest";
import { HealthApiError, HealthClient } from "../src/health/client";

const token = async () => "tok";
const respond = (status: number, body: string): typeof fetch => async () => new Response(body, { status });

describe("HealthClient errors", () => {
  it("includes the HTTP status, Google status and reason in the message", async () => {
    const body = JSON.stringify({
      error: { code: 403, message: "Google Health API has not been used in project 123", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
    });
    const err = await new HealthClient(token, respond(403, body)).getIdentity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HealthApiError);
    expect((err as Error).message).toBe(
      "Google Health API has not been used in project 123 (HTTP 403, PERMISSION_DENIED, SERVICE_DISABLED; GET users/me/identity)",
    );
  });

  it("recognises ACCOUNT_NOT_LINKED", async () => {
    const body = JSON.stringify({ error: { code: 400, message: "x", status: "FAILED_PRECONDITION", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } });
    const err = (await new HealthClient(token, respond(400, body)).getIdentity().catch((e: unknown) => e)) as HealthApiError;
    expect(err.accountNotLinked).toBe(true);
  });

  it("survives a non-JSON error body", async () => {
    const err = await new HealthClient(token, respond(404, "<html>Not Found</html>")).getIdentity().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^HTTP 404 from GET users\/me\/identity: <html>/);
  });

  it("times out instead of hanging", async () => {
    const never: typeof fetch = (_i, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const err = (await new HealthClient(token, never, undefined, 50).getIdentity().catch((e: unknown) => e)) as HealthApiError;
    expect(err.status).toBe("TIMEOUT");
  });

  it("times out when the response body stalls", async () => {
    const stallingBody: typeof fetch = async (_i, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"name":'));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { status: 200 },
      );
    const err = (await new HealthClient(token, stallingBody, undefined, 50).getIdentity().catch((e: unknown) => e)) as HealthApiError;
    expect(err.status).toBe("TIMEOUT");
  });

  it("asks the token provider for a fresh token on 401 and retries once", async () => {
    const tokens: string[] = [];
    const seen: (string | null)[] = [];
    const provider = async (o?: { forceRefresh?: boolean }) => {
      const t = o?.forceRefresh ? "fresh" : "stale";
      tokens.push(t);
      return t;
    };
    const fetchImpl: typeof fetch = async (_i, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push(auth);
      return auth === "Bearer fresh" ? new Response('{"name":"users/me/identity"}', { status: 200 }) : new Response("{}", { status: 401 });
    };
    await new HealthClient(provider, fetchImpl).getIdentity();
    expect(tokens).toEqual(["stale", "fresh"]);
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("propagates the provider's sign-in error on 401", async () => {
    class SignIn extends Error {}
    const provider = async (o?: { forceRefresh?: boolean }) => {
      if (o?.forceRefresh) throw new SignIn("sign in");
      return "stale";
    };
    const err = await new HealthClient(provider, respond(401, "{}")).getIdentity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignIn);
  });

  it("reports network and CORS failures", async () => {
    const fail: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const err = (await new HealthClient(token, fail).getIdentity().catch((e: unknown) => e)) as HealthApiError;
    expect(err.status).toBe("NETWORK");
    expect(err.message).toContain("Failed to fetch");
  });
});

describe("HealthClient paging", () => {
  /** A fake catalogue of `total` units served `perPage` at a time; records the requests. */
  function catalogue(total: number, perPage: number, named: Record<number, string>) {
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const end = Math.min(start + perPage, total);
      const dataPoints = Array.from({ length: end - start }, (_, i) => ({
        name: `u/${start + i}`,
        foodMeasurementUnit: { displayName: named[start + i] ?? `unit ${start + i}` },
      }));
      return new Response(JSON.stringify({ dataPoints, ...(end < total ? { nextPageToken: String(end) } : {}) }), { status: 200 });
    };
    return { requests, fetchImpl };
  }

  it("asks for large pages and stops as soon as stopWhen is satisfied", async () => {
    const { requests, fetchImpl } = catalogue(500, 25, { 30: "gram", 60: "milliliter" });
    const units = await new HealthClient(token, fetchImpl).listFoodMeasurementUnits({
      stopWhen: (items) => items.some((p) => p.foodMeasurementUnit?.displayName === "milliliter"),
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]!.searchParams.get("pageSize")).toBe("1000");
    expect(units).toHaveLength(75);
  });

  it("stops at maxPages", async () => {
    const { requests, fetchImpl } = catalogue(500, 25, {});
    const units = await new HealthClient(token, fetchImpl).listFoodMeasurementUnits({ maxPages: 4 });
    expect(requests).toHaveLength(4);
    expect(units).toHaveLength(100);
  });

  it("reads every page when nothing limits it", async () => {
    const { requests, fetchImpl } = catalogue(60, 25, {});
    expect(await new HealthClient(token, fetchImpl).listFoodMeasurementUnits()).toHaveLength(60);
    expect(requests).toHaveLength(3);
  });
});
