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

  it("reports network and CORS failures", async () => {
    const fail: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const err = (await new HealthClient(token, fail).getIdentity().catch((e: unknown) => e)) as HealthApiError;
    expect(err.status).toBe("NETWORK");
    expect(err.message).toContain("Failed to fetch");
  });
});
