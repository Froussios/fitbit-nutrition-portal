/**
 * Browser-only Google sign-in. There is no client secret and no refresh token: a
 * popup returns an access token and an ID token, each lasting about an hour. When they
 * expire, the user clicks "Continue" and Google issues new ones (DR-24).
 *
 * The app asks Google directly because Google's token client never returns an ID token.
 * Google answers on auth-callback.html, which passes the answer back to this window.
 */

import { logger } from "../debug/log";
import { readSignInAnswer, signInUrl } from "./sign-in-answer";

const log = logger("auth");
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const STORAGE_KEY = "foodDiary.token";
/** The last account signed in with, so that Google need not ask again. Not a secret. */
const ACCOUNT_KEY = "foodDiary.account";
const POPUP_NAME = "food-diary-sign-in";
/** Treat tokens as expired a little early so in-flight requests don't fail. */
const EXPIRY_MARGIN_MS = 60_000;
const POPUP_CHECK_MS = 500;
/** The answer is sent just before the popup closes, so a closed popup gets this long for it to arrive. */
const CLOSED_GRACE_MS = 1_000;

export class SignInRequiredError extends Error {
  override name = "SignInRequiredError";
  constructor(message = "Please sign in to Google to continue.") {
    super(message);
  }
}

/** A newer attempt took over this one's popup, so there is nothing to tell the user. */
export class SignInSupersededError extends Error {
  override name = "SignInSupersededError";
  constructor() {
    super("Sign-in superseded by a new attempt.");
  }
}

interface StoredToken {
  accessToken: string;
  idToken: string;
  subject: string;
  expiresAt: number;
  scope: string;
  clientId: string;
}

function randomValue(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class GoogleAuth {
  private token?: StoredToken;
  /** Ends the sign-in under way, if any. */
  private cancelPending?: (reason: Error) => void;
  private readonly listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clientId: string,
    private readonly scopes: readonly string[],
    /** Scopes without which the app cannot work. */
    private readonly requiredScopes: readonly string[] = scopes,
  ) {
    this.token = this.restore();
    if (this.token) {
      log.info("Restored the sign-in from this tab's session", {
        expiresAt: new Date(this.token.expiresAt).toISOString(),
        valid: this.isSignedIn,
        scopes: this.grantedScopes,
      });
      this.scheduleExpiry();
    }
  }

  get isSignedIn(): boolean {
    return this.token !== undefined && this.token.expiresAt - EXPIRY_MARGIN_MS > Date.now();
  }

  /** True when there was a session that has since expired (show "Continue", not "Sign in"). */
  get hasExpiredSession(): boolean {
    return this.token !== undefined && !this.isSignedIn;
  }

  /** The signed-in account's `sub`, which is not a secret. Kept after the tokens expire, until sign-out. */
  get subject(): string | undefined {
    return this.token?.subject;
  }

  get grantedScopes(): string[] {
    return this.token?.scope.split(" ").filter(Boolean) ?? [];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Must run inside a user gesture (click), or the popup is blocked: nothing may wait before it opens. */
  signIn(prompt: "" | "consent" | "select_account" = ""): Promise<void> {
    if (!navigator.onLine) return Promise.reject(new Error("You are offline. Signing in needs a connection."));

    const state = randomValue();
    const nonce = randomValue();
    const loginHint = prompt === "select_account" ? undefined : this.lastAccount();
    const url = signInUrl({
      clientId: this.clientId,
      redirectUri: new URL("auth-callback.html", location.href).href,
      scopes: this.scopes,
      state,
      nonce,
      prompt: prompt || undefined,
      loginHint,
    });
    log.info(`Opening the Google sign-in popup (prompt: "${prompt}")`, { scopes: this.scopes, origin: location.origin, accountHint: Boolean(loginHint) });
    const popup = window.open(url, POPUP_NAME, "width=500,height=650");
    if (!popup) {
      log.error("The browser blocked the sign-in popup");
      return Promise.reject(new Error("The Google sign-in popup was blocked. Allow popups for this site and try again."));
    }

    this.cancelPending?.(new SignInSupersededError());
    return new Promise<void>((resolve, reject) => {
      let closedTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        window.removeEventListener("message", onMessage);
        clearInterval(closedCheck);
        clearTimeout(closedTimer);
        this.cancelPending = undefined;
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.source !== popup) return;
        const data = event.data as { type?: unknown; answer?: Record<string, string> } | null;
        if (data?.type !== "google-sign-in" || !data.answer) return;
        if (data.answer["state"] !== state) {
          log.warn("Ignored a sign-in answer with the wrong state");
          return;
        }
        finish();
        try {
          this.accept(data.answer, nonce);
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Google sign-in failed."));
        }
      };
      const closedCheck = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(closedCheck);
        closedTimer = setTimeout(() => {
          finish();
          log.warn("The sign-in popup closed without an answer");
          reject(new Error("The Google sign-in window was closed before finishing."));
        }, CLOSED_GRACE_MS);
      }, POPUP_CHECK_MS);
      this.cancelPending = (reason) => {
        finish();
        reject(reason);
      };
      window.addEventListener("message", onMessage);
    });
  }

  /** Returns a valid access token, or throws SignInRequiredError (the UI then asks for a click). */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (opts.forceRefresh && this.token) {
      log.warn("Access token rejected by the API; marking it expired");
      this.token = { ...this.token, expiresAt: 0 };
      this.persist();
      this.scheduleExpiry();
      this.emit();
    }
    if (!this.isSignedIn || !this.token) throw new SignInRequiredError();
    return this.token.accessToken;
  }

  /** The proof of identity for our own API, which grants no access to Google's (DR-24). */
  getIdToken(): string {
    if (!this.isSignedIn || !this.token) throw new SignInRequiredError();
    return this.token.idToken;
  }

  signOut(): void {
    log.info("Signing out and revoking the access token");
    this.cancelPending?.(new Error("Signed out."));
    const accessToken = this.token?.accessToken;
    this.token = undefined;
    this.persist();
    this.forgetAccount();
    this.scheduleExpiry();
    if (accessToken) void revoke(accessToken);
    this.emit();
  }

  /** Throws if the answer is not good enough to sign in with. */
  private accept(answer: Readonly<Record<string, string>>, nonce: string): void {
    let tokens;
    try {
      tokens = readSignInAnswer(answer, { clientId: this.clientId, nonce, now: Date.now() });
    } catch (e) {
      log.error("Google's sign-in answer was refused", { error: e instanceof Error ? e.message : "unknown" });
      throw e;
    }
    const granted = tokens.scope.split(" ");
    const missing = this.requiredScopes.filter((s) => !granted.includes(s));
    // Never log the tokens.
    log.info("Signed in", { expiresAt: new Date(tokens.expiresAt).toISOString(), grantedScopes: granted, missingRequiredScopes: missing });
    if (missing.length) throw new Error("Google Health nutrition access was not granted. Sign in again and tick the nutrition permission.");
    this.token = { ...tokens, clientId: this.clientId };
    this.persist();
    this.rememberAccount(tokens.subject);
    this.scheduleExpiry();
    this.emit();
  }

  /**
   * Notifies listeners when the token stops counting as valid, so the UI shows
   * "Session expired" instead of a diary that silently stops refreshing.
   */
  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.isSignedIn || !this.token) return;
    const delay = this.token.expiresAt - EXPIRY_MARGIN_MS - Date.now();
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      log.info("Access token expired; asking the user to continue");
      this.emit();
    }, Math.max(0, delay) + 50);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // sessionStorage: survives reloads in this tab, gone when the tab closes.
  private restore(): StoredToken | undefined {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const t = raw ? (JSON.parse(raw) as StoredToken) : undefined;
      // One stored before the app asked for an ID token has none, so that user signs in again.
      return t && t.clientId === this.clientId && t.idToken ? t : undefined;
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    try {
      if (this.token) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.token));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage blocked: the token lives in memory only.
    }
  }

  private lastAccount(): string | undefined {
    if (this.token) return this.token.subject;
    try {
      return localStorage.getItem(ACCOUNT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private rememberAccount(subject: string): void {
    try {
      localStorage.setItem(ACCOUNT_KEY, subject);
    } catch {
      // Storage blocked: Google asks which account to use.
    }
  }

  private forgetAccount(): void {
    try {
      localStorage.removeItem(ACCOUNT_KEY);
    } catch {
      // Storage blocked: nothing was remembered.
    }
  }
}

/**
 * Best effort. Google documents this endpoint as having no CORS support, so the
 * response cannot be relied on, and the token expires within the hour anyway.
 */
async function revoke(accessToken: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    });
  } catch {
    log.warn("Could not reach Google to revoke the access token");
  }
}
