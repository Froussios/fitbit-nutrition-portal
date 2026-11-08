/**
 * Who is asking: a Google ID token, checked here against Google's public keys (DR-24). It
 * proves who the user is and grants no access to their data. The API never receives the
 * access token, which could use the diary.
 */

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Allowed difference between Google's clock and ours. */
const CLOCK_SKEW_S = 60;
/** How long to keep Google's keys when it says nothing, and the shortest wait before fetching them again. */
const DEFAULT_KEYS_TTL_MS = 60 * 60_000;
const MIN_REFETCH_MS = 60_000;

export class AuthError extends Error {
  override name = "AuthError";
}

/** Finds Google's signing key by its ID. */
export type KeyLookup = (kid: string) => Promise<CryptoKey | undefined>;

const decoder = new TextDecoder();

function base64url(part: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return out;
}

function json(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(decoder.decode(base64url(part)));
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return value as Record<string, unknown>;
}

/** Returns the token's `sub`, or throws AuthError. Messages never quote the token. */
export async function verifyIdToken(token: string, opts: { readonly clientIds: readonly string[]; readonly now: number; readonly keys: KeyLookup }): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Not an ID token.");
  const [head = "", body = "", signature = ""] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = json(head);
    claims = json(body);
  } catch {
    throw new AuthError("Not an ID token.");
  }
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") throw new AuthError("Unsupported ID token.");
  const key = await opts.keys(header["kid"]);
  if (!key) throw new AuthError("Unknown signing key.");
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(signature), new TextEncoder().encode(`${head}.${body}`));
  } catch {
    valid = false;
  }
  if (!valid) throw new AuthError("Bad signature.");

  const now = opts.now / 1000;
  const { iss, aud, sub, exp, iat } = claims;
  if (typeof iss !== "string" || !ISSUERS.has(iss)) throw new AuthError("Wrong issuer.");
  if (typeof aud !== "string" || !opts.clientIds.includes(aud)) throw new AuthError("Issued to another app.");
  if (typeof exp !== "number" || exp + CLOCK_SKEW_S < now) throw new AuthError("Expired.");
  if (typeof iat === "number" && iat - CLOCK_SKEW_S > now) throw new AuthError("Issued in the future.");
  if (typeof sub !== "string" || sub === "" || sub.length > 255) throw new AuthError("No user.");
  return sub;
}

/** Google's signing keys, kept for as long as Google's Cache-Control allows. */
export class GoogleKeys {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  private expiresAt = 0;
  private loading?: Promise<void>;

  constructor(
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  readonly lookup: KeyLookup = async (kid) => {
    const stale = this.now() >= this.expiresAt;
    // An unknown key may be a new one after Google rotates them, but don't let a bad token make us fetch on every request.
    const unknown = !this.keys.has(kid) && this.now() - this.fetchedAt >= MIN_REFETCH_MS;
    if (stale || unknown) await this.refresh();
    return this.keys.get(kid);
  };

  private refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async load(): Promise<void> {
    const res = await this.fetchImpl(CERTS_URL);
    if (!res.ok) throw new Error(`Google's keys answered HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
    this.keys = next;
    this.fetchedAt = this.now();
    this.expiresAt = this.fetchedAt + (maxAge ? Number(maxAge) * 1000 : DEFAULT_KEYS_TTL_MS);
  }
}
