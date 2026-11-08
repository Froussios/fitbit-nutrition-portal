import "./styles.css";
import { GoogleAuth, SignInRequiredError, SignInSupersededError } from "./auth/google-auth";
import { getClientId, isClientIdBuiltIn, NUTRITION_READ_SCOPE, NUTRITION_WRITE_SCOPE, SCOPES, setClientId } from "./config";
import { canReload, foodLabel } from "./core/food";
import { copiedEntryId, idFromName, newEntryId } from "./core/ids";
import { civilDate } from "./core/time";
import type { BaseUnit } from "./core/units";
import { LocalFoodCatalog, type FoodCatalog } from "./food/catalog";
import { SAMPLE_FOODS } from "./food/sample-foods";
import { CombinedCatalog } from "./food/combined-catalog";
import genericsUrl from "./food/data/generics.json?url";
import { StaticFoodCatalog } from "./food/static-catalog";
import { HealthApiError, HealthClient } from "./health/client";
import { CONNECT_FAILED, ConnectionMonitor, DIARY_NOT_LOADED, LOG_NOT_CONFIRMED, actionRefused, connectionBanner, deleteFailed, editNotConfirmed, oldEntryNotRemoved, undoNotConfirmed, type ConnectionState } from "./health/connection";
import { LoggedFoodsCatalog } from "./food/logged-catalog";
import { buildNutritionLogPoint, buildPortionPoint, byTime, copyNutritionLogPoint, NUTRITION_LOG_PARENT, editedNutritionLogPoint, findServingUnits, reconcilePending, toDiaryEntries, toDiaryEntry, toLoggedFoods, withoutEntries, type DiaryEntry, type DiaryContext, type EntryEdit, type LogDraft } from "./health/mapping";
import type { DataPoint } from "./health/types";
import { renderDiaryTable } from "./ui/diary-table";
import { el, errorMessage, replaceChildren } from "./ui/dom";
import { getEnergyUnit, setEnergyUnit, type EnergyUnit } from "./ui/energy-unit";
import { createLogForm, type LogForm } from "./ui/log-form";
import { amountAi } from "./ai/amount-ai";
import { createAiSetting } from "./ui/ai-setting";
import { createRowEditor, type RowEditor } from "./ui/row-editor";
import { createDebugPanel } from "./ui/debug-panel";
import { portionName, portionProfile, randomId, type Prep, type PrepPortion } from "./core/prep";
import type { MealType } from "./health/types";
import { PrepApi, PrepApiError, PrepApiMissingError } from "./prep/api-client";
import { createPrepBuilder, type PrepBuilder, type PrepDraft } from "./ui/prep-builder";
import { createPrepCard, type PrepCard } from "./ui/prep-card";
import { describeError, installGlobalErrorHandlers, logger } from "./debug/log";

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
  /** Points written this session that a list call has not returned yet (the API may lag). */
  private readonly pending = new Map<string, DataPoint>();
  /** When each pending point was written; ones the API never lists are dropped after PENDING_TTL_MS. */
  private readonly pendingSince = new Map<string, number>();
  private entries: DiaryEntry[] = [];
  /** Today's entries deleted in this session, by ID: shown crossed out so the delete can be undone. Not stored (DR-20). */
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
  /** Why connecting to Google Health failed; shown with a Retry button instead of "Connecting…". */
  private connectError = "";

  private readonly prepApi: PrepApi;
  private readonly prepBuilder: PrepBuilder;
  private readonly prepCard: PrepCard;
  /** The user's meal preps (#55), as the API last listed them. */
  private preps: Prep[] = [];
  /** False once the site answers that it has no meal prep API: the card then stays hidden. */
  private prepAvailable = true;
  private prepLoading = false;
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
  private readonly diary = el("div", { class: "diary" });
  private readonly diaryStatus = el("p", { class: "status", role: "status" });
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
    this.form = createLogForm(catalog, (d) => this.log(d));
    this.prepBuilder = createPrepBuilder({
      catalog,
      draftKey: () => (this.auth.subject ? `foodDiary.prepDraft.${this.auth.subject}` : undefined),
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
        onEat: (prep, fraction, mealType) => void this.eatPortion(prep, fraction, mealType),
        onDiscard: (prep) => void this.discardPrep(prep, true),
        onRestore: (prep) => void this.discardPrep(prep, false),
        onRemovePortion: (prep, portion) => void this.removePortion(prep, portion),
      },
      this.prepBuilder.element,
    );
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
      if (this.shouldRefresh()) void this.loadToday();
    });
    setInterval(() => {
      if (this.shouldRefresh()) void this.loadToday();
    }, POLL_MS);

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
    if (this.prepCard) this.renderPreps();
    this.editor?.setOffline(this.connection.state === "offline");
  }

  /** The browser is back online: pick up what the outage interrupted. */
  private reconnect() {
    if (!this.auth.isSignedIn) return;
    if (this.loading) this.reloadAfterLoad = true;
    else if (this.ready) void this.loadToday();
    else if (this.connectError) void this.afterSignIn();
    if (this.ready) void this.loadLoggedFoods();
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
          : isConnectionFailure(e)
            ? CONNECT_FAILED
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
    void this.loadLoggedFoods();
    if (this.prepUser !== this.auth.subject) this.resetPreps();
    this.prepUser = this.auth.subject;
    void this.loadPreps();
    await this.loadToday();
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
      // Read after the wait: an entry deleted meanwhile may be in this listing, and must not come back.
      const points = withoutEntries(await this.api.listNutritionLogs(today), this.deletedIds);
      const matched = reconcilePending(this.pending, points, this.clientId);
      for (const key of [...matched.listedById, ...matched.listedByContent]) this.dropPending(key);
      const stale = matched.stillPending.filter((key) => Date.now() - (this.pendingSince.get(key) ?? 0) > PENDING_TTL_MS);
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
      const pending = withoutEntries([...this.pending.values()], this.deletedIds).filter((p) => civilDate(new Date(p.nutritionLog!.interval.startTime)) === today);
      this.entries = toDiaryEntries([...points, ...pending], this.diaryContext());
      const listed = new Set([...points.flatMap((p) => (p.name ? [idFromName(p.name)] : [])), ...this.pending.keys()]);
      void this.loadPreps().then(() => this.confirmListed(listed));
      // Deleted in another app, or the day has changed: there is no row left to edit.
      if (this.editor && !this.entries.some((e) => e.id === this.editor?.id)) this.stopEditing();
      for (const [id, entry] of this.deleted) {
        if (civilDate(entry.start) !== today) this.deleted.delete(id);
      }
      const unparsed = points.length - this.entries.length + pending.length;
      appLog.info(`Diary for ${today}: ${points.length} from the API, ${pending.length} pending`, {
        own: this.entries.filter((e) => e.own).length,
        others: this.entries.filter((e) => !e.own).map((e) => e.sourceLabel ?? "(unknown writer)"),
        ...(unparsed > 0 ? { skippedWithoutNutritionLog: unparsed } : {}),
      });
    } catch (e) {
      appLog.error("Loading the diary failed", describeError(e));
      this.listError = isConnectionFailure(e) ? DIARY_NOT_LOADED : errorMessage(e);
      this.handleError(e, false);
    } finally {
      this.loading = false;
      this.renderDiary();
      if (this.reloadAfterLoad) {
        this.reloadAfterLoad = false;
        if (this.auth.isSignedIn) void this.loadToday();
      }
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
      const { key } = await this.write(point);
      if (canReload(draft.food.ref.source)) {
        this.catalog.add({ id: key, ref: draft.food.ref, label: foodLabel(draft.food), at: draft.time.getTime() }, draft.food);
      }
    } catch (e) {
      appLog.error("Logging the entry failed", describeError(e));
      this.handleError(e, false);
      throw isConnectionFailure(e) ? new Error(LOG_NOT_CONFIRMED, { cause: e }) : e;
    }
    await this.loadToday();
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

  private async remove(entry: DiaryEntry) {
    if (this.busy.has(entry.id)) return;
    // Disabling the button takes keyboard focus from it, so it is given back at the end.
    const hadFocus = focusedEntryId() === entry.id;
    this.startRowAction(entry, "deleting…");
    appLog.info(`Deleting ${entry.name}`);
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
      if (entry.ref?.source === "prep") await this.giveBackDeleted(entry);
    } catch (e) {
      appLog.error("Deleting the entry failed", describeError(e));
      this.handleError(e, false);
      this.showRowFailure(entry, isConnectionFailure(e) ? deleteFailed(entry.displayName) : actionRefused("delete", entry.displayName, refusalReason(e)));
    }
    this.busy.delete(entry.id);
    this.renderDiary(hadFocus ? entry.id : undefined);
    await this.loadToday();
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
      if (retaken) await this.confirmPortion(retaken, key);
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
      this.showRowFailure(entry, isConnectionFailure(e) ? undoNotConfirmed(entry.displayName) : actionRefused("undo deleting", entry.displayName, refusalReason(e)));
    }
    this.busy.delete(entry.id);
    this.renderDiary(focusId);
    await this.loadToday();
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
      onCancel: () => {
        this.stopEditing();
        this.renderDiary(undefined, entry.id);
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
   */
  private async saveEdit(entry: DiaryEntry, edit: EntryEdit): Promise<void> {
    const log = entry.point.nutritionLog;
    if (this.busy.has(entry.id) || !log) return;
    let point: DataPoint;
    try {
      point = editedNutritionLogPoint(log, edit, { id: copiedEntryId(entry.id), servingUnits: this.servingUnits, unitNames: this.unitNames });
    } catch (e) {
      appLog.error("Could not build the edited entry", describeError(e));
      this.showRowFailure(entry, actionRefused("edit", entry.displayName, errorMessage(e)));
      return;
    }
    this.startRowAction(entry, "saving…");
    // The row can leave the diary during the write, and another row can be opened: the answer is only for this one's editor.
    const editor = this.editor;
    editor?.setSaving(true);
    const stillEditing = () => editor !== undefined && this.editor === editor;
    appLog.info(`Editing ${entry.name}`, { replacement: point.name, mealType: edit.mealType, quantity: edit.amount?.quantity, unit: edit.amount?.unit, fromFoodRecord: Boolean(edit.amount?.food) });
    // The replacement has no name for its unit until the API lists it, but the original did.
    if (log.serving?.foodMeasurementUnitDisplayName) this.unitNames.set(log.serving.foodMeasurementUnit, log.serving.foodMeasurementUnitDisplayName);
    let written: { key: string; created: DataPoint };
    try {
      written = await this.write(point);
    } catch (e) {
      appLog.error("Saving the edit failed", describeError(e));
      this.handleError(e, false);
      this.busy.delete(entry.id);
      this.showRowFailure(entry, isConnectionFailure(e) ? editNotConfirmed(entry.displayName) : actionRefused("edit", entry.displayName, refusalReason(e)));
      if (stillEditing()) editor?.setSaving(false);
      this.renderDiary();
      if (stillEditing()) editor?.focusSave();
      return;
    }
    const { key, created } = written;
    // No wait since the write: a listing that still has the original must not match the replacement to it (a meal-only edit looks the same).
    this.deletedIds.add(entry.id);
    this.catalog.merge(toLoggedFoods([created], this.clientId));
    const replacement = toDiaryEntry(created, this.diaryContext());
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), ...(replacement ? [replacement] : [])].sort(byTime);
    if (stillEditing()) {
      this.stopEditing();
      this.renderDiary(undefined, key);
    } else {
      this.renderDiary();
    }
    void this.removeReplaced(entry);
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
      this.entries = [...this.entries.filter((other) => other.id !== entry.id), entry].sort(byTime);
      this.showRowFailure(entry, oldEntryNotRemoved(entry.displayName));
    }
    this.busy.delete(entry.id);
    this.renderDiary();
    await this.loadToday();
  }

  /** Disables the row, tags it with `tag`, and forgets why this row failed last time. */
  private startRowAction(entry: DiaryEntry, tag: string) {
    this.busy.set(entry.id, tag);
    this.rowFailures.get(entry.id)?.remove();
    this.rowFailures.delete(entry.id);
    this.rowAlert.hidden = this.rowFailures.size === 0;
    this.renderDiary();
  }

  private showRowFailure(entry: DiaryEntry, message: string) {
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
    if (!this.prepAvailable) return this.prepCard.hide();
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
    if (!this.prepAvailable || this.prepLoading || !this.auth.isSignedIn) return;
    const user = this.auth.subject;
    this.prepLoading = true;
    this.renderPreps();
    try {
      const preps = await this.prepApi.list();
      if (user !== this.auth.subject) return; // signed in as someone else meanwhile
      this.preps = preps;
      this.prepError = "";
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
  private async eatPortion(prep: Prep, fraction: number | null, mealType: MealType | undefined) {
    if (this.prepBusy.has(prep.id)) return;
    this.prepBusy.add(prep.id);
    this.prepMessages.delete(prep.id);
    this.renderPreps();
    const time = new Date();
    const portionId = randomId(16);
    const entryId = newEntryId({ source: "prep", id: prep.id });
    try {
      let portion: PrepPortion;
      try {
        portion = await this.prepApi.reserve(prep.id, { id: portionId, fraction, entryId, eatenAt: time.getTime() });
      } catch (e) {
        if (e instanceof PrepApiError && e.status === 409) throw new Error(e.left ? `Only ${Math.round(e.left * 100)}% is left.` : "There is none left.", { cause: e });
        throw e;
      }
      const point = buildPortionPoint({ name: portionName(prep.name, portion.fraction), profile: portionProfile(prep.ingredients, portion.fraction), mealType, time }, entryId);
      appLog.info(`Logging a portion of ${prep.name}`, { id: entryId, fraction: portion.fraction, mealType });
      try {
        const { key } = await this.write(point);
        await this.confirmPortion(portionId, key);
        this.say(prep, `Logged ${point.nutritionLog!.foodDisplayName}.`);
        this.prepCard.clearAmount(prep.id);
      } catch (e) {
        if (isConnectionFailure(e)) {
          this.say(prep, "Google Health did not answer, so this portion may not be in the diary. It counts as eaten until a refresh finds it. If it never appears, give it back from the list below.", true);
        } else {
          await this.prepApi.remove(portionId).catch(() => undefined);
          throw new Error(`Google Health refused the entry, so nothing was eaten: ${refusalReason(e)}`, { cause: e });
        }
      }
    } catch (e) {
      appLog.error("Eating a portion failed", describeError(e));
      this.handleError(e, false);
      this.say(prep, refusalReason(e), true);
    } finally {
      this.prepBusy.delete(prep.id);
      this.renderPreps();
    }
    await this.loadToday();
  }

  private async discardPrep(prep: Prep, discarded: boolean) {
    if (this.prepBusy.has(prep.id)) return;
    this.prepBusy.add(prep.id);
    this.renderPreps();
    try {
      await this.prepApi.setDiscarded(prep.id, discarded);
      if (discarded) this.prepDiscarded.add(prep.id);
      else this.prepDiscarded.delete(prep.id);
      this.say(prep, discarded ? "Discarded. Nothing was logged." : "Back again.");
    } catch (e) {
      this.handleError(e, false);
      this.say(prep, `Could not ${discarded ? "discard" : "bring back"} ${prep.name}: ${refusalReason(e)}`, true);
    } finally {
      this.prepBusy.delete(prep.id);
    }
    await this.loadPreps();
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
    await Promise.all([this.loadPreps(), this.loadToday()]);
  }

  /** The diary entry of a portion was deleted: give the portion back, and remember it so that an undo can take it again. */
  private async giveBackDeleted(entry: DiaryEntry) {
    const found = this.preps.flatMap((prep) => prep.portions.filter((p) => p.entryId === entry.id).map((p) => ({ prep, portion: p })))[0];
    if (!found) return;
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
    if (entry.ref?.source !== "prep" || !back) return undefined;
    const portionId = randomId(16);
    try {
      await this.prepApi.reserve(back.prepId, { id: portionId, fraction: back.fraction, entryId: copyId, eatenAt: entry.start.getTime() });
    } catch (e) {
      if (e instanceof PrepApiError && e.status === 409) throw new Error(`only ${Math.round((e.left ?? 0) * 100)}% of it is left, so it can't be eaten again`, { cause: e });
      if (e instanceof PrepApiMissingError || (e instanceof PrepApiError && e.status === 404)) return undefined; // the prep is gone; the copy is just an entry
      throw e;
    }
    this.givenBack.delete(entry.id);
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
    this.pending.clear();
    this.pendingSince.clear();
    this.deleted.clear();
    this.deletedIds.clear();
    this.busy.clear();
    this.clearRowFailures();
    this.catalog.clear();
    this.resetPreps();
    this.prepUser = undefined;
    if (this.prepBuilder.isOpen) this.prepBuilder.close();
    this.loggedFoodsRead = undefined;
    this.entries = [];
    this.notice = "";
    this.connectError = "";
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
    const header = el(
      "header",
      { class: "top" },
      el("h1", {}, "Food Diary"),
      el(
        "div",
        { class: "account" },
        signedIn && this.energySetting(),
        signedIn && this.aiSetting,
        signedIn && el("button", { type: "button", onclick: () => this.signOut() }, "Sign out"),
        !isClientIdBuiltIn() && el("button", { type: "button", class: "link", onclick: () => renderSetup(true) }, "Settings"),
      ),
    );

    if (!signedIn) {
      this.stopEditing();
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
      this.ready ? this.form.element : this.connectError ? this.renderConnectError() : el("p", { class: "status" }, "Connecting to Google Health…"),
      this.ready && this.prepCard.element,
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
          this.rowAlert,
          this.diary,
          el(
            "p",
            { class: "hint" },
            "Everything in your Google Health nutrition diary for today, whichever app logged it. " +
              "Only entries made by this app can be edited or deleted here. A deleted entry stays crossed out, with an undo button, until you reload the page.",
          ),
        ),
      debugPanel,
    );
    this.renderDiary();
    this.renderPreps();
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
          this.prepCard.refreshPreview();
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
      { class: "card" },
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
  private renderDiary(focusId = focusedEntryId(), editFocus = focusedEditId()) {
    const focused = document.activeElement;
    const inEditor = focused instanceof HTMLElement && this.diary.contains(focused) && focused.closest("tr.editing") ? focused : undefined;
    const scrollLeft = this.diary.querySelector(".table-wrap")?.scrollLeft ?? 0;
    this.diaryStatus.textContent = this.loading ? "Loading…" : this.listError;
    this.diaryStatus.classList.toggle("error", !this.loading && Boolean(this.listError));
    // With nothing loaded, an error must not read as "Nothing logged today yet".
    const unknown = this.entries.length === 0 && this.deleted.size === 0 && Boolean(this.listError);
    replaceChildren(
      this.diary,
      !unknown &&
        renderDiaryTable({
          entries: this.entries,
          pendingIds: new Set(this.pending.keys()),
          deleted: [...this.deleted.values()],
          busy: this.busy,
          offline: this.connection.state === "offline",
          ...(this.editor ? { editing: this.editor } : {}),
          onEdit: (e) => this.startEditing(e),
          onDelete: (e) => void this.remove(e),
          onUndo: (e) => void this.undoDelete(e),
        }),
    );
    this.diary.querySelector(".table-wrap")?.scrollTo({ left: scrollLeft });
    if (focusId) this.diary.querySelector<HTMLElement>(`[data-entry="${CSS.escape(focusId)}"]`)?.focus();
    else if (editFocus) this.diary.querySelector<HTMLElement>(`[data-entry-edit="${CSS.escape(editFocus)}"]`)?.focus();
    else if (inEditor?.isConnected) inEditor.focus();
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

/** Where the static food index lives: Cloudflare Pages in production (VITE_FOOD_INDEX_URL), else next to the app (public/food-index/ in development). */
const FOOD_INDEX_URL = ((import.meta.env.VITE_FOOD_INDEX_URL as string | undefined)?.trim() || `${import.meta.env.BASE_URL}food-index`).replace(/\/?$/, "/");

/** Products from the Open Food Facts index if it is deployed, otherwise the built-in sample foods. */
async function openProducts(): Promise<FoodCatalog> {
  const index = new StaticFoodCatalog(FOOD_INDEX_URL);
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
  const catalog = new CombinedCatalog(genericsUrl, await openProducts(), `${import.meta.env.BASE_URL}generics-LICENSE.txt`);
  catalog.load().catch((e: unknown) => appLog.warn("Generic foods are unavailable", { error: describeError(e) }));
  return new LoggedFoodsCatalog(catalog);
}

const clientId = getClientId();
if (clientId) void openCatalog().then((catalog) => new App(clientId, catalog));
else renderSetup();
