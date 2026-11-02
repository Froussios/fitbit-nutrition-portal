import "./styles.css";
import { GoogleAuth, SignInRequiredError } from "./auth/google-auth";
import { getClientId, isClientIdBuiltIn, NUTRITION_READ_SCOPE, NUTRITION_WRITE_SCOPE, SCOPES, setClientId } from "./config";
import { idFromName, newEntryId } from "./core/ids";
import { civilDate } from "./core/time";
import type { BaseUnit } from "./core/units";
import type { FoodItem } from "./core/food";
import { LocalFoodCatalog, type FoodCatalog } from "./food/catalog";
import { SAMPLE_FOODS } from "./food/sample-foods";
import { HealthApiError, HealthClient } from "./health/client";
import { buildNutritionLogPoint, findServingUnits, toDiaryEntries, type DiaryEntry, type LogDraft } from "./health/mapping";
import type { DataPoint } from "./health/types";
import { renderDiaryTable } from "./ui/diary-table";
import { el, errorMessage, replaceChildren } from "./ui/dom";
import { createLogForm } from "./ui/log-form";
import { createDebugPanel } from "./ui/debug-panel";
import { describeError, installGlobalErrorHandlers, logger } from "./debug/log";

/** Refetch interval while the tab is visible: the client-only stand-in for webhook pushes. */
const POLL_MS = 5 * 60_000;

const root = document.getElementById("app")!;
const appLog = logger("app");
installGlobalErrorHandlers();

/** Session details the App adds to the debug log header (never tokens). */
let sessionInfo: () => Record<string, string> = () => ({});

/** Shown at the bottom of every screen while we debug the proof of concept. */
const debugPanel = createDebugPanel(() => ({
  app: `Food Diary (${import.meta.env.MODE} build)`,
  time: new Date().toString(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  origin: location.origin,
  clientId: getClientId() ?? "(none)",
  clientIdSource: isClientIdBuiltIn() ? "build (VITE_GOOGLE_CLIENT_ID)" : "setup screen (localStorage)",
  userAgent: navigator.userAgent,
  ...sessionInfo(),
}));

class App {
  private readonly auth: GoogleAuth;
  private readonly api: HealthClient;
  private servingUnits: Partial<Record<BaseUnit, string>> = {};
  private unitNames = new Map<string, string>();
  /** Points written this session that a list call has not returned yet (the API may lag). */
  private readonly pending = new Map<string, DataPoint>();
  private entries: DiaryEntry[] = [];
  private notice = "";
  private signInError = "";
  private loading = false;
  private listError = "";
  private ready = false;
  /** Why connecting to Google Health failed; shown with a Retry button instead of "Connecting…". */
  private connectError = "";

  private readonly form: HTMLElement;
  private readonly diary = el("div", { class: "diary" });
  private readonly diaryStatus = el("p", { class: "status", role: "status" });

  constructor(
    private readonly clientId: string,
    foods: readonly FoodItem[],
  ) {
    this.form = createLogForm(foods, (d) => this.log(d));
    // Logging needs the write scope; the read scope (whole diary) is asked for but optional.
    this.auth = new GoogleAuth(clientId, SCOPES, [NUTRITION_WRITE_SCOPE]);
    this.api = new HealthClient((o) => this.auth.getAccessToken(o));
    this.auth.onChange(() => this.render());
    sessionInfo = () => ({
      signedIn: String(this.auth.isSignedIn),
      grantedScopes: this.auth.grantedScopes.join(" ") || "(none)",
      servingUnits: JSON.stringify(this.servingUnits),
    });
    appLog.info("App started", { clientId, origin: location.origin, requestedScopes: SCOPES, restoredSession: this.auth.isSignedIn });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.auth.isSignedIn) void this.loadToday();
    });
    setInterval(() => {
      if (document.visibilityState === "visible" && this.auth.isSignedIn) void this.loadToday();
    }, POLL_MS);

    this.render();
    if (this.auth.isSignedIn) void this.afterSignIn();
  }

  private async signIn(prompt: "" | "consent" | "select_account" = "") {
    this.signInError = "";
    try {
      await this.auth.signIn(prompt);
      await this.afterSignIn();
    } catch (e) {
      appLog.error("Sign-in failed", describeError(e));
      this.signInError = errorMessage(e);
      this.render();
    }
  }

  private async afterSignIn() {
    this.notice = "";
    this.connectError = "";
    this.ready = false;
    this.render();
    appLog.info("Connecting: checking the Google Health identity");
    let healthUserId: string | undefined;
    try {
      const identity = await this.api.getIdentity();
      healthUserId = identity.healthUserId;
      appLog.info("Google Health account is linked", { healthUserId: healthUserId ?? "(not returned)" });
    } catch (e) {
      if (e instanceof SignInRequiredError) return this.handleError(e);
      appLog.error("Identity check failed; showing the connection error", describeError(e));
      this.connectError =
        e instanceof HealthApiError && e.accountNotLinked
          ? "Your Google account is not linked to Google Health yet. Open the Google Health app on your phone, sign in there once, then press Retry."
          : errorMessage(e);
      this.render();
      return;
    }
    if (!this.auth.grantedScopes.includes(NUTRITION_READ_SCOPE)) {
      appLog.warn("Read scope not granted; only this app's own entries will be listed", { granted: this.auth.grantedScopes });
      this.notice =
        "Read access to your nutrition diary was not granted, so only entries made by this app are shown. " +
        "Sign out and sign in again, and tick the permission to see your nutrition data, to see everything.";
    }
    this.ready = true;
    this.render();
    // The gram/ml units only matter for `serving`; find them without holding up the diary.
    void this.loadServingUnits(healthUserId);
    await this.loadToday();
  }

  /**
   * Finds the API's gram and millilitre `food-measurement-unit`s. The list is
   * Google's whole unit catalogue, so stop as soon as both are found and cache
   * them per Google Health user. Until then, entries put the amount in the name.
   */
  private async loadServingUnits(healthUserId: string | undefined) {
    const cacheKey = `foodDiary.servingUnits.${healthUserId ?? "me"}`;
    const cached = readJson<Partial<Record<BaseUnit, string>>>(cacheKey);
    if (cached?.g && cached.ml) {
      this.setServingUnits(cached);
      appLog.info("Gram and millilitre units loaded from cache", cached);
      return;
    }
    appLog.info("Looking up the gram and millilitre units in Google's unit catalogue");
    try {
      const units = await this.api.listFoodMeasurementUnits({
        maxPages: 20,
        stopWhen: (items) => {
          const found = findServingUnits(items);
          return Boolean(found.g && found.ml);
        },
      });
      const found = findServingUnits(units);
      this.setServingUnits(found);
      appLog.info(`Scanned ${units.length} food measurement units`, { gramAndMillilitre: found });
      if (found.g && found.ml) writeJson(cacheKey, found);
      else appLog.warn("Gram or millilitre unit not found; affected entries put the amount in the name instead of `serving`");
    } catch (e) {
      appLog.warn("food-measurement-unit list not available; logging without `serving`", describeError(e));
    }
  }

  private setServingUnits(units: Partial<Record<BaseUnit, string>>) {
    this.servingUnits = units;
    // Names for the servings of entries we just wrote (the API fills them in on its own entries).
    if (units.g) this.unitNames.set(units.g, "gram");
    if (units.ml) this.unitNames.set(units.ml, "milliliter");
  }

  private async loadToday() {
    if (this.loading) return;
    this.loading = true;
    this.listError = "";
    this.renderDiary();
    try {
      const today = civilDate(new Date());
      const points = await this.api.listNutritionLogs(today);
      for (const p of points) if (p.name) this.pending.delete(idFromName(p.name));
      const pending = [...this.pending.values()].filter((p) => civilDate(new Date(p.nutritionLog!.interval.startTime)) === today);
      this.entries = toDiaryEntries([...points, ...pending], { ownClientId: this.clientId, unitNames: this.unitNames });
      const unparsed = points.length - this.entries.length + pending.length;
      appLog.info(`Diary for ${today}: ${points.length} from the API, ${pending.length} pending`, {
        own: this.entries.filter((e) => e.own).length,
        others: this.entries.filter((e) => !e.own).map((e) => e.sourceLabel ?? "(unknown writer)"),
        ...(unparsed > 0 ? { skippedWithoutNutritionLog: unparsed } : {}),
      });
    } catch (e) {
      appLog.error("Loading the diary failed", describeError(e));
      this.listError = errorMessage(e);
      this.handleError(e, false);
    } finally {
      this.loading = false;
      this.renderDiary();
    }
  }

  private async log(draft: LogDraft) {
    const id = newEntryId(draft.food.ref);
    let point: DataPoint;
    try {
      point = buildNutritionLogPoint(draft, { id, servingUnits: this.servingUnits });
    } catch (e) {
      appLog.error("Could not build the entry", { food: draft.food.ref, quantity: draft.quantity, unit: draft.unit, error: describeError(e) });
      throw e;
    }
    appLog.info(`Logging ${draft.food.name}`, { id, quantity: draft.quantity, unit: draft.unit, mealType: draft.mealType });
    try {
      const op = await this.api.createNutritionLog(point);
      if (op.error) {
        appLog.error("Create returned an operation error", op.error);
        throw new Error(op.error.message ?? "Google Health rejected the entry.");
      }
      if (!op.done) appLog.warn("Create returned an operation that is not done yet", { name: op.name });
      this.pending.set(id, op.response?.nutritionLog ? { ...point, ...op.response } : point);
    } catch (e) {
      appLog.error("Logging the entry failed", describeError(e));
      this.handleError(e, false);
      throw e;
    }
    await this.loadToday();
  }

  private async remove(entry: DiaryEntry) {
    if (!confirm(`Delete "${entry.displayName}" from Google Health?`)) return;
    appLog.info(`Deleting ${entry.name}`);
    try {
      await this.api.deleteNutritionLogs([entry.name]);
      this.pending.delete(entry.id);
      this.entries = this.entries.filter((e) => e.id !== entry.id);
      this.renderDiary();
    } catch (e) {
      appLog.error("Deleting the entry failed", describeError(e));
      this.handleError(e);
    }
    await this.loadToday();
  }

  private handleError(e: unknown, rerender = true) {
    if (e instanceof SignInRequiredError) {
      appLog.warn("Access token missing or expired; asking the user to sign in again");
      this.ready = false;
      this.render();
      return;
    }
    if (rerender) {
      this.notice = errorMessage(e);
      this.render();
    }
  }

  private render() {
    const signedIn = this.auth.isSignedIn;
    const header = el(
      "header",
      { class: "top" },
      el("h1", {}, "Food Diary"),
      el(
        "div",
        { class: "account" },
        signedIn && el("button", { type: "button", onclick: () => this.auth.signOut() }, "Sign out"),
        !isClientIdBuiltIn() && el("button", { type: "button", class: "link", onclick: () => renderSetup(true) }, "Settings"),
      ),
    );

    if (!signedIn) {
      const expired = this.auth.hasExpiredSession;
      replaceChildren(
        root,
        header,
        el(
          "section",
          { class: "card signin" },
          el("h2", {}, expired ? "Session expired" : "Connect Google Health"),
          el(
            "p",
            {},
            expired
              ? "Google access tokens last about an hour. Continue to get a new one."
              : "Entries are stored in your Google Health account, not on any server of ours. Sign in and allow nutrition access.",
          ),
          el("button", { type: "button", class: "primary", onclick: () => void this.signIn() }, expired ? "Continue" : "Sign in with Google"),
          this.signInError && el("p", { class: "status error" }, this.signInError),
        ),
        debugPanel,
      );
      return;
    }

    replaceChildren(
      root,
      header,
      this.notice && el("p", { class: "notice" }, this.notice),
      this.ready ? this.form : this.connectError ? this.renderConnectError() : el("p", { class: "status" }, "Connecting to Google Health…"),
      this.ready &&
        el(
          "section",
          { class: "card" },
          el(
            "div",
            { class: "card-head" },
            el("h2", {}, "Today"),
            el("button", { type: "button", onclick: () => void this.loadToday() }, "Refresh"),
          ),
          this.diaryStatus,
          this.diary,
          el(
            "p",
            { class: "hint" },
            "Everything in your Google Health nutrition diary for today, whichever app logged it. " +
              "Only entries made by this app can be deleted here.",
          ),
        ),
      debugPanel,
    );
    this.renderDiary();
  }

  private renderConnectError(): HTMLElement {
    return el(
      "section",
      { class: "card" },
      el("h2", {}, "Could not connect to Google Health"),
      el("p", { class: "status error" }, this.connectError),
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", class: "primary", onclick: () => void this.afterSignIn() }, "Retry"),
        el("button", { type: "button", onclick: () => this.auth.signOut() }, "Sign out"),
      ),
      el("p", { class: "hint" }, "Details are in the Debug log below (Copy log to share it). Common causes are listed in issue #30."),
    );
  }

  private renderDiary() {
    this.diaryStatus.textContent = this.loading ? "Loading…" : this.listError;
    this.diaryStatus.classList.toggle("error", !this.loading && Boolean(this.listError));
    replaceChildren(
      this.diary,
      renderDiaryTable({ entries: this.entries, pendingIds: new Set(this.pending.keys()), onDelete: (e) => void this.remove(e) }),
    );
  }
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the units are looked up again next time.
  }
}

/**
 * Developer fallback when no client ID was built in (VITE_GOOGLE_CLIENT_ID).
 * End users never see this: a deployment ships with the app's client ID.
 */
function renderSetup(canCancel = false) {
  const clientId = el("input", {
    id: "client-id",
    type: "text",
    required: true,
    placeholder: "1234567890-abc.apps.googleusercontent.com",
    value: getClientId() ?? "",
    autocomplete: "off",
    spellcheck: "false",
  });
  const form = el(
    "form",
    { class: "card setup" },
    el("h2", {}, "Developer setup"),
    el(
      "p",
      {},
      "This build has no OAuth client ID. Set VITE_GOOGLE_CLIENT_ID at build time, or paste the app's Web client ID here for local testing. " +
        "This page's origin (",
      el("code", {}, location.origin),
      ") must be one of the client's Authorized JavaScript origins. See the README.",
    ),
    el("label", { class: "field", for: "client-id" }, el("span", {}, "OAuth client ID"), clientId),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      canCancel && el("button", { type: "button", onclick: () => location.reload() }, "Cancel"),
    ),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    setClientId(clientId.value);
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    location.reload();
  });
  appLog.info("No client ID built in; showing developer setup");
  replaceChildren(root, el("header", { class: "top" }, el("h1", {}, "Food Diary")), form, debugPanel);
}

const catalog: FoodCatalog = new LocalFoodCatalog(SAMPLE_FOODS);
const clientId = getClientId();
if (clientId) void catalog.search("").then((foods) => new App(clientId, foods));
else renderSetup();
