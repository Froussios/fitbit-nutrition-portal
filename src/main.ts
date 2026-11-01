import "./styles.css";
import { GoogleAuth, SignInRequiredError } from "./auth/google-auth";
import { getClientId, getExtraScopes, isClientIdBuiltIn, NUTRITION_SCOPE, requestedScopes, setClientId, setExtraScopes } from "./config";
import { idFromName, newEntryId } from "./core/ids";
import { civilDate } from "./core/time";
import type { BaseUnit } from "./core/units";
import { SAMPLE_FOODS } from "./data/sample-foods";
import { HealthApiError, HealthClient } from "./health/client";
import { buildNutritionLogPoint, findServingUnits, toDiaryEntries, type DiaryEntry, type LogDraft } from "./health/mapping";
import type { DataPoint } from "./health/types";
import { renderDiaryTable } from "./ui/diary-table";
import { el, errorMessage, replaceChildren } from "./ui/dom";
import { createLogForm } from "./ui/log-form";

/** Refetch interval while the tab is visible: the client-only stand-in for webhook pushes. */
const POLL_MS = 5 * 60_000;

const root = document.getElementById("app")!;

class App {
  private readonly auth: GoogleAuth;
  private readonly api: HealthClient;
  private servingUnits: Partial<Record<BaseUnit, string>> = {};
  /** Points written this session that a list call has not returned yet (the API may lag). */
  private readonly pending = new Map<string, DataPoint>();
  private entries: DiaryEntry[] = [];
  private notice = "";
  private signInError = "";
  private loading = false;
  private listError = "";
  private ready = false;

  private readonly form = createLogForm(SAMPLE_FOODS, (d) => this.log(d));
  private readonly diary = el("div", { class: "diary" });
  private readonly diaryStatus = el("p", { class: "status", role: "status" });

  constructor(clientId: string) {
    this.auth = new GoogleAuth(clientId, requestedScopes(), [NUTRITION_SCOPE]);
    this.api = new HealthClient((o) => this.auth.getAccessToken(o));
    this.auth.onChange(() => this.render());

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
      this.signInError = errorMessage(e);
      this.render();
    }
  }

  private async afterSignIn() {
    this.notice = "";
    try {
      await this.api.getIdentity();
    } catch (e) {
      if (e instanceof HealthApiError && e.accountNotLinked) {
        this.notice =
          "Your Google account is not linked to Google Health yet. Install the Google Health app, sign in there once, then press Refresh.";
      } else return this.handleError(e);
    }
    // Serving units are optional: without them entries carry no `serving` field.
    try {
      this.servingUnits = findServingUnits(await this.api.listFoodMeasurementUnits());
    } catch (e) {
      console.info("food-measurement-unit list not available; logging without serving.", e);
    }
    this.ready = true;
    this.render();
    await this.loadToday();
  }

  private async loadToday() {
    if (this.loading) return;
    this.loading = true;
    this.listError = "";
    this.renderDiary();
    try {
      const points = await this.api.listNutritionLogs(civilDate(new Date()));
      for (const p of points) if (p.name) this.pending.delete(idFromName(p.name));
      const today = civilDate(new Date());
      const pending = [...this.pending.values()].filter((p) => civilDate(new Date(p.nutritionLog!.interval.startTime)) === today);
      this.entries = toDiaryEntries([...points, ...pending]);
    } catch (e) {
      this.listError = errorMessage(e);
      this.handleError(e, false);
    } finally {
      this.loading = false;
      this.renderDiary();
    }
  }

  private async log(draft: LogDraft) {
    const id = newEntryId(draft.food.ref);
    const point = buildNutritionLogPoint(draft, { id, servingUnits: this.servingUnits });
    try {
      const op = await this.api.createNutritionLog(point);
      if (op.error) throw new Error(op.error.message ?? "Google Health rejected the entry.");
      this.pending.set(id, op.response?.nutritionLog ? { ...point, ...op.response } : point);
    } catch (e) {
      this.handleError(e, false);
      throw e;
    }
    await this.loadToday();
  }

  private async remove(entry: DiaryEntry) {
    if (!confirm(`Delete "${entry.displayName}" from Google Health?`)) return;
    try {
      await this.api.deleteNutritionLogs([entry.name]);
      this.pending.delete(entry.id);
      this.entries = this.entries.filter((e) => e.id !== entry.id);
      this.renderDiary();
    } catch (e) {
      this.handleError(e);
    }
    await this.loadToday();
  }

  private handleError(e: unknown, rerender = true) {
    if (e instanceof SignInRequiredError) {
      this.ready = false;
      this.render();
      return;
    }
    console.error(e);
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
      );
      return;
    }

    replaceChildren(
      root,
      header,
      this.notice && el("p", { class: "notice" }, this.notice),
      this.ready ? this.form : el("p", { class: "status" }, "Connecting to Google Health…"),
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
            "Google Health only grants this app write access to nutrition, so this list shows the entries this app logged. " +
              "Entries from the Google Health app or other apps are not visible here.",
          ),
        ),
    );
    this.renderDiary();
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
  const scopes = el("input", { id: "extra-scopes", type: "text", value: getExtraScopes().join(" "), autocomplete: "off", spellcheck: "false" });
  const form = el(
    "form",
    { class: "card setup" },
    el("h2", {}, "Set up"),
    el(
      "p",
      {},
      "This app runs entirely in your browser and talks to the Google Health API with your own Google Cloud OAuth client. " +
        "Create a Web application client, add this page's origin (",
      el("code", {}, location.origin),
      ") to its Authorized JavaScript origins, and paste its client ID here. See the README for the full steps.",
    ),
    el("label", { class: "field", for: "client-id" }, el("span", {}, "OAuth client ID"), clientId),
    el("details", {}, el("summary", {}, "Advanced"), el("label", { class: "field", for: "extra-scopes" }, el("span", {}, "Extra OAuth scopes (space separated, for experiments)"), scopes)),
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
    setExtraScopes(scopes.value);
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    location.reload();
  });
  replaceChildren(root, el("header", { class: "top" }, el("h1", {}, "Food Diary")), form);
}

const clientId = getClientId();
if (clientId) new App(clientId);
else renderSetup();
