import "./styles.css";
import { GoogleAuth, SignInRequiredError } from "./auth/google-auth";
import { getClientId, isClientIdBuiltIn, NUTRITION_READ_SCOPE, NUTRITION_WRITE_SCOPE, SCOPES, setClientId } from "./config";
import { foodLabel } from "./core/food";
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
import { buildNutritionLogPoint, byTime, copyNutritionLogPoint, editedNutritionLogPoint, findServingUnits, reconcilePending, toDiaryEntries, toDiaryEntry, toLoggedFoods, withoutEntries, type DiaryEntry, type DiaryContext, type EntryEdit, type LogDraft } from "./health/mapping";
import type { DataPoint } from "./health/types";
import { renderDiaryTable } from "./ui/diary-table";
import { el, errorMessage, replaceChildren } from "./ui/dom";
import { getEnergyUnit, setEnergyUnit, type EnergyUnit } from "./ui/energy-unit";
import { createLogForm, type LogForm } from "./ui/log-form";
import { createRowEditor, type RowEditor } from "./ui/row-editor";
import { createDebugPanel } from "./ui/debug-panel";
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

  private readonly connection: ConnectionMonitor;
  /** Kept across renders, so a change in connection does not disturb what the user is typing. */
  private readonly connectionNotice = el("p", { class: "notice", role: "alert", hidden: true });
  private readonly form: LogForm;
  /** The diary row being edited. Its controls outlive redraws of the table, so a refresh keeps what the user typed. */
  private editor?: RowEditor;
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
      if (draft.food.ref.source !== "manual") {
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
    try {
      const { key, created } = await this.write(point);
      this.deleted.delete(entry.id);
      this.catalog.merge(toLoggedFoods([created], this.clientId));
      const restored = toDiaryEntry(created, this.diaryContext());
      if (restored) this.entries = [...this.entries, restored].sort(byTime);
      if (hadFocus) focusId = key;
    } catch (e) {
      appLog.error("Undoing the delete failed", describeError(e));
      this.handleError(e, false);
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
    this.startRowAction(entry, "saving…");
    this.editor?.setSaving(true);
    const point = editedNutritionLogPoint(log, edit, { id: copiedEntryId(entry.id), servingUnits: this.servingUnits, unitNames: this.unitNames });
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
      this.editor?.setSaving(false);
      this.renderDiary();
      this.editor?.focusSave();
      return;
    }
    const { key, created } = written;
    // No wait since the write: a listing that still has the original must not match the replacement to it (a meal-only edit looks the same).
    this.deletedIds.add(entry.id);
    this.catalog.merge(toLoggedFoods([created], this.clientId));
    const replacement = toDiaryEntry(created, this.diaryContext());
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), ...(replacement ? [replacement] : [])].sort(byTime);
    this.stopEditing();
    this.renderDiary(undefined, key);
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
