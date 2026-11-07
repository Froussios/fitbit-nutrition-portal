/**
 * The request for one Google sign-in, and the checks on its answer (DR-24). One request
 * returns an access token, for the browser's calls to Google Health, and an ID token, which
 * proves who the user is and grants no API access. Pure, so that the checks can be tested.
 *
 * Error messages here reach the UI and the debug log, so they must never contain a token.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface SignInRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Ties the answer to this attempt. */
  readonly state: string;
  /** Google copies it into the ID token. */
  readonly nonce: string;
  readonly prompt?: "consent" | "select_account" | undefined;
  /** The account's `sub`, so that Google need not ask which account to use. */
  readonly loginHint?: string | undefined;
}

export function signInUrl(request: SignInRequest): string {
  const url = new URL(AUTH_ENDPOINT);
  const params: Record<string, string | undefined> = {
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: "token id_token",
    scope: request.scopes.join(" "),
    state: request.state,
    nonce: request.nonce,
    prompt: request.prompt,
    login_hint: request.loginHint,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.href;
}

export interface SignInTokens {
  readonly accessToken: string;
  readonly idToken: string;
  /** The ID token's `sub`: stable, never reused, and not a secret. */
  readonly subject: string;
  /** When the first of the two tokens expires, in milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly scope: string;
}

interface IdTokenClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly exp?: unknown;
  readonly nonce?: unknown;
}

function decodeClaims(idToken: string): IdTokenClaims {
  try {
    const payload = idToken.split(".")[1] ?? "";
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims === "object" && claims !== null) return claims;
  } catch {
    // Reported below. The original error could quote part of the token.
  }
  throw new Error("Google's sign-in answer could not be read. Try again.");
}

/**
 * Checks Google's answer. The token came straight from Google over TLS, so this does not verify
 * its signature, as the meal prep API must. `state` was checked before getting here.
 */
export function readSignInAnswer(answer: Readonly<Record<string, string>>, expected: { readonly clientId: string; readonly nonce: string; readonly now: number }): SignInTokens {
  const { access_token: accessToken, id_token: idToken, error } = answer;
  if (error === "access_denied") throw new Error("Google sign-in was cancelled, or access was refused.");
  if (error) throw new Error(`Google sign-in failed (${error}).`);
  if (!accessToken || !idToken) throw new Error("Google's sign-in answer was incomplete. Try again.");

  const claims = decodeClaims(idToken);
  const valid =
    typeof claims.iss === "string" &&
    ISSUERS.has(claims.iss) &&
    claims.aud === expected.clientId &&
    claims.nonce === expected.nonce &&
    typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > expected.now;
  if (!valid) throw new Error("Google's sign-in answer did not pass its checks. Try again.");

  const expiresIn = Number(answer["expires_in"]);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Google's sign-in answer was incomplete. Try again.");
  return {
    accessToken,
    idToken,
    subject: claims.sub as string,
    expiresAt: Math.min(expected.now + expiresIn * 1000, (claims.exp as number) * 1000),
    scope: answer["scope"] ?? "",
  };
}
