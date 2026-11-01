/**
 * Browser-only Google OAuth using Google Identity Services (token model).
 *
 * There is no backend, so there is no client secret and no refresh token: the
 * app gets an access token (about 1 hour) from a Google popup. When it
 * expires, the user clicks "Continue" and Google re-issues one, normally
 * without showing the consent screen again.
 */

import { logger } from "../debug/log";

const log = logger("auth");
const GIS_SRC = "https://accounts.google.com/gsi/client";
const STORAGE_KEY = "foodDiary.token";
/** Treat tokens as expired a little early so in-flight requests don't fail. */
const EXPIRY_MARGIN_MS = 60_000;

export class SignInRequiredError extends Error {
  override name = "SignInRequiredError";
  constructor(message = "Please sign in to Google to continue.") {
    super(message);
  }
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
  clientId: string;
}

let gisLoading: Promise<void> | undefined;

export function loadGoogleIdentityServices(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise<void>((resolve, reject) => {
    log.debug(`Loading Google Identity Services from ${GIS_SRC}`);
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => {
      log.info("Google Identity Services loaded");
      resolve();
    };
    s.onerror = () => {
      gisLoading = undefined;
      log.error(`Could not load ${GIS_SRC} (network error or blocked by an extension)`);
      reject(new Error("Could not load Google sign-in. Check your connection or content blockers."));
    };
    document.head.append(s);
  });
  return gisLoading;
}

export class GoogleAuth {
  private client?: google.accounts.oauth2.TokenClient;
  private token?: StoredToken;
  private pending?: { resolve: () => void; reject: (e: Error) => void };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly clientId: string,
    private readonly scopes: readonly string[],
    /** Scopes without which the app cannot work. */
    private readonly requiredScopes: readonly string[] = scopes,
  ) {
    this.token = this.restore();
    if (this.token) {
      log.info("Restored access token from this tab's session", {
        expiresAt: new Date(this.token.expiresAt).toISOString(),
        valid: this.isSignedIn,
        scopes: this.grantedScopes,
      });
    }
  }

  get isSignedIn(): boolean {
    return this.token !== undefined && this.token.expiresAt - EXPIRY_MARGIN_MS > Date.now();
  }

  /** True when there was a session that has since expired (show "Continue", not "Sign in"). */
  get hasExpiredSession(): boolean {
    return this.token !== undefined && !this.isSignedIn;
  }

  get grantedScopes(): string[] {
    return this.token?.scope.split(" ").filter(Boolean) ?? [];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Must run inside a user gesture (click), or the popup is blocked. */
  async signIn(prompt: "" | "consent" | "select_account" = ""): Promise<void> {
    await loadGoogleIdentityServices();
    if (!this.client) {
      log.info("Creating token client", { clientId: this.clientId, scopes: this.scopes, origin: location.origin });
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.scopes.join(" "),
        callback: (r) => this.handleToken(r),
        error_callback: (e) => {
          log.error(`Sign-in popup error: ${e.type}`, e);
          this.settle(new Error(popupErrorMessage(e.type)));
        },
      });
    }
    const done = new Promise<void>((resolve, reject) => {
      this.pending?.reject(new Error("Sign-in superseded by a new attempt."));
      this.pending = { resolve, reject };
    });
    log.info(`Requesting access token (prompt: "${prompt}")`);
    this.client.requestAccessToken({ prompt });
    return done;
  }

  /** Returns a valid access token, or throws SignInRequiredError (the UI then asks for a click). */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (opts.forceRefresh && this.token) {
      log.warn("Access token rejected by the API; marking it expired");
      this.token = { ...this.token, expiresAt: 0 };
      this.persist();
      this.emit();
    }
    if (!this.isSignedIn || !this.token) throw new SignInRequiredError();
    return this.token.accessToken;
  }

  signOut(): void {
    log.info("Signing out and revoking the access token");
    const t = this.token?.accessToken;
    this.token = undefined;
    this.persist();
    if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => undefined);
    this.emit();
  }

  private handleToken(r: google.accounts.oauth2.TokenResponse): void {
    if (r.error) {
      log.error(`Token response error: ${r.error}`, { error: r.error, description: r.error_description, uri: r.error_uri });
      this.settle(new Error(r.error_description || r.error));
      return;
    }
    const missing = this.requiredScopes.filter((s) => !google.accounts.oauth2.hasGrantedAllScopes(r, s));
    // Never log r.access_token.
    log.info("Access token received", {
      expiresInSeconds: Number(r.expires_in),
      grantedScopes: r.scope.split(" "),
      missingRequiredScopes: missing,
    });
    if (missing.length) {
      this.settle(new Error("Google Health nutrition access was not granted. Sign in again and tick the nutrition permission."));
      return;
    }
    this.token = {
      accessToken: r.access_token,
      expiresAt: Date.now() + Number(r.expires_in) * 1000,
      scope: r.scope,
      clientId: this.clientId,
    };
    this.persist();
    this.settle();
    this.emit();
  }

  private settle(error?: Error): void {
    const p = this.pending;
    this.pending = undefined;
    if (error) p?.reject(error);
    else p?.resolve();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // sessionStorage: survives reloads in this tab, gone when the tab closes.
  private restore(): StoredToken | undefined {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const t = raw ? (JSON.parse(raw) as StoredToken) : undefined;
      return t && t.clientId === this.clientId ? t : undefined;
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
}

function popupErrorMessage(type: string): string {
  switch (type) {
    case "popup_failed_to_open":
      return "The Google sign-in popup was blocked. Allow popups for this site and try again.";
    case "popup_closed":
      return "The Google sign-in window was closed before finishing.";
    default:
      return `Google sign-in failed (${type}).`;
  }
}
