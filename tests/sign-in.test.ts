import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuth, SignInRequiredError, SignInSupersededError } from "../src/auth/google-auth";
import { readSignInAnswer, signInUrl } from "../src/auth/sign-in-answer";

const CLIENT = "client.apps.googleusercontent.com";
const NOW = 1_800_000_000_000;
const WRITE = "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly";
const READ = "https://www.googleapis.com/auth/googlehealth.nutrition.readonly";

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(claims: Record<string, unknown> = {}, nonce = "the-nonce"): string {
  const payload = { iss: "https://accounts.google.com", aud: CLIENT, sub: "1234", exp: NOW / 1000 + 3600, nonce, email: "someone@example.com", ...claims };
  return `${part({ alg: "RS256" })}.${part(payload)}.signature`;
}
const answer = (over: Record<string, string> = {}, claims?: Record<string, unknown>) => ({
  access_token: "ACCESS-SECRET",
  id_token: idToken(claims),
  expires_in: "3599",
  scope: `openid ${READ} ${WRITE}`,
  state: "s",
  ...over,
});
const read = (a: Record<string, string>) => readSignInAnswer(a, { clientId: CLIENT, nonce: "the-nonce", now: NOW });

describe("signInUrl", () => {
  const request = { clientId: CLIENT, redirectUri: "https://example.com/auth-callback.html", scopes: ["openid", WRITE], state: "s", nonce: "n" };

  it("asks for both tokens with every scope", () => {
    const params = new URL(signInUrl(request)).searchParams;
    expect(params.get("response_type")).toBe("token id_token");
    expect(params.get("scope")).toBe(`openid ${WRITE}`);
    expect(params.get("client_id")).toBe(CLIENT);
    expect(params.get("redirect_uri")).toBe(request.redirectUri);
    expect(params.get("state")).toBe("s");
    expect(params.get("nonce")).toBe("n");
  });

  it("leaves out a prompt and a hint it was not given", () => {
    const params = new URL(signInUrl(request)).searchParams;
    expect(params.has("prompt")).toBe(false);
    expect(params.has("login_hint")).toBe(false);
  });

  it("passes the account as a hint", () => {
    expect(new URL(signInUrl({ ...request, loginHint: "1234" })).searchParams.get("login_hint")).toBe("1234");
  });
});

describe("readSignInAnswer", () => {
  it("returns both tokens and the account", () => {
    expect(read(answer())).toMatchObject({ accessToken: "ACCESS-SECRET", subject: "1234", expiresAt: NOW + 3_599_000, scope: `openid ${READ} ${WRITE}` });
  });

  it("expires with whichever token expires first", () => {
    expect(read(answer({}, { exp: NOW / 1000 + 60 })).expiresAt).toBe(NOW + 60_000);
  });

  it("reads a token whose claims are not ASCII", () => {
    expect(read(answer({}, { name: "Χρήστος" })).subject).toBe("1234");
  });

  it.each([
    ["another app's token", { aud: "another-app" }],
    ["the wrong issuer", { iss: "https://example.com" }],
    ["the wrong nonce", { nonce: "other" }],
    ["no account", { sub: "" }],
    ["an expired token", { exp: NOW / 1000 - 1 }],
    ["no expiry", { exp: undefined }],
  ])("refuses %s", (_name, claims) => {
    expect(() => read(answer({}, claims))).toThrow("did not pass its checks");
  });

  it("says when the user refused", () => {
    expect(() => read({ error: "access_denied", state: "s" })).toThrow("cancelled");
  });

  it("names any other error from Google", () => {
    expect(() => read({ error: "server_error", state: "s" })).toThrow("server_error");
  });

  it.each([
    ["an access token", { access_token: "" }],
    ["an ID token", { id_token: "" }],
    ["a lifetime", { expires_in: "" }],
  ])("refuses an answer without %s", (_name, over) => {
    expect(() => read(answer(over))).toThrow("incomplete");
  });

  it("does not quote a token that cannot be read", () => {
    let message = "";
    try {
      read(answer({ id_token: "a.UNREADABLE-SECRET.c" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("could not be read");
    expect(message).not.toContain("SECRET");
  });
});

describe("GoogleAuth", () => {
  /** Enough of a browser for the popup and storage; each test's window is fresh. */
  function setUp(store: Map<string, string> = new Map(), session: Map<string, string> = new Map()) {
    const listeners = new Set<(e: unknown) => void>();
    const popup = { closed: false, close: vi.fn() };
    const open = vi.fn((_url: string) => popup as unknown);
    const fetchMock = vi.fn(async () => new Response(null));
    const storage = (m: Map<string, string>) => ({
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    });
    vi.stubGlobal("window", {
      open,
      addEventListener: (_t: string, l: (e: unknown) => void) => listeners.add(l),
      removeEventListener: (_t: string, l: (e: unknown) => void) => listeners.delete(l),
    });
    vi.stubGlobal("location", { href: "https://example.com/app/", origin: "https://example.com" });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("localStorage", storage(store));
    vi.stubGlobal("sessionStorage", storage(session));
    vi.stubGlobal("fetch", fetchMock);
    const opened = () => new URL(open.mock.calls.at(-1)![0]).searchParams;
    const send = (a: Record<string, string>, from: { origin?: string; source?: unknown } = {}) => {
      for (const l of [...listeners]) l({ origin: from.origin ?? "https://example.com", source: from.source ?? popup, data: { type: "google-sign-in", answer: a } });
    };
    const good = (over: Record<string, string> = {}) => {
      const { state, nonce } = Object.fromEntries(opened());
      return { ...answer(over), id_token: idToken({}, nonce), state: state! };
    };
    return { popup, open, fetchMock, send, good, opened, listeners, store, session };
  }
  const make = () => new GoogleAuth(CLIENT, ["openid", READ, WRITE], [WRITE]);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("signs in with both tokens, sends the callback as the redirect, and stops listening", async () => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    expect(b.open).toHaveBeenCalledOnce();
    expect(b.opened().get("redirect_uri")).toBe("https://example.com/app/auth-callback.html");
    b.send(b.good());
    await done;
    expect(auth.isSignedIn).toBe(true);
    await expect(auth.getAccessToken()).resolves.toBe("ACCESS-SECRET");
    expect(auth.getIdToken()).toContain(".");
    expect(auth.grantedScopes).toContain(WRITE);
    expect(b.listeners.size).toBe(0);
  });

  it("opens the popup before anything can wait, so the browser does not block it", () => {
    const b = setUp();
    void make().signIn().catch(() => undefined);
    expect(b.open).toHaveBeenCalledOnce();
  });

  it("uses a new state and nonce for every attempt", () => {
    const b = setUp();
    const auth = make();
    auth.signIn().catch(() => undefined);
    const first = Object.fromEntries(b.opened());
    auth.signIn().catch(() => undefined);
    const second = Object.fromEntries(b.opened());
    expect(second["state"]).not.toBe(first["state"]);
    expect(second["nonce"]).not.toBe(first["nonce"]);
  });

  it.each([
    ["another origin", { origin: "https://elsewhere.example" }],
    ["another window", { source: {} }],
  ])("ignores an answer from %s", async (_name, from) => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    b.send(b.good(), from);
    expect(auth.isSignedIn).toBe(false);
    b.send(b.good());
    await done;
    expect(auth.isSignedIn).toBe(true);
  });

  it("ignores an answer with the wrong state", async () => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    b.send({ ...b.good(), state: "forged" });
    expect(auth.isSignedIn).toBe(false);
    b.send(b.good());
    await done;
    expect(auth.isSignedIn).toBe(true);
  });

  it("refuses an answer without the required scope, but accepts one without the optional scope", async () => {
    const b = setUp();
    const auth = make();
    let done = auth.signIn();
    b.send(b.good({ scope: `openid ${READ}` }));
    await expect(done).rejects.toThrow("not granted");
    expect(auth.isSignedIn).toBe(false);
    done = auth.signIn();
    b.send(b.good({ scope: `openid ${WRITE}` }));
    await done;
    expect(auth.grantedScopes).not.toContain(READ);
  });

  it("says when the browser blocks the popup", async () => {
    const b = setUp();
    b.open.mockReturnValue(null);
    await expect(make().signIn()).rejects.toThrow("blocked");
  });

  it("says when offline, without opening a popup", async () => {
    const b = setUp();
    vi.stubGlobal("navigator", { onLine: false });
    await expect(make().signIn()).rejects.toThrow("offline");
    expect(b.open).not.toHaveBeenCalled();
  });

  it("says when the popup closes without an answer", async () => {
    const b = setUp();
    const done = make().signIn();
    const check = expect(done).rejects.toThrow("closed before finishing");
    b.popup.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await check;
    expect(b.listeners.size).toBe(0);
  });

  it("still accepts an answer that arrives just after the popup closes", async () => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    b.popup.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    b.send(b.good());
    await done;
    expect(auth.isSignedIn).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("replaces an earlier attempt", async () => {
    const b = setUp();
    const auth = make();
    const first = auth.signIn();
    const check = expect(first).rejects.toBeInstanceOf(SignInSupersededError);
    const second = auth.signIn();
    await check;
    b.send(b.good());
    await second;
    expect(auth.isSignedIn).toBe(true);
  });

  it("passes the account as a hint when renewing, and when the tab was closed", async () => {
    const b = setUp();
    const auth = make();
    const first = auth.signIn();
    expect(b.opened().has("login_hint")).toBe(false);
    b.send(b.good());
    await first;
    auth.signIn().catch(() => undefined);
    expect(b.opened().get("login_hint")).toBe("1234");
    auth.signOut();

    const later = setUp(new Map([["foodDiary.account", "1234"]]));
    make().signIn().catch(() => undefined);
    expect(later.opened().get("login_hint")).toBe("1234");
  });

  it("does not pass a hint when the user is choosing an account", async () => {
    const b = setUp(new Map([["foodDiary.account", "1234"]]));
    make().signIn("select_account").catch(() => undefined);
    expect(b.opened().has("login_hint")).toBe(false);
    expect(b.opened().get("prompt")).toBe("select_account");
  });

  it("restores a session across a reload", async () => {
    const b = setUp();
    const first = make();
    const done = first.signIn();
    b.send(b.good());
    await done;
    expect(make().isSignedIn).toBe(true);
  });

  it("does not restore a session stored before the app asked for an ID token", () => {
    const session = new Map([["foodDiary.token", JSON.stringify({ accessToken: "old", expiresAt: NOW + 3_000_000, scope: WRITE, clientId: CLIENT })]]);
    setUp(new Map(), session);
    const auth = make();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.hasExpiredSession).toBe(false);
  });

  it("asks to continue when the tokens expire", async () => {
    const b = setUp();
    const auth = make();
    const seen = vi.fn();
    auth.onChange(seen);
    const done = auth.signIn();
    b.send(b.good());
    await done;
    seen.mockClear();
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(seen).toHaveBeenCalled();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.hasExpiredSession).toBe(true);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(() => auth.getIdToken()).toThrow(SignInRequiredError);
  });

  it("signs out: forgets the tokens and the account, and revokes the access token", async () => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    b.send(b.good());
    await done;
    auth.signOut();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.hasExpiredSession).toBe(false);
    expect(b.session.has("foodDiary.token")).toBe(false);
    expect(b.store.has("foodDiary.account")).toBe(false);
    const [url, init] = b.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init.body)).toBe("token=ACCESS-SECRET");
  });

  it("signing out ends a sign-in under way", async () => {
    const b = setUp();
    const auth = make();
    const done = auth.signIn();
    auth.signOut();
    await expect(done).rejects.toThrow("Signed out");
    b.send(b.good());
    expect(auth.isSignedIn).toBe(false);
  });
});
