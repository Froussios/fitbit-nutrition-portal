import "./styles.css";
import { GoogleAuth, SignInRequiredError, SignInSupersededError } from "./auth/google-auth";
import { ACTIVITY_READ_SCOPE, getClientId, isClientIdBuiltIn, NUTRITION_READ_SCOPE, NUTRITION_WRITE_SCOPE, SCOPES, setClientId } from "./config";
import { canReload, foodLabel } from "./core/food";
import { copiedEntryId, entryStep, idFromName, newEntryId } from "./core/ids";
import { addCivilDays, civilDate, dayLabel, onCivilDate } from "./core/time";
import { userCountry } from "./core/countries";
import { dayFromUrl, urlWithDay } from "./core/day-url";
import type { BaseUnit } from "./core/units";
import { LocalFoodCatalog, type FoodCatalog } from "./food/catalog";
import { SAMPLE_FOODS } from "./food/sample-foods";
import { CombinedCatalog } from "./food/combined-catalog";
import genericsUrl from "./food/data/generics.json?url";
import { StaticFoodCatalog } from "./food/static-catalog";
import { HealthApiError, HealthClient } from "./health/client";
import { CONNECT_FAILED, ConnectionMonitor, DIARY_NOT_LOADED, LOG_NOT_CONFIRMED, actionRefused, connectionBanner, deleteFailed, editNotConfirmed, incrementNotConfirmed, oldEntryNotRemoved, repeatNotConfirmed, undoNotConfirmed, type ConnectionState } from "./health/connection";
import { LoggedFoodsCatalog } from "./food/logged-catalog";
import { buildNutritionLogPoint, buildPortionPoint, byTime, copyNutritionLogPoint, countedStep, incrementedNutritionLogPoint, stepAfterEdit, NUTRITION_LOG_PARENT, editedNutritionLogPoint, entryDay, findServingUnits, reconcilePending, repeatedNutritionLogPoint, toDiaryEntries, toDiaryEntry, toLoggedFoods, withoutEntries, type DiaryEntry, type DiaryContext, type EntryEdit, type LogDraft } from "./health/mapping";
import type { DataPoint } from "./health/types";
import { renderDiaryTable } from "./ui/diary-table";
import { renderDashboard } from "./ui/dashboard";
import { el, errorMessage, replaceChildren } from "./ui/dom";
import { getEnergyUnit, setEnergyUnit, type EnergyUnit } from "./ui/energy-unit";
import { createLogForm, type LogForm, type PrepOutcome } from "./ui/log-form";
import { createEntryCard, type EntryCard } from "./ui/entry-card";
import { amountAi } from "./ai/amount-ai";
import { createAiSetting } from "./ui/ai-setting";
import { createRowEditor, type RowEditor } from "./ui/row-editor";
import { createDebugPanel } from "./ui/debug-panel";
import { createSettingsMenu } from "./ui/settings-menu";
import { createDayPicker } from "./ui/day-picker";
import { batchProfile, isFinished, PORTION_SUFFIX, portionName, portionOfEntry, portionProfile, randomId, type PortionEntry, type Prep, type PrepIngredient, type PrepPortion } from "./core/prep";
import type { MealType } from "./health/types";
import { PrepApi, PrepApiError, PrepApiMissingError } from "./prep/api-client";
import { createPrepBuilder, type PrepBuilder, type PrepDraft } from "./ui/prep-builder";
import { createPrepCard, type PrepCard } from "./ui/prep-card";
import { createMealCard, type MealCard } from "./ui/meal-card";
import type { SavedMeal } from "./core/meal";
import { describeError, installGlobalErrorHandlers, logger } from "./debug/log";
import { DiaryReadError } from "./ai/chat-agent";
import { chatModel } from "./ai/chat-model";
import type { Proposal } from "./ai/chat-tools";
import { createChatPanel, type ApplyResult, type ChatPanel } from "./ui/chat-panel";

/** Refetch interval while the tab is visible: the client-only stand-in for webhook pushes. */
const POLL_MS = 5 * 60_000;
/** How long a written entry may stay unlisted before its pending row is dropped. */
const PENDING_TTL_MS = 10 * 60_000;
/** How many diary entries one request reads to find foods logged before (docs/FOOD_SEARCH.md section 14). */
const HISTORY_ENTRIES = 300;

const root = document.getElementById("app")!;
const appLog = logger("app");
installGlobalErrorHandlers();
void amountAi.start();

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
  /** The last lookup of the gram and millilitre units got no usable answer, so coming back online tries again. */
  private servingUnitsFailed = false;
  /** Points written this session that a list call has not returned yet (the API may lag). */
  private readonly pending = new Map<string, DataPoint>();
  /** When each pending point was written; ones the API never lists are dropped after PENDING_TTL_MS. */
  private readonly pendingSince = new Map<string, number>();
  private entries: DiaryEntry[] = [];
  /**
   * The day the diary shows (#19), as YYYY-MM-DD, from `?day=` in the page URL. Unset for today, which then follows the
   * clock past midnight. It survives signing in and out, so that a link to a day still shows that day after sign-in.
   */
  private viewedDay = dayFromUrl(location.href, civilDate(new Date()));
  /** The day `entries` were listed for. Until it is the viewed day, the table is not shown. */
  private loadedDay?: string;
  /** Entries deleted in this session, of any day, by ID: shown crossed out so the delete can be undone. Not stored (DR-20). */
  private readonly deleted = new Map<string, DiaryEntry>();
  /** Every ID deleted in this session. Undoing does not take one out: the API may still list the original, and the copy must not match it. */
  private readonly deletedIds = new Set<string>();
  /** The entries with a delete, undo or edit under way, by ID, so that a second tap sends nothing. The value is the row's tag. */
  private readonly busy = new Map<string, string>();
  private notice = "";
  private signInError = "";
  private loading = false;
  /** Set while reading recent entries for food search, and after. Unset if a read failed, or the user signed out. */
  private loggedFoodsRead?: object;
  /** The connection came back during a load that may have failed: load again when it ends. */
  private reloadAfterLoad = false;
  private listError = "";
  /** Why a delete, undo or edit failed, by entry ID. Kept until dismissed or tried again, so that a refresh does not hide it. */
  private readonly rowFailures = new Map<string, HTMLElement>();
  private ready = false;
  /** Why the account check failed; shown with a Retry button instead of the diary. */
  private connectError = "";
  /** The account check under way, or the last one. Unset on signing out, so that its answer is ignored. */
  private accountCheck?: object;

  private readonly prepApi: PrepApi;
  private readonly prepBuilder: PrepBuilder;
  private readonly prepCard: PrepCard;
  /** The log form, and the Meal prep and Saved meals tabs. */
  private readonly entryCard: EntryCard;
  private readonly mealBuilder: PrepBuilder;
  private readonly mealCard: MealCard;
  /** The user's saved meals, as the API last listed them. */
  private meals: SavedMeal[] = [];
  /** False once the site's API answers that it has no saved meals: the tab then stays hidden. */
  private mealsAvailable = true;
  private mealsLoading = false;
  /** A save or delete finished while a load was under way: load again, so the list shows it. */
  private mealsReload = false;
  private mealsError = "";
  /** Meals deleted in this session: shown with an undo until reload. */
  private mealsDeleted: SavedMeal[] = [];
  private readonly mealBusy = new Set<string>();
  private readonly mealMessages = new Map<string, { text: string; error: boolean }>();
  /** The user's meal preps (#55), as the API last listed them. */
  private preps: Prep[] = [];
  /** False once the site answers that it has no meal prep API: the card then stays hidden. */
  private prepAvailable = true;
  private prepLoading = false;
  /** A change finished while a load was under way: load again, so the list shows it. */
  private prepReload = false;
  private prepError = "";
  /** Whose preps these are, so that signing in as someone else starts afresh. */
  private prepUser?: string;
  /** Preps discarded in this session: shown with an undo until reload. */
  private readonly prepDiscarded = new Set<string>();
  private readonly prepBusy = new Set<string>();
  private readonly prepMessages = new Map<string, { text: string; error: boolean }>();
  /** Portions given back by deleting their diary entry in this session, by entry ID, so that an undo can take them again. */
  private readonly givenBack = new Map<string, { prepId: string; fraction: number }>();

  private readonly connection: ConnectionMonitor;
  /** Kept across renders, so a change in connection does not disturb what the user is typing. */
  private readonly connectionNotice = el("p", { class: "notice", role: "alert", hidden: true });
  private readonly form: LogForm;
  /** The diary row being edited. Its controls outlive redraws of the table, so a refresh keeps what the user typed. */
  private editor?: RowEditor;
  private readonly aiSetting = createAiSetting(amountAi);
  /** The chat on the right of the page (DR-41). Kept for the life of the page, outside the redrawn root. */
  private readonly chat: ChatPanel;
  /** The gear in the header and its panel of settings (DR-40). */
  private readonly settings = createSettingsMenu();
  /** Made on first use, then kept, so that a redraw never replaces the select while it is in use. */
  private energyControl?: HTMLElement;
  private clientIdLink?: HTMLElement;
  private readonly diary = el("div", { class: "diary" });
  /** The dashboard's charts (DR-38), redrawn with the diary. */
  private readonly dashboard = el("div");
  /** The entries of the 7 days ending on `weekDay`, for the dashboard. The viewed day's own come from `entries`. */
  private weekEntries: DiaryEntry[] = [];
  private weekDay?: string;
  private weekLoading = false;
  /** A week listing was asked for while one was under way: it runs again when that one ends. */
  private weekReload = false;
  private weekError = "";
  /** Counts sign-outs, so that a week listing started for one account is never kept for the next. */
  private weekSession = 0;
  /** Calories burnt (kcal by day) over the 7 days ending on `burntDay`, with the activity scope only (DR-46). */
  private burnt?: Map<string, number>;
  private burntDay?: string;
  private burntError = "";
  /** Counts requests for calories burnt: only the latest one's answer is kept. */
  private burntRequest = 0;
  private readonly dayHeading = el("h2", { "aria-live": "polite" });
  private readonly previousDayButton = el("button", { type: "button", class: "day-step", "aria-label": "Previous day", title: "Previous day", onclick: () => this.stepDay(-1) }, "←");
  private readonly nextDayButton = el("button", { type: "button", class: "day-step", "aria-label": "Next day", title: "Next day", onclick: () => this.stepDay(1) }, "→");
  private readonly todayButton = el("button", { type: "button", onclick: () => this.showDay(undefined) }, "Today");
  private readonly dayPicker = createDayPicker(
    () => ({ day: this.day(), today: civilDate(new Date()) }),
    (day) => this.showDay(day),
  );
  private readonly diaryStatus = el("p", { class: "status", role: "status" });
  /**
   * Says where an entry went after an edit moved it to another day, or that one was logged again for today while another
   * day is shown, with a button to that day. Cleared when the day changes.
   */
  private readonly movedNotice = el("p", { class: "status moved-notice", role: "status", hidden: true });
  private readonly rowFailureList = el("div");
  /** Kept across renders, and messages come and go one at a time, so that screen readers announce only what is new. */
  private readonly rowAlert = el(
    "div",
    { class: "notice row-alert", role: "alert", hidden: true },
    this.rowFailureList,
    el("button", { type: "button", onclick: () => this.clearRowFailures() }, "Dismiss"),
  );

  constructor(
    private readonly clientId: string,
    private readonly catalog: LoggedFoodsCatalog,
  ) {
    this.form = createLogForm(
      catalog,
      (d) => this.log(d),
      () => (this.viewedDay ? onCivilDate(this.viewedDay, new Date()) : new Date()),
      {
        eat: (prep, fraction, mealType, time) => this.eatPortion(prep, fraction, mealType, time),
        discard: (prep) => this.discardFromForm(prep),
      },
      (meal, ingredients, mealType, time) => this.logMeal(meal, ingredients, mealType, time),
    );
    this.prepBuilder = createPrepBuilder({
      catalog,
      kind: "prep",
      draftKey: (prepId) => (this.auth.subject ? `foodDiary.prepDraft.${this.auth.subject}.${prepId ?? "new"}` : undefined),
      onSave: (draft) => this.savePrep(draft),
      onClose: () => this.renderPreps(),
    });
    this.prepCard = createPrepCard(
      {
        onNew: () => {
          this.prepBuilder.open();
          this.renderPreps();
        },
        onEdit: (prep) => {
          this.prepBuilder.open(prep);
          this.renderPreps();
        },
        onLog: (prep) => {
          this.entryCard.show("log");
          this.form.choosePrep(prep);
        },
        onDiscard: (prep) => void this.discardPrep(prep, true),
        onRestore: (prep) => void this.discardPrep(prep, false),
        onRemovePortion: (prep, portion) => void this.removePortion(prep, portion),
      },
      this.prepBuilder.element,
    );
    this.mealBuilder = createPrepBuilder({
      catalog,
      kind: "meal",
      draftKey: (mealId) => (this.auth.subject ? `foodDiary.mealDraft.${this.auth.subject}.${mealId ?? "new"}` : undefined),
      onSave: (draft) => this.saveMeal(draft),
      onClose: () => this.renderMeals(),
      meals: () => this.meals,
    });
    this.mealCard = createMealCard(
      {
        onNew: () => {
          this.mealBuilder.open();
          this.renderMeals();
        },
        onEdit: (meal) => {
          this.mealBuilder.open(meal);
          this.renderMeals();
        },
        onLog: (meal) => {
          this.entryCard.show("log");
          this.form.chooseMeal(meal);
        },
        onDelete: (meal) => void this.deleteMeal(meal),
        onRestore: (meal) => void this.restoreMeal(meal),
      },
      this.mealBuilder.element,
    );
    this.entryCard = createEntryCard(this.form.element, this.prepCard.element, this.mealCard.element);
    this.chat = createChatPanel(chatModel, amountAi, {
      today: () => civilDate(new Date()),
      viewedDay: () => this.day(),
      entriesOn: (day, signal) => this.entriesOn(day, signal),
      catalog,
      energyUnit: () => getEnergyUnit(),
      servingUnits: () => this.servingUnits,
      diaryContext: () => this.diaryContext(),
      logTime: (day) => (day === civilDate(new Date()) ? new Date() : onCivilDate(day, new Date())),
      apply: (proposal) => this.applyFromChat(proposal),
    });
    document.body.append(this.chat.element);
    // The rows' chat buttons come and go with the model.
    let chatAvailable = this.chat.available;
    amountAi.onChange(() => {
      if (chatAvailable === this.chat.available) return;
      chatAvailable = this.chat.available;
      this.renderDiary();
    });
    // The ID token, never the access token: it proves who the user is and can't use the diary (DR-24).
    this.prepApi = new PrepApi(new URL("api/", FOOD_INDEX_URL).href, () => this.auth.getIdToken());
    // Logging needs the write scope; the read scope (whole diary) is asked for but optional.
    this.auth = new GoogleAuth(clientId, SCOPES, [NUTRITION_WRITE_SCOPE]);
    this.api = new HealthClient((o) => this.auth.getAccessToken(o));
    this.connection = new ConnectionMonitor(window, (state, previous) => this.connectionChanged(state, previous));
    this.api.onRequestDone = (answered) => this.connection.reportRequest(answered);
    window.addEventListener("online", () => this.reconnect());
    this.auth.onChange(() => this.render());
    sessionInfo = () => ({
      signedIn: String(this.auth.isSignedIn),
      grantedScopes: this.auth.grantedScopes.join(" ") || "(none)",
      servingUnits: JSON.stringify(this.servingUnits),
    });
    appLog.info("App started", { clientId, origin: location.origin, requestedScopes: SCOPES, restoredSession: this.auth.isSignedIn });

    document.addEventListener("visibilitychange", () => {
      if (this.shouldRefresh()) void this.loadDay();
    });
    setInterval(() => {
      if (this.shouldRefresh()) void this.loadDay();
    }, POLL_MS);

    // A link to today, a later day or no date at all shows today, and the URL says so.
    this.syncUrl();
    this.showConnection();
    this.render();
    if (this.auth.isSignedIn) void this.afterSignIn();
  }

  /** Background refreshes wait out a known outage; the online event triggers one when it ends. */
  private shouldRefresh(): boolean {
    return document.visibilityState === "visible" && this.auth.isSignedIn && this.connection.state !== "offline";
  }

  private connectionChanged(state: ConnectionState, previous: ConnectionState) {
    appLog.info(`Connection: ${previous} -> ${state}`);
    this.showConnection();
    if (state === "offline" || previous === "offline") this.renderDiary();
  }

  private showConnection() {
    const message = connectionBanner(this.connection.state);
    this.connectionNotice.textContent = message ?? "";
    this.connectionNotice.hidden = !message;
    this.form.setOffline(this.connection.state === "offline");
    this.prepBuilder?.setOffline(this.connection.state === "offline");
    this.mealBuilder?.setOffline(this.connection.state === "offline");
    if (this.entryCard) {
      this.renderPreps();
      this.renderMeals();
    }
    this.editor?.setOffline(this.connection.state === "offline");
  }

  /** The browser is back online: pick up what the outage interrupted. */
  private reconnect() {
    if (!this.auth.isSignedIn) return;
    if (!this.ready) {
      if (this.connectError) void this.afterSignIn();
      return;
    }
    if (this.loading) this.reloadAfterLoad = true;
    else void this.loadDay();
    void this.loadLoggedFoods();
    if (this.servingUnitsFailed) void this.loadServingUnits();
  }

  private async signIn(prompt: "" | "consent" | "select_account" = "") {
    this.signInError = "";
    try {
      await this.auth.signIn(prompt);
      await this.afterSignIn();
    } catch (e) {
      if (e instanceof SignInSupersededError) return;
      appLog.error("Sign-in failed", describeError(e));
      this.signInError = errorMessage(e);
      this.render();
    }
  }

  private async afterSignIn() {
    // The diary does not wait for the account check: each request to Google Health takes a second or more.
    // Only a retry of a failed check waits for it, so that the diary does not flash before the same error.
    const wait = this.connectError !== "";
    this.notice = "";
    this.connectError = "";
    this.ready = false;
    if (wait) this.render();
    const usable = this.checkAccount();
    if (wait && !(await usable)) return;
    if (!this.auth.grantedScopes.includes(NUTRITION_READ_SCOPE)) {
      appLog.warn("Read scope not granted; only this app's own entries will be listed", { granted: this.auth.grantedScopes });
      this.notice =
        "Read access to your nutrition diary was not granted, so only entries made by this app are shown. " +
        "Sign out and sign in again, and tick the permission to see your nutrition data, to see everything.";
    }
    this.ready = true;
    this.render();
    // The gram/ml units only matter for `serving`; find them without holding up the diary.
    void this.loadServingUnits();
    void this.loadLoggedFoods();
    if (this.prepUser !== this.auth.subject) {
      this.resetPreps();
      this.resetMeals();
      this.chat.reset();
    }
    this.prepUser = this.auth.subject;
    void this.loadPreps();
    void this.loadMeals();
    // A load from before the check failed may still be waiting for its answer.
    if (this.loading) this.reloadAfterLoad = true;
    else await this.loadDay();
  }

  /**
   * Asks Google Health whether the account can be used: one never signed in to the Google Health app is not linked.
   * False if it cannot, and the screen then says why instead of showing the diary. A diary already on screen
   * gives way only to an unlinked account: its own requests report an outage or any other refusal.
   */
  private async checkAccount(): Promise<boolean> {
    const check = (this.accountCheck = {});
    appLog.info("Checking the Google Health identity");
    try {
      const identity = await this.api.getIdentity();
      appLog.info("Google Health account is linked", { healthUserId: identity.healthUserId ?? "(not returned)" });
      // Signed out meanwhile, or a newer check has started: this answer is for neither.
      return this.accountCheck === check;
    } catch (e) {
      if (this.accountCheck !== check) return false;
      if (e instanceof SignInRequiredError) {
        this.handleError(e);
        return false;
      }
      const notLinked = e instanceof HealthApiError && e.accountNotLinked;
      if (this.ready && !notLinked) {
        appLog.warn("Identity check failed for a reason other than an unlinked account; the diary stays", describeError(e));
        return true;
      }
      appLog.error("Identity check failed; showing the connection error", describeError(e));
      this.connectError = notLinked
        ? "Your Google account is not linked to Google Health yet. Open the Google Health app on your phone, sign in there once, then press Retry."
        : isConnectionFailure(e)
          ? CONNECT_FAILED
          : errorMessage(e);
      this.ready = false;
      this.render();
      return false;
    }
  }

  /** Food search favours foods logged before. It must not depend on this, so failure only costs the boost. */
  private async loadLoggedFoods() {
    if (this.loggedFoodsRead) return;
    const read = (this.loggedFoodsRead = {});
    try {
      const points = await this.api.listOwnRecentNutritionLogs(HISTORY_ENTRIES);
      if (this.loggedFoodsRead !== read) return; // signed out meanwhile: these may be another account's
      const foods = toLoggedFoods(points, this.clientId);
      appLog.info(`Read ${points.length} recent entries for food search, ${foods.length} with a food to boost`);
      this.catalog.merge(foods);
    } catch (e) {
      if (this.loggedFoodsRead === read) this.loggedFoodsRead = undefined;
      appLog.warn("Could not read recent entries; food search will not favour foods logged before", describeError(e));
    }
  }

  /**
   * Finds the API's gram and millilitre `food-measurement-unit`s. The list is
   * Google's whole unit catalogue, so stop as soon as both are found and cache
   * them per Google account. Until then, entries put the amount in the name.
   */
  private async loadServingUnits() {
    this.servingUnitsFailed = false;
    const cacheKey = `foodDiary.servingUnits.${this.auth.subject ?? "me"}`;
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
      this.servingUnitsFailed = true;
      appLog.warn("food-measurement-unit list not available; logging without `serving`", describeError(e));
    }
  }

  private setServingUnits(units: Partial<Record<BaseUnit, string>>) {
    this.servingUnits = units;
    // Names for the servings of entries we just wrote (the API fills them in on its own entries).
    if (units.g) this.unitNames.set(units.g, "gram");
    if (units.ml) this.unitNames.set(units.ml, "milliliter");
  }

  /** The day the diary shows, as YYYY-MM-DD. */
  private day(): string {
    return this.viewedDay ?? civilDate(new Date());
  }

  /** Moves the diary `days` days back or forth. There is nothing to show after today, so it goes no further. */
  private stepDay(days: number) {
    this.showDay(addCivilDays(this.day(), days));
  }

  /** Shows `day` (YYYY-MM-DD), or today when it is undefined or not in the past, and puts it in the URL. */
  private showDay(day: string | undefined) {
    const today = civilDate(new Date());
    this.viewedDay = day !== undefined && day < today ? day : undefined;
    this.syncUrl();
    this.stopEditing();
    this.clearMoved();
    this.entries = [];
    this.loadedDay = undefined;
    this.listError = "";
    this.weekError = "";
    this.form.refreshTime();
    const hadFocus = document.activeElement === this.nextDayButton || document.activeElement === this.todayButton;
    this.renderDiary();
    // On reaching today, Next is disabled and Today hidden, which takes keyboard focus from them.
    if (hadFocus && this.viewedDay === undefined) this.previousDayButton.focus();
    if (this.loading) this.reloadAfterLoad = true;
    else void this.loadDay();
  }

  /** Puts the viewed day in the page URL, or takes it out for today. Replaced, not pushed: stepping through days adds no history. */
  private syncUrl() {
    const url = urlWithDay(location.href, this.viewedDay);
    if (url !== location.href) history.replaceState(history.state, "", url);
  }

  private async loadDay() {
    if (this.loading) return;
    this.loading = true;
    this.listError = "";
    this.renderDiary();
    const day = this.day();
    try {
      // Read after the wait: an entry deleted meanwhile may be in this listing, and must not come back.
      const points = withoutEntries(await this.api.listNutritionLogs(day), this.deletedIds);
      // The user moved to another day meanwhile: this listing is not for it, and the next load is.
      if (day !== this.day()) return;
      const matched = reconcilePending(this.pending, points, this.clientId);
      for (const key of [...matched.listedById, ...matched.listedByContent]) this.dropPending(key);
      // Only this day's listing can show an entry, so ones written for another day wait until it is viewed
      // (if it never is, they stay pending for the session, which only costs memory).
      const onDay = (key: string) => {
        const interval = this.pending.get(key)?.nutritionLog?.interval;
        return interval !== undefined && entryDay(interval) === day;
      };
      const stale = matched.stillPending.filter((key) => onDay(key) && Date.now() - (this.pendingSince.get(key) ?? 0) > PENDING_TTL_MS);
      if (stale.length) {
        appLog.warn("Dropping entries the API has not listed for 10 minutes (deleted elsewhere, or stored differently)", stale);
        for (const key of stale) this.dropPending(key);
      }
      if (matched.listedByContent.length) {
        appLog.warn("The API listed new entries under different IDs than this app sent; matched them by content", matched.listedByContent);
      }
      const waiting = matched.stillPending.filter((key) => this.pending.has(key));
      if (waiting.length) appLog.info("Entries written but not listed by the API yet", waiting);
      // An edit's old entry leaves the diary before its delete is answered, and may be one written this session.
      const pending = withoutEntries([...this.pending.values()], this.deletedIds).filter((p) => entryDay(p.nutritionLog!.interval) === day);
      this.entries = toDiaryEntries([...points, ...pending], this.diaryContext());
      this.loadedDay = day;
      const listed = new Set([...points.flatMap((p) => (p.name ? [idFromName(p.name)] : [])), ...this.pending.keys()]);
      void this.loadPreps().then(() => this.confirmListed(listed));
      void this.loadWeek();
      // Deleted in another app, or the day has changed: there is no row left to edit.
      if (this.editor && !this.entries.some((e) => e.id === this.editor?.id)) this.stopEditing();
      const unparsed = points.length - this.entries.length + pending.length;
      appLog.info(`Diary for ${day}: ${points.length} from the API, ${pending.length} pending`, {
        own: this.entries.filter((e) => e.own).length,
        others: this.entries.filter((e) => !e.own).map((e) => e.sourceLabel ?? "(unknown writer)"),
        ...(unparsed > 0 ? { skippedWithoutNutritionLog: unparsed } : {}),
      });
    } catch (e) {
      appLog.error("Loading the diary failed", describeError(e));
      if (day === this.day()) this.listError = isConnectionFailure(e) ? DIARY_NOT_LOADED : errorMessage(e);
      this.handleError(e, false);
    } finally {
      this.loading = false;
      if (day !== this.day()) this.reloadAfterLoad = true;
      this.renderDiary();
      if (this.reloadAfterLoad) {
        this.reloadAfterLoad = false;
        if (this.auth.isSignedIn) void this.loadDay();
      }
    }
  }

  /**
   * Lists the 7 days ending on the viewed day, in one request, for the dashboard (DR-38). Entries written this session
   * and not listed yet count on their day; deleted ones don't. A failure leaves the diary as it is and only the
   * dashboard's week says so.
   */
  private async loadWeek() {
    if (this.weekLoading) {
      this.weekReload = true;
      return;
    }
    // Once per week listing: a coalesced reload asks when it runs.
    void this.loadBurnt();
    this.weekLoading = true;
    const day = this.day();
    const first = addCivilDays(day, -6);
    const session = this.weekSession;
    try {
      const points = withoutEntries(await this.api.listNutritionLogsBetween(first, day), this.deletedIds);
      // Signed out meanwhile, or moved to another day: this listing is for neither.
      if (session !== this.weekSession || day !== this.day()) return;
      const { stillPending } = reconcilePending(this.pending, points, this.clientId);
      const pending = withoutEntries(
        stillPending.flatMap((key) => {
          const point = this.pending.get(key);
          return point ? [point] : [];
        }),
        this.deletedIds,
      ).filter((p) => {
        const start = entryDay(p.nutritionLog!.interval);
        return start >= first && start <= day;
      });
      this.weekEntries = toDiaryEntries([...points, ...pending], this.diaryContext());
      this.weekDay = day;
      this.weekError = "";
    } catch (e) {
      appLog.error("Loading the week for the dashboard failed", describeError(e));
      if (session === this.weekSession && day === this.day()) this.weekError = isConnectionFailure(e) ? "The week could not be loaded. Check your connection and refresh." : errorMessage(e);
    } finally {
      this.weekLoading = false;
      this.renderDashboard();
      if (this.weekReload || (session === this.weekSession && day !== this.day())) {
        this.weekReload = false;
        if (this.auth.isSignedIn) void this.loadWeek();
      }
    }
  }

  /** Whether the user let the app read activity data, which holds the calories burnt. Optional: unticked, the dashboard leaves them out. */
  private get canReadActivity(): boolean {
    return this.auth.grantedScopes.includes(ACTIVITY_READ_SCOPE);
  }

  /**
   * Rolls up the calories burnt over the 7 days ending on the viewed day, for the dashboard (DR-46); today's up to now.
   * Runs with each week listing, so polling keeps today's figure growing. Nothing is asked without the activity scope.
   */
  private async loadBurnt() {
    const request = ++this.burntRequest;
    if (!this.canReadActivity) {
      this.burnt = undefined;
      this.burntDay = undefined;
      this.burntError = "";
      return;
    }
    const day = this.day();
    const now = new Date();
    try {
      const burnt = await this.api.dailyCaloriesBurnt(addCivilDays(day, -6), day, day === civilDate(now) ? now : undefined);
      if (request !== this.burntRequest) return;
      this.burnt = burnt;
      this.burntDay = day;
      this.burntError = "";
    } catch (e) {
      if (request !== this.burntRequest) return;
      // The page already asks the user to sign in again; a note here would only repeat it.
      if (e instanceof SignInRequiredError) return;
      appLog.error("Loading the calories burnt for the dashboard failed", describeError(e));
      // A figure from before stays if it is for this day; the note says it may be out of date.
      if (this.burntDay !== day) this.burnt = undefined;
      this.burntError = "Calories burnt could not be loaded" + (this.burntDay === day ? "; the figures shown may be out of date." : ".");
    } finally {
      if (request === this.burntRequest) this.renderDashboard();
    }
  }

  private async log(draft: LogDraft) {
    // A portion or household measure is recorded in the ID, so that + adds one more of it (DR-37).
    const id = newEntryId(draft.food.ref, undefined, undefined, countedStep(draft.food, draft.unit));
    let point: DataPoint;
    try {
      point = buildNutritionLogPoint(draft, { id, servingUnits: this.servingUnits });
    } catch (e) {
      appLog.error("Could not build the entry", { food: draft.food.ref, quantity: draft.quantity, unit: draft.unit, error: describeError(e) });
      throw e;
    }
    appLog.info(`Logging ${draft.food.name}`, { id, quantity: draft.quantity, unit: draft.unit, mealType: draft.mealType });
    try {
      const { key } = await this.write(point);
      if (canReload(draft.food.ref.source)) {
        this.catalog.add({ id: key, ref: draft.food.ref, label: foodLabel(draft.food), at: draft.time.getTime() }, draft.food);
      }
    } catch (e) {
      appLog.error("Logging the entry failed", describeError(e));
      this.handleError(e, false);
      throw isConnectionFailure(e) ? new Error(LOG_NOT_CONFIRMED, { cause: e }) : e;
    }
    await this.loadDay();
  }

  /** Sends a new entry and shows it as pending until a listing returns it. */
  private async write(point: DataPoint): Promise<{ key: string; created: DataPoint }> {
    const op = await this.api.createNutritionLog(point);
    if (op.error) {
      appLog.error("Create returned an operation error", op.error);
      throw new Error(op.error.message ?? "Google Health rejected the entry.");
    }
    if (!op.done) appLog.warn("Create returned an operation that is not done yet", { name: op.name });
    const created: DataPoint = op.response?.nutritionLog ? { ...point, ...op.response } : point;
    if (created.name && idFromName(created.name) !== idFromName(point.name!)) {
      appLog.warn("The API stored the entry under its own ID, not the one this app sent", { sent: point.name, stored: created.name });
    }
    // Key by the stored ID so the next listing replaces the pending row.
    const key = idFromName(created.name ?? point.name!);
    this.pending.set(key, created);
    this.pendingSince.set(key, Date.now());
    return { key, created };
  }

  /**
   * Deletes an entry. Resolves to why it failed, or undefined when it was deleted. `fromChat`: the chat's card says why
   * it failed, so the diary only says so too when the row is on the day shown.
   */
  private async remove(entry: DiaryEntry, fromChat = false): Promise<string | undefined> {
    if (this.busy.has(entry.id)) return `${entry.displayName} is busy. Try again in a moment.`;
    // Disabling the button takes keyboard focus from it, so it is given back at the end.
    const hadFocus = focusedEntryId() === entry.id;
    this.startRowAction(entry, "deleting…");
    appLog.info(`Deleting ${entry.name}`);
    let failure: string | undefined;
    try {
      const op = await this.api.deleteNutritionLogs([entry.name]);
      if (op.error) {
        appLog.error("Delete returned an operation error", op.error);
        throw new Error(op.error.message ?? "Google Health could not delete the entry.");
      }
      this.dropPending(entry.id);
      this.catalog.remove(entry.id);
      this.entries = this.entries.filter((e) => e.id !== entry.id);
      this.deleted.set(entry.id, entry);
      this.deletedIds.add(entry.id);
      await this.giveBackDeleted(entry);
    } catch (e) {
      appLog.error("Deleting the entry failed", describeError(e));
      this.handleError(e, false);
      failure = isConnectionFailure(e) ? deleteFailed(entry.displayName) : actionRefused("delete", entry.displayName, refusalReason(e));
      this.showRowFailure(entry, failure, fromChat);
    }
    this.busy.delete(entry.id);
    this.renderDiary(hadFocus ? entry.id : undefined);
    await this.loadDay();
    return failure;
  }

  /** Undoes a delete by logging an equivalent entry. The original is gone, so the copy has its own ID. */
  private async undoDelete(entry: DiaryEntry) {
    const log = entry.point.nutritionLog;
    if (this.busy.has(entry.id) || !log) return;
    const hadFocus = focusedEntryId() === entry.id;
    this.startRowAction(entry, "deleting…");
    const point = copyNutritionLogPoint(log, copiedEntryId(entry.id));
    appLog.info(`Undoing the delete of ${entry.name}`, { copy: point.name });
    // The copy has no name for its unit until the API lists it, but the original did.
    if (log.serving?.foodMeasurementUnitDisplayName) this.unitNames.set(log.serving.foodMeasurementUnit, log.serving.foodMeasurementUnitDisplayName);
    let focusId = hadFocus ? entry.id : undefined;
    let retaken: string | undefined;
    try {
      retaken = await this.retakePortion(entry, idFromName(point.name!));
      const { key, created } = await this.write(point);
      if (retaken) {
        this.givenBack.delete(entry.id);
        await this.confirmPortion(retaken, key);
      }
      this.deleted.delete(entry.id);
      this.catalog.merge(toLoggedFoods([created], this.clientId));
      const restored = toDiaryEntry(created, this.diaryContext());
      if (restored) this.entries = [...this.entries, restored].sort(byTime);
      if (hadFocus) focusId = key;
    } catch (e) {
      appLog.error("Undoing the delete failed", describeError(e));
      this.handleError(e, false);
      // Google refused the copy, so the portion it would have been goes back too. A lost answer leaves it, unconfirmed.
      if (retaken && !isConnectionFailure(e) && !(e instanceof PrepApiError)) await this.prepApi.remove(retaken).catch(() => undefined);
      this.showRowFailure(
        entry,
        isConnectionFailure(e)
          ? undoNotConfirmed(entry.displayName)
          : e instanceof PrepApiError && e.connectionFailed
            ? `The meal prep service did not answer, so "${entry.displayName}" was not logged again. Its portion may have been taken: check the prep's list before trying again.`
            : actionRefused("undo deleting", entry.displayName, refusalReason(e)),
      );
    }
    this.busy.delete(entry.id);
    this.renderDiary(focusId);
    await this.loadDay();
  }

  /**
   * Logs the same food, amount, meal and nutrients as `entry` again, today at the current time (DR-36), whichever day
   * and app `entry` is from. The entry itself is left as it is.
   */
  private async repeatToday(entry: DiaryEntry) {
    const log = entry.point.nutritionLog;
    if (this.busy.has(entry.id) || !log) return;
    const hadFocus = focusedRepeatId() === entry.id;
    this.startRowAction(entry, "logging again…");
    const point = repeatedNutritionLogPoint(log, copiedEntryId(entry.id), new Date());
    appLog.info(`Logging ${entry.name} again for today`, { copy: point.name, mealType: log.mealType });
    // The copy has no name for its unit until the API lists it, but the original did.
    if (log.serving?.foodMeasurementUnitDisplayName) this.unitNames.set(log.serving.foodMeasurementUnit, log.serving.foodMeasurementUnitDisplayName);
    try {
      const { created } = await this.write(point);
      this.catalog.merge(toLoggedFoods([created], this.clientId));
      const copy = toDiaryEntry(created, this.diaryContext());
      if (copy && copy.day === this.day()) this.entries = [...this.entries, copy].sort(byTime);
      else if (copy) this.showOnOtherDay(`Logged ${entry.displayName} again for today.`, copy.day);
    } catch (e) {
      appLog.error("Logging the entry again failed", describeError(e));
      this.handleError(e, false);
      this.showRowFailure(entry, isConnectionFailure(e) ? repeatNotConfirmed(entry.displayName) : actionRefused("log again", entry.displayName, refusalReason(e)));
    }
    this.busy.delete(entry.id);
    this.renderDiary(undefined, undefined, hadFocus ? entry.id : undefined);
    await this.loadDay();
  }

  /**
   * Adds the entry's step to its amount (DR-37): a corrected copy, then a delete of the original, as an edit does (DR-22).
   * The copy records the step, so that an entry that steps by its amount as logged keeps adding that much.
   */
  private async increment(entry: DiaryEntry) {
    const log = entry.point.nutritionLog;
    const step = entry.increment;
    if (this.busy.has(entry.id) || !log || !step) return;
    const hadFocus = focusedIncrementId() === entry.id;
    let point: DataPoint;
    try {
      point = incrementedNutritionLogPoint(log, step.amount, { id: copiedEntryId(entry.id, undefined, undefined, step.amount), servingUnits: this.servingUnits, unitNames: this.unitNames });
    } catch (e) {
      appLog.error("Could not build the larger entry", describeError(e));
      this.showRowFailure(entry, actionRefused("add to", entry.displayName, errorMessage(e)));
      return;
    }
    this.startRowAction(entry, "adding…");
    appLog.info(`Adding ${step.amount} ${step.unit} to ${entry.name}`, { replacement: point.name });
    // The replacement has no name for its unit until the API lists it, but the original did.
    if (log.serving?.foodMeasurementUnitDisplayName) this.unitNames.set(log.serving.foodMeasurementUnit, log.serving.foodMeasurementUnitDisplayName);
    let written: { key: string; created: DataPoint };
    try {
      written = await this.write(point);
    } catch (e) {
      appLog.error("Adding to the entry failed", describeError(e));
      this.handleError(e, false);
      this.busy.delete(entry.id);
      this.showRowFailure(entry, isConnectionFailure(e) ? incrementNotConfirmed(entry.displayName) : actionRefused("add to", entry.displayName, refusalReason(e)));
      this.renderDiary(undefined, undefined, undefined, hadFocus ? entry.id : undefined);
      return;
    }
    const { key, created } = written;
    // No wait since the write: a listing that still has the original must not match the replacement to it.
    this.deletedIds.add(entry.id);
    this.catalog.merge(toLoggedFoods([created], this.clientId));
    const replacement = toDiaryEntry(created, this.diaryContext());
    const here = replacement && replacement.day === this.day() ? replacement : undefined;
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), ...(here ? [here] : [])].sort(byTime);
    this.renderDiary(undefined, undefined, undefined, hadFocus ? key : undefined);
    void this.removeReplaced(entry);
  }

  /** Turns a row into its editor. */
  private startEditing(entry: DiaryEntry) {
    if (this.editor) return;
    this.editor = createRowEditor({
      catalog: this.catalog,
      entry,
      unitNames: this.unitNames,
      offline: this.connection.state === "offline",
      onSave: (edit) => void this.saveEdit(entry, edit),
      onCancel: (how) => {
        this.stopEditing();
        // After Cancel or Escape the focus moves to the row's Edit button. After a click outside the row it stays where
        // the user put it, such as the food search or another row's Delete.
        if (how === "cancel") this.renderDiary(undefined, entry.id);
        else this.renderDiary();
      },
    });
    this.renderDiary();
    this.editor.focus();
  }

  private stopEditing() {
    this.editor?.dispose();
    this.editor = undefined;
  }

  /**
   * Applies an edit: writes the corrected entry, then deletes the original, so that a failure can
   * never lose the entry (DR-22). If nothing was saved, the row stays open with what the user typed.
   * Resolves to why the edit failed, or undefined when it was saved. `fromChat` as for `remove`.
   */
  private async saveEdit(entry: DiaryEntry, edit: EntryEdit, fromChat = false): Promise<string | undefined> {
    const log = entry.point.nutritionLog;
    if (this.busy.has(entry.id)) return `${entry.displayName} is busy. Try again in a moment.`;
    if (!log) return `${entry.displayName} has nothing to edit.`;
    let point: DataPoint;
    try {
      const step = stepAfterEdit(log, edit.amount, entryStep(entry.id), this.unitNames);
      point = editedNutritionLogPoint(log, edit, { id: copiedEntryId(entry.id, undefined, undefined, step), servingUnits: this.servingUnits, unitNames: this.unitNames });
    } catch (e) {
      appLog.error("Could not build the edited entry", describeError(e));
      const failure = actionRefused("edit", entry.displayName, errorMessage(e));
      this.showRowFailure(entry, failure, fromChat);
      return failure;
    }
    this.startRowAction(entry, "saving…");
    // The row can leave the diary during the write, and another row can be opened: the answer is only for this one's editor.
    // An edit from the chat has none, and must leave alone the editor of any other row.
    const editor = this.editor?.id === entry.id ? this.editor : undefined;
    editor?.setSaving(true);
    const stillEditing = () => editor !== undefined && this.editor === editor;
    appLog.info(`Editing ${entry.name}`, { replacement: point.name, mealType: edit.mealType, quantity: edit.amount?.quantity, unit: edit.amount?.unit, fromFoodRecord: Boolean(edit.amount?.food), day: edit.day });
    // The replacement has no name for its unit until the API lists it, but the original did.
    if (log.serving?.foodMeasurementUnitDisplayName) this.unitNames.set(log.serving.foodMeasurementUnit, log.serving.foodMeasurementUnitDisplayName);
    let written: { key: string; created: DataPoint };
    try {
      written = await this.write(point);
    } catch (e) {
      appLog.error("Saving the edit failed", describeError(e));
      this.handleError(e, false);
      this.busy.delete(entry.id);
      const failure = isConnectionFailure(e) ? editNotConfirmed(entry.displayName) : actionRefused("edit", entry.displayName, refusalReason(e));
      this.showRowFailure(entry, failure, fromChat);
      if (stillEditing()) editor?.setSaving(false);
      this.renderDiary();
      if (stillEditing()) editor?.focusSave();
      return failure;
    }
    const { key, created } = written;
    // No wait since the write: a listing that still has the original must not match the replacement to it (a meal-only edit looks the same).
    this.deletedIds.add(entry.id);
    this.catalog.merge(toLoggedFoods([created], this.clientId));
    const replacement = toDiaryEntry(created, this.diaryContext());
    // Moved to another day, it leaves this one: the listing for that day shows it, pending until the API does.
    const here = replacement && replacement.day === this.day() ? replacement : undefined;
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), ...(here ? [here] : [])].sort(byTime);
    // Only an entry that was on the day shown has moved away from it: the chat can edit entries on other days.
    if (replacement && !here && entry.day === this.day()) this.showMoved(entry.displayName, replacement.day);
    if (stillEditing()) {
      this.stopEditing();
      this.renderDiary(undefined, key);
      // The row has gone, so the focus goes to the way to follow it.
      if (!here) this.movedNotice.querySelector("button")?.focus();
    } else {
      this.renderDiary();
    }
    void this.removeReplaced(entry);
    return undefined;
  }

  // Chat (DR-41) ----------------------------------------------------------------------------------

  /**
   * A day's entries as the diary would show them, read afresh for the chat: listed ones, with this session's deletes
   * left out and its writes the API has not listed yet put in.
   */
  private async entriesOn(day: string, signal: AbortSignal): Promise<DiaryEntry[]> {
    let points: DataPoint[];
    try {
      points = withoutEntries(await this.api.listNutritionLogs(day), this.deletedIds);
    } catch (e) {
      appLog.warn("The chat could not read the diary", { day, error: describeError(e) });
      this.handleError(e, false);
      if (e instanceof SignInRequiredError) throw new DiaryReadError("Your session has expired. Sign in again, then ask again.", { cause: e });
      if (isConnectionFailure(e)) throw new DiaryReadError("Google Health did not answer, so the diary could not be read. Check your connection, then ask again.", { cause: e });
      throw new DiaryReadError(`The diary could not be read: ${errorMessage(e)}`, { cause: e });
    }
    signal.throwIfAborted();
    const { stillPending } = reconcilePending(this.pending, points, this.clientId);
    const pending = withoutEntries(
      stillPending.flatMap((key) => this.pending.get(key) ?? []),
      this.deletedIds,
    ).filter((p) => entryDay(p.nutritionLog!.interval) === day);
    return toDiaryEntries([...points, ...pending], this.diaryContext());
  }

  /**
   * The entry as it is in the diary now, or why the proposal no longer fits it. The chat read it a while ago, and it
   * may since have been changed or deleted, here or in another app.
   */
  private async currentEntry(entry: DiaryEntry): Promise<DiaryEntry | string> {
    const now = (await this.entriesOn(entry.day, new AbortController().signal)).find((e) => e.id === entry.id);
    if (!now) return `${entry.displayName} is no longer in the diary, so nothing was changed. It may have been changed or deleted since.`;
    const same = now.displayName === entry.displayName && now.amount === entry.amount && now.mealType === entry.mealType && now.start.getTime() === entry.start.getTime() && now.profile.energyKcal === entry.profile.energyKcal;
    return same ? now : `${entry.displayName} has changed since the chat read it, so nothing was changed. Ask again.`;
  }

  /** Writes a change the user accepted in the chat, the same way as the diary's own buttons. Never rejects. */
  private async applyFromChat(proposal: Proposal): Promise<ApplyResult> {
    // No queue (DR-18): offline, nothing is sent.
    if (this.connection.state === "offline") return { ok: false, message: "The browser is offline, so nothing was changed." };
    try {
      switch (proposal.kind) {
        case "log": {
          await this.log(proposal.draft);
          const day = proposal.preview.day;
          if (day !== this.day()) this.showOnOtherDay(`Logged ${proposal.preview.displayName} on ${dayInWords(day)}.`, day);
          return { ok: true, message: `Logged ${proposal.preview.displayName} for ${dayInWords(day)}.` };
        }
        case "edit": {
          const current = await this.currentEntry(proposal.entry);
          if (typeof current === "string") return { ok: false, message: current, stale: true };
          const failure = await this.saveEdit(current, proposal.edit, true);
          return failure ? { ok: false, message: failure } : { ok: true, message: `Changed ${current.displayName}.` };
        }
        case "delete": {
          const current = await this.currentEntry(proposal.entry);
          if (typeof current === "string") return { ok: false, message: current, stale: true };
          const failure = await this.remove(current, true);
          return failure ? { ok: false, message: failure } : { ok: true, message: `Deleted ${current.displayName}. Until the page is reloaded, the diary for ${dayInWords(current.day)} shows it crossed out, with an undo.` };
        }
      }
    } catch (e) {
      appLog.error("A change accepted in the chat failed", describeError(e));
      return { ok: false, message: e instanceof SignInRequiredError ? refusalReason(e) : errorMessage(e) };
    }
  }

  /** Says that `name` is now on `day`, with a button that shows that day. */
  private showMoved(name: string, day: string) {
    const on = dayInWords(day);
    this.showOnOtherDay(`Moved ${name} to ${on}.`, day);
  }

  /** Says `text` about an entry on `day`, which is not the day shown, with a button that shows that day. */
  private showOnOtherDay(text: string, day: string) {
    replaceChildren(this.movedNotice, `${text} `, el("button", { type: "button", class: "link", onclick: () => this.showDay(day) }, `Show ${dayInWords(day)}`));
    this.movedNotice.hidden = false;
  }

  private clearMoved() {
    this.movedNotice.replaceChildren();
    this.movedNotice.hidden = true;
  }

  /** Deletes the entry an edit replaced. If that fails both exist, so the old row comes back and an alert says so. */
  private async removeReplaced(entry: DiaryEntry) {
    try {
      const op = await this.api.deleteNutritionLogs([entry.name]);
      if (op.error) throw new Error(op.error.message ?? "Google Health could not delete the entry.");
      this.dropPending(entry.id);
      this.catalog.remove(entry.id);
    } catch (e) {
      appLog.error("Removing the entry an edit replaced failed", describeError(e));
      this.handleError(e, false);
      this.deletedIds.delete(entry.id);
      // Only onto its own day: after a move, the user may already be looking at the new one.
      if (entry.day === this.day()) this.entries = [...this.entries.filter((other) => other.id !== entry.id), entry].sort(byTime);
      this.showRowFailure(entry, oldEntryNotRemoved(entry.displayName));
    }
    this.busy.delete(entry.id);
    this.renderDiary();
    await this.loadDay();
  }

  /** Disables the row, tags it with `tag`, and forgets why this row failed last time. */
  private startRowAction(entry: DiaryEntry, tag: string) {
    this.busy.set(entry.id, tag);
    this.rowFailures.get(entry.id)?.remove();
    this.rowFailures.delete(entry.id);
    this.rowAlert.hidden = this.rowFailures.size === 0;
    this.renderDiary();
  }

  /** `fromChat`: the chat changes entries on any day and its card says why it failed, so a row not on screen gets no alert. */
  private showRowFailure(entry: DiaryEntry, message: string, fromChat = false) {
    if (fromChat && entry.day !== this.day()) return;
    this.rowAlert.hidden = false;
    const failure = el("p", {}, message);
    this.rowFailures.set(entry.id, failure);
    this.rowFailureList.append(failure);
    // On a phone the row can be a long way below the top of the card.
    this.rowAlert.scrollIntoView({ block: "nearest" });
  }

  private clearRowFailures() {
    this.rowFailures.clear();
    this.rowFailureList.replaceChildren();
    this.rowAlert.hidden = true;
  }

  // Meal prep (#55, DR-24) ------------------------------------------------------------------------

  private resetPreps() {
    this.preps = [];
    this.prepError = "";
    this.prepDiscarded.clear();
    this.prepBusy.clear();
    this.prepMessages.clear();
    this.givenBack.clear();
  }

  private renderPreps() {
    // Saved meals live in the same API, so they go when meal prep does.
    this.renderMeals();
    if (!this.prepAvailable) {
      this.form.setPreps({ available: false, preps: [], busy: this.prepBusy });
      this.entryCard.setPrep(false, 0);
      return;
    }
    const onHand = this.preps.filter((p) => p.discardedAt === null && !isFinished(p));
    this.form.setPreps({ available: true, preps: onHand, busy: this.prepBusy });
    this.entryCard.setPrep(true, onHand.length);
    this.prepCard.update({
      preps: this.preps,
      loading: this.prepLoading && this.preps.length === 0,
      error: this.prepError,
      offline: this.connection.state === "offline",
      discarded: this.prepDiscarded,
      busy: this.prepBusy,
      messages: this.prepMessages,
      building: this.prepBuilder.isOpen,
    });
  }

  private async loadPreps() {
    if (!this.prepAvailable || !this.auth.isSignedIn) return;
    // The list under way may have been read before a change it should show: load again after it (#133).
    if (this.prepLoading) {
      this.prepReload = true;
      return;
    }
    const user = this.auth.subject;
    this.prepLoading = true;
    this.renderPreps();
    try {
      const preps = await this.prepApi.list();
      // Signed in as someone else meanwhile: these are not theirs.
      if (user === this.auth.subject) {
        this.preps = preps;
        this.prepError = "";
      }
    } catch (e) {
      if (e instanceof PrepApiMissingError) {
        appLog.info("This site has no meal prep API; hiding meal prep");
        this.prepAvailable = false;
      } else {
        appLog.warn("Loading the meal preps failed", describeError(e));
        this.prepError = `Could not load your meal preps: ${refusalReason(e)}`;
        this.handleError(e, false);
      }
    } finally {
      this.prepLoading = false;
      this.renderPreps();
    }
    if (this.prepReload) {
      this.prepReload = false;
      await this.loadPreps();
    }
  }

  /** Confirms the unconfirmed portions whose diary entries a listing showed. */
  private async confirmListed(listed: ReadonlySet<string>) {
    for (const prep of this.preps) {
      for (const portion of prep.portions) {
        if (portion.state === "unconfirmed" && portion.entryId && listed.has(portion.entryId)) await this.confirmPortion(portion.id, portion.entryId);
      }
    }
  }

  /** Best effort: an unconfirmed portion still counts as eaten, and a later listing confirms it. */
  private async confirmPortion(portionId: string, entryId: string) {
    try {
      await this.prepApi.confirm(portionId, entryId);
    } catch (e) {
      appLog.warn("Could not confirm a portion; a later refresh will try again", describeError(e));
    }
  }

  private say(prep: Prep, text: string, error = false) {
    this.prepMessages.set(prep.id, { text, error });
  }

  private async savePrep(draft: PrepDraft) {
    const id = draft.id ?? randomId(12);
    try {
      await this.prepApi.save(id, draft.name, draft.ingredients);
    } catch (e) {
      this.handleError(e, false);
      throw new Error(`Could not save the prep: ${refusalReason(e)}`, { cause: e });
    }
    appLog.info(draft.id ? "Saved changes to a prep" : "Saved a new prep", { ingredients: draft.ingredients.length });
    this.prepMessages.set(id, { text: draft.id ? "Saved. Portions from now on use the new ingredients." : "Saved.", error: false });
    await this.loadPreps();
  }

  /**
   * Reserves the portion, then logs it, then confirms it (docs/ARCHITECTURE.md section 4.5). Reserving first means two
   * devices can't eat more than the batch between them. A lost answer leaves the portion unconfirmed, still counting as eaten.
   */
  private async eatPortion(prep: Prep, fraction: number | null, mealType: MealType | undefined, time: Date): Promise<PrepOutcome> {
    if (this.prepBusy.has(prep.id)) return { text: `${prep.name} is busy. Try again in a moment.`, error: true };
    this.prepBusy.add(prep.id);
    this.prepMessages.delete(prep.id);
    this.renderPreps();
    const portionId = randomId(16);
    const entryId = newEntryId({ source: "prep", id: prep.id });
    let outcome: PrepOutcome;
    try {
      let portion: PrepPortion;
      try {
        portion = await this.prepApi.reserve(prep.id, { id: portionId, fraction, entryId, eatenAt: time.getTime() });
      } catch (e) {
        if (e instanceof PrepApiError && e.status === 409) throw new Error(e.left ? `Only ${Math.round(e.left * 100)}% is left.` : "There is none left.", { cause: e });
        if (e instanceof PrepApiError && e.connectionFailed) {
          throw new Error("The meal prep service did not answer, so this portion may have been taken. Nothing was logged. Check “Eaten so far” in the Meal prep tab before trying again.", { cause: e });
        }
        throw e;
      }
      const point = buildPortionPoint({ name: portionName(prep.name, portion.fraction), profile: portionProfile(prep.ingredients, portion.fraction), mealType, time }, entryId);
      appLog.info(`Logging a portion of ${prep.name}`, { id: entryId, fraction: portion.fraction, mealType });
      try {
        const { key } = await this.write(point);
        await this.confirmPortion(portionId, key);
        outcome = { text: `Logged ${point.nutritionLog!.foodDisplayName}.`, error: false, eaten: true };
      } catch (e) {
        if (isConnectionFailure(e)) {
          outcome = {
            text: "Google Health did not answer, so this portion may not be in the diary. It counts as eaten until a refresh finds it. If it never appears, give it back from “Eaten so far” in the Meal prep tab.",
            error: true,
            eaten: true,
          };
        } else {
          const givenBack = await this.prepApi.remove(portionId).then(
            () => true,
            (removeError: unknown) => (appLog.warn("Could not give back a refused portion", describeError(removeError)), false),
          );
          appLog.error("Google Health refused a portion's entry", describeError(e));
          this.handleError(e, false);
          outcome = givenBack
            ? { text: `Google Health refused the entry, so nothing was eaten: ${refusalReason(e)}`, error: true }
            : {
                text: `Google Health refused the entry (${refusalReason(e)}), but the portion still counts as eaten. Give it back from “Eaten so far” in the Meal prep tab.`,
                error: true,
                eaten: true,
              };
        }
      }
    } catch (e) {
      appLog.error("Eating a portion failed", describeError(e));
      this.handleError(e, false);
      outcome = { text: refusalReason(e), error: true };
    } finally {
      this.prepBusy.delete(prep.id);
      this.renderPreps();
    }
    // Loading the day also reloads the preps, which shows what is left now.
    void this.loadDay();
    return outcome;
  }

  // Saved meals -----------------------------------------------------------------------------------

  private resetMeals() {
    this.meals = [];
    this.mealsError = "";
    this.mealsDeleted = [];
    this.mealBusy.clear();
    this.mealMessages.clear();
  }

  private renderMeals() {
    const available = this.prepAvailable && this.mealsAvailable;
    this.form.setMeals({ available, meals: available ? this.meals : [] });
    this.entryCard.setMeals(available, this.meals.length);
    if (!available) return;
    this.mealCard.update({
      meals: this.meals,
      loading: this.mealsLoading && this.meals.length === 0,
      error: this.mealsError,
      offline: this.connection.state === "offline",
      deleted: this.mealsDeleted,
      busy: this.mealBusy,
      messages: this.mealMessages,
      building: this.mealBuilder.isOpen,
    });
  }

  private async loadMeals() {
    if (!this.prepAvailable || !this.mealsAvailable || !this.auth.isSignedIn) return;
    if (this.mealsLoading) {
      this.mealsReload = true;
      return;
    }
    const user = this.auth.subject;
    this.mealsLoading = true;
    this.renderMeals();
    try {
      const meals = await this.prepApi.listMeals();
      if (user !== this.auth.subject) return; // signed in as someone else meanwhile
      if (meals === undefined) {
        appLog.info("This site's API has no saved meals; hiding them");
        this.mealsAvailable = false;
      } else {
        this.meals = meals;
        this.mealsError = "";
      }
    } catch (e) {
      // A site without the API at all: loadPreps hides meal prep, and saved meals with it.
      if (!(e instanceof PrepApiMissingError)) {
        appLog.warn("Loading the saved meals failed", describeError(e));
        this.mealsError = `Could not load your saved meals: ${refusalReason(e)}`;
        this.handleError(e, false);
      }
    } finally {
      this.mealsLoading = false;
      this.renderMeals();
    }
    if (this.mealsReload) {
      this.mealsReload = false;
      await this.loadMeals();
    }
  }

  private async saveMeal(draft: PrepDraft) {
    const id = draft.id ?? randomId(12);
    try {
      await this.prepApi.saveMeal(id, draft.name, draft.ingredients);
    } catch (e) {
      this.handleError(e, false);
      throw new Error(`Could not save the meal: ${refusalReason(e)}`, { cause: e });
    }
    appLog.info(draft.id ? "Saved changes to a meal" : "Saved a new meal", { ingredients: draft.ingredients.length });
    this.mealMessages.set(id, { text: draft.id ? "Saved. Meals logged from now on use the new ingredients." : "Saved.", error: false });
    await this.loadMeals();
  }

  /** Deletes a saved meal. Until reload it stays in the list with an undo, which saves it again. */
  private async deleteMeal(meal: SavedMeal) {
    if (this.mealBusy.has(meal.id)) return;
    this.mealBusy.add(meal.id);
    this.renderMeals();
    try {
      await this.prepApi.deleteMeal(meal.id);
      this.mealsDeleted = [...this.mealsDeleted.filter((m) => m.id !== meal.id), meal];
      this.meals = this.meals.filter((m) => m.id !== meal.id);
      this.mealMessages.set(meal.id, { text: "Deleted. Entries already in the diary stay.", error: false });
    } catch (e) {
      this.handleError(e, false);
      this.mealMessages.set(meal.id, { text: `Could not delete ${meal.name}: ${refusalReason(e)}`, error: true });
    } finally {
      this.mealBusy.delete(meal.id);
    }
    await this.loadMeals();
  }

  private async restoreMeal(meal: SavedMeal) {
    if (this.mealBusy.has(meal.id)) return;
    this.mealBusy.add(meal.id);
    this.renderMeals();
    try {
      await this.prepApi.saveMeal(meal.id, meal.name, meal.ingredients);
      this.mealsDeleted = this.mealsDeleted.filter((m) => m.id !== meal.id);
      this.mealMessages.set(meal.id, { text: "Back again.", error: false });
    } catch (e) {
      this.handleError(e, false);
      this.mealMessages.set(meal.id, { text: `Could not bring back ${meal.name}: ${refusalReason(e)}`, error: true });
    } finally {
      this.mealBusy.delete(meal.id);
    }
    await this.loadMeals();
  }

  /** Logs a saved meal as one entry under its name, with the nutrients of the ingredients as changed for this entry. */
  private async logMeal(meal: SavedMeal, ingredients: readonly PrepIngredient[], mealType: MealType | undefined, time: Date) {
    const id = newEntryId({ source: "meal", id: meal.id });
    const point = buildPortionPoint({ name: meal.name, profile: batchProfile(ingredients), mealType, time }, id);
    appLog.info(`Logging the saved meal ${meal.name}`, { id, ingredients: ingredients.length, mealType });
    try {
      await this.write(point);
    } catch (e) {
      appLog.error("Logging the meal failed", describeError(e));
      this.handleError(e, false);
      throw isConnectionFailure(e) ? new Error(LOG_NOT_CONFIRMED, { cause: e }) : e;
    }
    await this.loadDay();
  }

  /** Discards a prep from the log form, which says what happened and offers an undo. */
  private async discardFromForm(prep: Prep): Promise<PrepOutcome> {
    const error = await this.discardPrep(prep, true);
    this.prepMessages.delete(prep.id);
    return error
      ? { text: error, error: true }
      : {
          text: `Discarded ${prep.name}. Nothing was logged.`,
          error: false,
          undo: async () => {
            const failure = await this.discardPrep(prep, false);
            this.prepMessages.delete(prep.id);
            return failure ? { text: failure, error: true } : { text: `${prep.name} is back.`, error: false };
          },
        };
  }

  /** Returns why it failed, if it did. */
  private async discardPrep(prep: Prep, discarded: boolean): Promise<string | undefined> {
    if (this.prepBusy.has(prep.id)) return `${prep.name} is busy. Try again in a moment.`;
    this.prepBusy.add(prep.id);
    this.renderPreps();
    let failure: string | undefined;
    try {
      await this.prepApi.setDiscarded(prep.id, discarded);
      if (discarded) this.prepDiscarded.add(prep.id);
      else this.prepDiscarded.delete(prep.id);
      this.say(prep, discarded ? "Discarded. Nothing was logged." : "Back again.");
    } catch (e) {
      this.handleError(e, false);
      failure = `Could not ${discarded ? "discard" : "bring back"} ${prep.name}: ${refusalReason(e)}`;
      this.say(prep, failure, true);
    } finally {
      this.prepBusy.delete(prep.id);
    }
    await this.loadPreps();
    return failure;
  }

  /**
   * Removes a portion from the prep's list: deletes its diary entry, then gives the portion back. An unconfirmed
   * portion's entry may never have been written, so Google refusing to delete it doesn't stop the give-back.
   */
  private async removePortion(prep: Prep, portion: PrepPortion) {
    if (this.prepBusy.has(prep.id)) return;
    this.prepBusy.add(prep.id);
    this.renderPreps();
    try {
      if (portion.entryId) {
        try {
          const op = await this.api.deleteNutritionLogs([`${NUTRITION_LOG_PARENT}/dataPoints/${portion.entryId}`]);
          if (op.error && portion.state === "confirmed") throw new Error(op.error.message ?? "Google Health could not delete the entry.");
        } catch (e) {
          const gone = e instanceof HealthApiError && e.httpStatus === 404;
          if (isConnectionFailure(e) || (portion.state === "confirmed" && !gone)) throw e;
          appLog.info("The portion's entry was not deleted (it may never have been written); giving the portion back anyway", describeError(e));
        }
        this.deletedIds.add(portion.entryId);
        this.entries = this.entries.filter((e) => e.id !== portion.entryId);
        this.dropPending(portion.entryId);
      }
      await this.prepApi.remove(portion.id);
      this.say(prep, "Removed from the diary, and given back to the prep.");
    } catch (e) {
      appLog.error("Removing a portion failed", describeError(e));
      this.handleError(e, false);
      this.say(prep, isConnectionFailure(e) ? deleteFailed(portionName(prep.name, portion.fraction)) : `Could not remove that portion: ${refusalReason(e)}`, true);
    } finally {
      this.prepBusy.delete(prep.id);
    }
    await Promise.all([this.loadPreps(), this.loadDay()]);
  }

  /**
   * A diary entry was deleted: if it was a portion, give the portion back, and remember it so that an undo can take it
   * again. The entry is traced by its portion's records, not by its ID's format, because Google may store an entry
   * under its own ID. The prep list may also predate the portion, so it is read again before giving up.
   */
  private async giveBackDeleted(entry: DiaryEntry) {
    if (entry.ref?.source === "meal") return; // a saved meal has nothing to give back
    const byId = entry.ref?.source === "prep";
    const name = entry.point.nutritionLog?.foodDisplayName?.trim() ?? "";
    // Before the preps have loaded, any name shaped like a portion's is worth a look.
    const looksLikePortion = byId || (this.preps.length ? this.preps.some((prep) => name.startsWith(`${prep.name.trim()} (`)) : this.prepAvailable && PORTION_SUFFIX.test(name));
    if (!looksLikePortion) return;
    const traced: PortionEntry = { id: entry.id, foodDisplayName: name, start: entry.start.getTime() };
    const listed = new Set(this.entries.map((e) => e.id));
    let found = portionOfEntry(this.preps, traced, listed);
    let unchecked = false;
    if (!found) {
      try {
        const preps = await this.prepApi.list();
        if (this.prepUser === this.auth.subject) this.preps = preps;
        found = portionOfEntry(preps, traced, listed);
      } catch (e) {
        if (e instanceof PrepApiMissingError) return;
        appLog.warn("Deleted an entry that may be a portion, but could not read the preps", describeError(e));
        unchecked = true;
      }
    }
    if (!found) {
      if (!byId && !unchecked) return; // named like a portion, but not one
      appLog.warn("Deleted an entry that may be a portion, but found no portion for it; nothing was given back", { id: entry.id });
      this.showRowFailure(entry, `${entry.displayName} was deleted, but its meal prep could not be checked, so it may still count as eaten. If it does, remove it from the prep's list.`);
      return;
    }
    if (found.portion.entryId !== entry.id) appLog.info("Traced a deleted entry to its portion by name and time", { entry: entry.id, portionEntry: found.portion.entryId });
    this.givenBack.set(entry.id, { prepId: found.prep.id, fraction: found.portion.fraction });
    try {
      await this.prepApi.remove(found.portion.id);
    } catch (e) {
      appLog.warn("Deleted a portion's entry, but could not give the portion back", describeError(e));
      this.say(found.prep, `The entry was deleted, but ${found.prep.name} still counts it as eaten. Remove it from the list below.`, true);
    }
    void this.loadPreps();
  }

  /** Before undoing a portion's delete, takes the portion again. Returns its ID, or undefined if this was not a portion. */
  private async retakePortion(entry: DiaryEntry, copyId: string): Promise<string | undefined> {
    const back = this.givenBack.get(entry.id);
    if (!back) return undefined;
    const portionId = randomId(16);
    try {
      await this.prepApi.reserve(back.prepId, { id: portionId, fraction: back.fraction, entryId: copyId, eatenAt: entry.start.getTime() });
    } catch (e) {
      if (e instanceof PrepApiError && e.status === 409) throw new Error(`only ${Math.round((e.left ?? 0) * 100)}% of it is left, so it can't be eaten again`, { cause: e });
      if (e instanceof PrepApiMissingError || (e instanceof PrepApiError && e.status === 404)) return undefined; // the prep is gone; the copy is just an entry
      throw e;
    }
    // Kept in givenBack until the copy is written: if Google refuses it, the next undo must take the portion again.
    void this.loadPreps();
    return portionId;
  }

  private diaryContext(): DiaryContext {
    return { ownClientId: this.clientId, unitNames: this.unitNames };
  }

  private dropPending(key: string) {
    this.pending.delete(key);
    this.pendingSince.delete(key);
  }

  /** Signs out and forgets this user's diary state (the per-user unit cache stays). */
  private signOut() {
    this.stopEditing();
    // The chat holds this user's diary.
    this.chat.reset();
    this.pending.clear();
    this.pendingSince.clear();
    this.deleted.clear();
    this.deletedIds.clear();
    this.busy.clear();
    this.clearRowFailures();
    this.catalog.clear();
    this.resetPreps();
    this.resetMeals();
    this.prepUser = undefined;
    // Open, either builder would save what it holds to whoever signs in next (#133).
    if (this.prepBuilder.isOpen) this.prepBuilder.close();
    if (this.mealBuilder.isOpen) this.mealBuilder.close();
    this.loggedFoodsRead = undefined;
    this.entries = [];
    this.loadedDay = undefined;
    this.weekEntries = [];
    this.weekDay = undefined;
    this.weekError = "";
    this.weekSession++;
    this.burnt = undefined;
    this.burntDay = undefined;
    this.burntError = "";
    this.burntRequest++;
    this.notice = "";
    this.connectError = "";
    this.accountCheck = undefined;
    this.listError = "";
    this.ready = false;
    this.auth.signOut();
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
    // Redrawing moves the settings panel, which would drop the focus of a control in it.
    const active = document.activeElement;
    const settingsFocus = active instanceof HTMLElement && this.settings.element.contains(active) ? active : undefined;
    this.settings.setItems([
      signedIn && (this.energyControl ??= this.energySetting()),
      signedIn && this.aiSetting,
      !isClientIdBuiltIn() && (this.clientIdLink ??= el("button", { type: "button", class: "link", onclick: () => (this.settings.close(), renderSetup(true)) }, "OAuth client ID")),
    ]);
    const header = el(
      "header",
      { class: "top" },
      el("h1", {}, "Food Diary"),
      el(
        "div",
        { class: "account" },
        signedIn && this.ready && this.chat.toggle,
        signedIn && el("button", { type: "button", onclick: () => this.signOut() }, "Sign out"),
        this.settings.element,
      ),
    );
    queueMicrotask(() => settingsFocus?.isConnected && settingsFocus.focus());

    if (!signedIn) {
      this.stopEditing();
      // Kept for when the same user signs in again, but out of sight: it can't read the diary meanwhile.
      if (this.chat.isOpen) this.chat.close();
      const expired = this.auth.hasExpiredSession;
      replaceChildren(
        root,
        header,
        this.connectionNotice,
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
      this.connectionNotice,
      this.notice && el("p", { class: "notice" }, this.notice),
      this.ready ? this.entryCard.element : this.connectError ? this.renderConnectError() : el("p", { class: "status" }, "Connecting to Google Health…"),
      this.ready &&
        el(
          "section",
          { class: "card diary-card" },
          el(
            "div",
            { class: "card-head" },
            el("div", { class: "day-nav" }, this.previousDayButton, this.dayHeading, this.nextDayButton, this.dayPicker.element, this.todayButton),
            el("button", { type: "button", onclick: () => void this.loadDay() }, "Refresh"),
          ),
          this.diaryStatus,
          this.movedNotice,
          this.rowAlert,
          this.diary,
          el(
            "p",
            { class: "hint" },
            "Everything in your Google Health nutrition diary for the day, whichever app logged it. New entries go on the day shown. " +
              "Any entry but a meal prep share can be logged again for today with the button beside it, and on today, + adds one more of what was logged to this app's entries. Only entries made by this app can be edited or deleted here. A deleted entry stays crossed out, with an undo button, until you reload the page.",
          ),
        ),
      this.ready &&
        el(
          "section",
          { class: "card dashboard-card" },
          el("h2", {}, "Dashboard"),
          this.dashboard,
          el(
            "p",
            { class: "hint" },
            "The day shown in the diary, and the 7 days ending on it, from every app's entries. Energy by macronutrient " +
              "counts 4 kcal a gram of protein and of carbs and 9 of fat, so it can differ a little from the energy logged. " +
              "Snacks include Google Health's snack times (such as afternoon snack); Other is entries with no meal. ",
            this.canReadActivity
              ? "Calories burnt are Google Health's total for each day, at rest and active, from every source; today's is what was burnt so far, up to the last sync."
              : [
                  "To compare with the calories you burn, allow access to your activity data: ",
                  el("button", { type: "button", class: "link", onclick: () => void this.signIn("consent") }, "Show calories burnt"),
                  ".",
                ],
          ),
        ),
      debugPanel,
    );
    this.renderDiary();
    this.renderPreps();
    this.renderMeals();
  }

  /** Which unit energy is shown in, everywhere in the app. */
  private energySetting(): HTMLElement {
    const unit = getEnergyUnit();
    const select = el(
      "select",
      {
        onchange: () => {
          setEnergyUnit(select.value as EnergyUnit);
          this.form.refreshPreview();
          this.editor?.refresh();
          this.prepBuilder.refreshPreview();
          this.mealBuilder.refreshPreview();
          this.renderMeals();
          this.renderDiary();
        },
      },
      el("option", { value: "kcal", selected: unit === "kcal" }, "kcal"),
      el("option", { value: "kj", selected: unit === "kj" }, "kJ"),
    );
    return el("label", { class: "energy-setting" }, "Energy", select);
  }

  private renderConnectError(): HTMLElement {
    return el(
      "section",
      { class: "card error-card" },
      el("h2", {}, "Could not connect to Google Health"),
      el("p", { class: "status error" }, this.connectError),
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", class: "primary", onclick: () => void this.afterSignIn() }, "Retry"),
        el("button", { type: "button", onclick: () => this.signOut() }, "Sign out"),
      ),
      el("p", { class: "hint" }, "Details are in the Debug log below (Copy log to share it). Common causes are listed in issue #30."),
    );
  }

  /**
   * Redrawing replaces the table. On a narrow screen it keeps its sideways scroll, so that Undo stays where Delete was,
   * and the button with keyboard focus (or `focusId`'s, when the row changed ID) takes it back.
   * Edit buttons are found separately, because a row's Delete has the first claim on `focusId`.
   * The controls of a row being edited are the same elements after the redraw, and get focus back too.
   */
  private renderDiary(focusId = focusedEntryId(), editFocus = focusedEditId(), repeatFocus = focusedRepeatId(), incrementFocus = focusedIncrementId()) {
    const focused = document.activeElement;
    const inEditor = focused instanceof HTMLElement && this.diary.contains(focused) && focused.closest("tr.editing") ? focused : undefined;
    const scrollLeft = this.diary.querySelector(".table-wrap")?.scrollLeft ?? 0;
    const day = this.day();
    const today = civilDate(new Date());
    this.dayHeading.textContent = dayLabel(day, today);
    this.nextDayButton.disabled = day >= today;
    this.todayButton.hidden = day >= today;
    this.diaryStatus.textContent = this.loading ? "Loading…" : this.listError;
    this.diaryStatus.classList.toggle("error", !this.loading && Boolean(this.listError));
    const deleted = [...this.deleted.values()].filter((e) => e.day === day);
    // With nothing loaded for this day, a load or an error must not read as "Nothing logged today yet".
    const unknown = this.loadedDay !== day || (this.entries.length === 0 && deleted.length === 0 && Boolean(this.listError));
    replaceChildren(
      this.diary,
      !unknown &&
        renderDiaryTable({
          entries: this.entries,
          pendingIds: new Set(this.pending.keys()),
          deleted,
          emptyText: day === today ? "Nothing logged today yet." : "Nothing logged on this day.",
          busy: this.busy,
          offline: this.connection.state === "offline",
          ...(this.editor ? { editing: this.editor } : {}),
          onEdit: (e) => this.startEditing(e),
          onDelete: (e) => void this.remove(e),
          onUndo: (e) => void this.undoDelete(e),
          onRepeat: (e) => void this.repeatToday(e),
          today: day === today,
          onIncrement: (e) => void this.increment(e),
          ...(this.chat.available ? { onAsk: (e: DiaryEntry) => this.chat.open(e) } : {}),
        }),
    );
    this.diary.querySelector(".table-wrap")?.scrollTo({ left: scrollLeft });
    if (focusId) this.diary.querySelector<HTMLElement>(`[data-entry="${CSS.escape(focusId)}"]`)?.focus();
    else if (editFocus) this.diary.querySelector<HTMLElement>(`[data-entry-edit="${CSS.escape(editFocus)}"]`)?.focus();
    else if (repeatFocus) this.diary.querySelector<HTMLElement>(`[data-entry-repeat="${CSS.escape(repeatFocus)}"]`)?.focus();
    else if (incrementFocus) this.diary.querySelector<HTMLElement>(`[data-entry-increment="${CSS.escape(incrementFocus)}"]`)?.focus();
    else if (inEditor?.isConnected) inEditor.focus();
    this.renderDashboard();
  }

  /** Redraws the dashboard from the loaded day and week. Open tables stay open, and a focused column keeps focus. */
  private renderDashboard() {
    const day = this.day();
    const dayEntries = this.loadedDay === day ? this.entries : undefined;
    // The viewed day comes from the diary's own listing, which is newer and knows this session's edits.
    const weekEntries =
      this.weekDay === day && dayEntries
        ? [...this.weekEntries.filter((e) => e.day !== day && !this.deletedIds.has(e.id)), ...dayEntries]
        : undefined;
    const open = [...this.dashboard.querySelectorAll("details")].map((d) => d.open);
    const columns = [...this.dashboard.querySelectorAll(".chart-column")];
    const focused = columns.findIndex((c) => c === document.activeElement);
    replaceChildren(
      this.dashboard,
      renderDashboard({
        day,
        today: civilDate(new Date()),
        dayEntries,
        weekEntries,
        weekStatus: this.weekError || (this.listError && !dayEntries ? this.listError : ""),
        burnt: this.burntDay === day ? this.burnt : undefined,
        burntStatus: this.burntError,
      }),
    );
    this.dashboard.querySelectorAll("details").forEach((d, i) => (d.open = open[i] ?? false));
    if (focused >= 0) this.dashboard.querySelectorAll<SVGElement>(".chart-column")[focused]?.focus();
  }
}

/** The entry whose Delete or Undo button has keyboard focus. */
function focusedEntryId(): string | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement.dataset["entry"] : undefined;
}

/** The entry whose Edit button has keyboard focus. */
function focusedEditId(): string | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement.dataset["entryEdit"] : undefined;
}

/** The entry whose Log again button has keyboard focus. */
function focusedRepeatId(): string | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement.dataset["entryRepeat"] : undefined;
}

/** The entry whose + button has keyboard focus. */
function focusedIncrementId(): string | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement.dataset["entryIncrement"] : undefined;
}

/** `day` as the end of a sentence: "today", "yesterday", or the date written out. */
function dayInWords(day: string): string {
  const label = dayLabel(day, civilDate(new Date()));
  return label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;
}

/** Why a delete, undo or edit failed. It may be read after signing in again, so an expired session says so in the past tense. */
function refusalReason(e: unknown): string {
  return e instanceof SignInRequiredError ? "your session had expired. Try again." : errorMessage(e);
}

function isConnectionFailure(e: unknown): boolean {
  return e instanceof HealthApiError && e.connectionFailed;
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
      ") must be one of the client's Authorized JavaScript origins, and its auth-callback.html one of the Authorized redirect URIs. See the README.",
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

/**
 * Where the static food index lives: Cloudflare Pages in production (VITE_FOOD_INDEX_URL), else next to the app
 * (public/food-index/ in development). Made absolute, because the meal prep API's address is built from it with `new URL`.
 */
const FOOD_INDEX_URL = new URL(
  ((import.meta.env.VITE_FOOD_INDEX_URL as string | undefined)?.trim() || `${import.meta.env.BASE_URL}food-index`).replace(/\/?$/, "/"),
  document.baseURI,
).href;

/** Products from the Open Food Facts index if it is deployed, otherwise the built-in sample foods. */
async function openProducts(): Promise<FoodCatalog> {
  const index = new StaticFoodCatalog(FOOD_INDEX_URL, undefined, userCountry());
  try {
    const { meta } = await index.open();
    appLog.info("Food index loaded", { url: FOOD_INDEX_URL, version: meta.version, products: meta.docs, builtAt: meta.builtAt });
    return index;
  } catch (e) {
    appLog.warn("No food index found; using the sample foods", { url: FOOD_INDEX_URL, error: describeError(e) });
    return new LocalFoodCatalog(SAMPLE_FOODS);
  }
}

async function openCatalog(): Promise<LoggedFoodsCatalog> {
  const catalog = new CombinedCatalog(genericsUrl, await openProducts(), `${import.meta.env.BASE_URL}generics-LICENSE.txt`, undefined, userCountry());
  catalog.load().catch((e: unknown) => appLog.warn("Generic foods are unavailable", { error: describeError(e) }));
  appLog.info("Search favours foods from the user's country", { country: userCountry() ?? "unknown" });
  return new LoggedFoodsCatalog(catalog);
}

const clientId = getClientId();
if (clientId) void openCatalog().then((catalog) => new App(clientId, catalog));
else renderSetup();
