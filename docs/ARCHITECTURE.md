# Food Diary: architecture

Status: MVP = proof of concept (milestone M0), revised 1 November 2026.
Input: the research brief *Food Diary App — Research Brief* (claude.ai artifact R564ZbBksjMt7uTPWngVyq).

## 1. Goal and ground rules

The app is a food diary with a better logging UI than the Google Health app. **The diary is not stored
here**: it lives in the user's Google Health account (the successor of the Fitbit Web API), and
food definitions come from existing food databases. Meal prep adds one small database for what Google
Health cannot hold, and never copies the diary into it (section 4.5).

* **The Google Health API is the only integration.** The app reads and writes the user's nutrition log
  there and nowhere else. Syncing that log with other platforms is Google Health's job, not the app's.
* **No custom backend, apart from recorded exceptions.** Everything runs in the browser as a static site.
  Where that is not possible, the trade-off is written down in [DECISIONS.md](DECISIONS.md) instead of
  quietly adding a server. The one exception so far is the meal prep API (DR-21).
* **MVP = proof of concept:** sign in, write minimal entries, show the day. Food search,
  long-lived sessions and meals are post-MVP milestones (see [ROADMAP.md](ROADMAP.md)).

## 2. Verified facts

Sources: the API discovery document (`https://health.googleapis.com/$discovery/rest?version=v4`,
revision `20261030`), Google's documentation as indexed by search, and live HTTP probes on
1 November 2026.

| # | Finding | How verified |
|---|---------|--------------|
| V1 | `health.googleapis.com` allows CORS from any origin, with the `authorization` and `content-type` headers and all methods. **The browser can call the API directly.** | Preflight and GET from a foreign origin |
| V2 | **`googlehealth.nutrition.readonly` exists.** Google's authorisation server accepts it, and Google's scopes and nutrition pages list it for `nutrition-log`, `food` and `hydration-log`. The discovery document leaves it out of its method scope lists, which is a gap in that file only. | Authorisation request with a public client: the real scope goes to sign-in, a made-up `googlehealth.bogus.readonly` returns `invalid_scope` |
| V3 | With only `nutrition.writeonly`, reads are implicitly limited to `self-sources` (data this OAuth client wrote). With `readonly`, the default `all-sources` family returns the whole diary: the Google Health app, devices and other apps. | API docs (filters page, list method) |
| V4 | Every data point records its writer in `dataSource.application`: `packageName` for mobile apps, `googleWebClientId` for web clients. The app uses this to tell its own entries (which the write scope lets it delete) from everyone else's. | Discovery document |
| V5 | `dataPoints.create` takes a `DataPoint` whose `name` may carry a client-supplied ID (4–63 chars, `[a-z0-9-]`). It returns an `Operation` (`done`, `response`, `error`). | Discovery document |
| V6 | Day filter: `nutrition_log.interval.civil_start_time >= "YYYY-MM-DD" AND … < "YYYY-MM-DD"`. Results are newest first, paged by `nextPageToken`. | Discovery document |
| V7 | `NutritionLog` fields: `interval` (start/end time plus UTC offsets as durations, e.g. `"39600s"`), `foodDisplayName`, `mealType`, `energy.kcal`, `totalFat`, `totalCarbohydrate`, `nutrients[]` (39-value enum, grams), `serving` (a `food-measurement-unit` reference plus an amount), `food`. There is no free-form metadata field. | Discovery document |
| V8 | Google's token endpoint (`oauth2.googleapis.com/token`) allows CORS, but **refuses to exchange an authorisation code without `client_secret`, even with PKCE** (`invalid_request: client_secret is missing`). | Live POST from a foreign origin |
| V9 | In OAuth *Testing* status, refresh tokens expire after 7 days. In *Production* they last until revoked or unused for about six months. All Google Health scopes are *restricted*: an unverified app is capped at 100 users and needs a security assessment to go beyond that. | Google Health setup docs (via search); one unconfirmed report says unverified production apps also get 7-day tokens (spike B) |
| V10 | Webhooks: a *subscriber* (one HTTPS URL per Cloud project) is registered with the `cloud-platform` scope. Google checks it by POSTing twice: it must answer `201` with the shared secret and `401`/`403` without. The `AUTOMATIC` policy then notifies for every user who consented, so there is no per-user setup. The `Subscription` docs list only altitude, distance, floors, sleep, steps and weight; nutrition-log support is unconfirmed. | Discovery document |

## 3. Components

```mermaid
flowchart LR
  subgraph Browser["Static web app, served from GitHub Pages"]
    UI["UI"] --> Core["Domain core<br/>units · nutrients · food model"]
    UI --> HC["Health client"]
    UI --> FC["FoodCatalog interface"]
    Auth["Google Identity Services<br/>token client"] --> HC
  end
  HC -- "Bearer token, CORS" --> GHAPI["Google Health API v4<br/>nutrition-log = the diary"]
  FC --> Fake["M0: local fake data"]
  FC -. "M1" .-> Index["Static food index<br/>(slimmed OFF export, Cloudflare Pages)"]
  UI -. "M4, planned" .-> Prep["Meal prep API<br/>(Functions and D1, same Cloudflare project)"]
```

| Layer | Folder | Notes |
|---|---|---|
| Domain core | `src/core/` | Pure TypeScript, no I/O, unit-tested. The unit model, the nutrient model (each nutrient maps to an Open Food Facts key and to a Google Health slot), `FoodItem`, the Open Food Facts record normaliser, ID encoding and time helpers. |
| Google Health client | `src/health/` | Thin `fetch` wrapper typed from the discovery document. Maps a `LogDraft` to a `DataPoint` and a `DataPoint` to a `DiaryEntry`. |
| Food data | `src/food/` | `FoodCatalog` interface, implemented in M0 by `LocalFoodCatalog` over fake data (section 6). |
| Auth | `src/auth/` | Google Identity Services token model (section 5). |
| UI | `src/ui/`, `src/main.ts` | Plain TypeScript and DOM. Three screens; no framework yet. |

Hosting is the static build (`vite build`), deployed to GitHub Pages by `.github/workflows/ci.yml`.

## 4. Data model

### 4.1 Food and units

A `FoodItem` stores nutrients **per 100 g or per 100 ml** (its `basis`), plus named portions
(`"1 can" = 375 ml`) and an optional density.

* Any unit or portion converts freely within mass, or within volume. Household units are Australian
  metric: tsp 5 ml, tbsp 20 ml, cup 250 ml.
* Mass ↔ volume conversion happens **only** with an explicit density. Otherwise the UI offers no unit of
  the other kind. We never assume 1 ml = 1 g.
* `fromOffProduct()` turns an Open Food Facts product record into a `FoodItem`. It handles `_100g` values
  that really mean per 100 ml (legacy liquids), per-serving-only data (typical for restaurant items) and
  kJ-only energy. The fake catalogue is written as Open Food Facts records and runs through this
  normaliser, so the future mirror changes the data, not the model.

### 4.2 Diary entry → `nutrition-log`

| Draft | `NutritionLog` field |
|---|---|
| time eaten | `interval.startTime` (+1 min for `endTime`), local offset in `startUtcOffset` / `endUtcOffset` |
| meal | `mealType` (`BREAKFAST`, `LUNCH`, `DINNER`, `SNACK`), left out when the user picks no meal, which is the default. The legacy `ANYTIME` is never written. |
| food name | `foodDisplayName`, e.g. `Rolled oats` or `Cola soft drink (Sample Drinks Co)` |
| amount | `serving` = the API's *gram* or *millilitre* `food-measurement-unit` plus an amount, keeping the kind of unit the user chose (250 g of milk stays 250 g). If the API's units cannot be resolved, the amount goes into the name instead (`Rolled oats (40 g)`). |
| energy | `energy.kcal` (`userProvidedUnit: KILOCALORIE`). The UI shows both kcal and kJ. |
| fat, carbohydrate | `totalFat`, `totalCarbohydrate` (top-level fields) |
| other nutrients | `nutrients[]`: protein, sugars, fibre, saturated, trans, mono- and poly-unsaturated fat, cholesterol, sodium, potassium, calcium, iron, caffeine, vitamin C |

Entries are **anonymous** logs: they supply their own name and nutrients, because our foods are not
Google `food` resources. Anonymous logs cannot be updated, so a future edit is delete and recreate.

### 4.3 Client-supplied IDs carry the food reference

`NutritionLog` has nowhere to store which food an entry came from, so the data point ID carries it:

```
e-<logged-at base36>-<random4>-<source>[-<food id>]     e.g. e-mvxb00vd-9gcl-smp-oats
```

`source` is `off`, `afcd`, `aus` (AUSNUT), `fnds` (USDA FNDDS), `usda`, `smp` (sample) or `man` (manual), so usage per database can be counted from the diary. The food ID is dropped when it does not
fit in 63 characters or is not ID-safe.

### 4.4 Reading the diary

The "Today" list reads **all sources** (with `nutrition.readonly`), so its totals match the Google Health
app. Each row shows its amount (from `serving`). A delete button appears only on this app's entries, because
the write scope covers only data the app added. Other apps' entries show a lock in its place, with a note naming
the app that logged them (the Google Health app or another app's package name), or saying another app did if the
writer is unknown. Deleting asks nothing: the row stays crossed out and out of the totals, with an
Undo that logs an equivalent entry under a new ID (DR-20). If a delete or undo fails, the row is enabled again and
an alert says so until it is dismissed or the action is tried again. If the user unticks the read permission on Google's consent screen, the
app falls back to its own entries and says so.

Food search also reads the newest 300 of this app's own entries (`self-sources`), once per page load in the
background, to favour foods logged before ([FOOD_SEARCH.md](FOOD_SEARCH.md#14-foods-logged-before)).

### 4.5 Meal prep (planned)

Not built yet ([#55](https://github.com/Froussios/fitbit-nutrition-portal/issues/55), DR-21). The user records a recipe when cooking, then logs fractions of it (`1/6`, `25%`) until it is finished or
discarded. Fractions are of the whole batch. Weights are not offered, because the ingredients do not add up to the cooked weight.

**The database adds to the diary and does not mirror it.** A portion is one ordinary diary entry with summed nutrients,
named `Chili (1/6)`, with the ID `e-<time>-<rand>-prep-<prepId>`. Google Health stays the only record of what was eaten.

```sql
preps(user_id, id, name, ingredients_json, created_at, updated_at, discarded_at)  -- PRIMARY KEY (user_id, id)
portions(user_id, id, prep_id, fraction, entry_id, state, eaten_at)               -- PRIMARY KEY (user_id, id)
```

* **Ingredients** keep the nutrients worked out when cooking, because custom foods cannot be reloaded and the weekly
  index can change. Editing them affects later portions only: diary entries cannot be edited.
* **Identity.** The browser sends its Google access token. The API checks with `tokeninfo` that its `aud` is this app's
  client ID, so that a token issued to another app is refused, and takes `healthUserId` from `users/me/identity`. No new
  scopes are needed. It caches the result under a hash of the token until the token expires, so a token revoked earlier still
  works until then. It never stores or logs the token. The user ID never comes from the request.
* **Eating a portion.** An atomic `INSERT … SELECT … WHERE` reserves the portion only if the total stays at or under 100%,
  so two devices cannot overrun it. The app then writes the diary entry, then marks the portion confirmed. If Google
  rejects the entry, the portion is removed. If the answer is lost or the browser closes first, the portion counts as eaten
  and stays unconfirmed. Each diary refresh looks for unconfirmed portions in the listing for the day they were eaten, and
  confirms any it finds. An unconfirmed portion is never released automatically, because its entry may exist; the prep shows
  it, and the user can give it back.
* **Removing a portion.** Deleting one in the diary gives it back, and Undo is refused if it would pass 100%. The diary shows
  only today, so the prep also lists its portions, each with a remove button. Deletes made in the Google Health app
  are not detected; removing the portion from the prep corrects the amount left.
* **Finished and discarded preps** are hidden and kept for 30 days, so that an undo can bring them back, then deleted the
  next time that user's list loads. An unfinished recipe draft stays on the device until it is saved.
* **Failures.** If the API is down, eating is blocked and normal logging still works, as with other failures (DR-18).
* **Deployment.** The Functions live at `/api/*` in the `food-diary-index` Pages project, and `_routes.json` keeps every other
  request static, so food search does not use the Functions allowance. A Pages deploy replaces the whole site, so API changes
  ship only through the Food index workflow, which applies D1 migrations first. Its Cloudflare token needs D1 access as well.

## 5. Authentication

### 5.1 Current: Google Identity Services, token model

A popup returns an access token that lasts about an hour. It is kept in `sessionStorage`. When it expires
the user clicks **Continue**; the popup normally closes by itself because consent is remembered. After
sign-in the app calls `users.getIdentity` to detect `ACCOUNT_NOT_LINKED`.

### 5.2 Long-lived sessions: deferred to milestone 3

Long-lived sessions are strongly preferred but are punted to milestone 3. These are the findings to start
from.

Long-lived access needs a **refresh token**. Google issues those only from the authorisation-code flow,
and for a *Web application* client the code exchange needs the **client secret** (V8). PKCE does not
replace the secret for this client type. This is deliberate: Google treats a browser as a *public client*
that cannot keep a secret, and does not give it refresh tokens that would sit in script-readable storage.
Two more constraints apply to every option:

* While the OAuth app is in **Testing** status, refresh tokens die after 7 days (V9). Long-lived login
  also requires moving the app to **In production**. Unverified, that means a 100-user cap and an
  "unverified app" warning. Verified, it means a security assessment.
* A silent refresh in the background (no click) is not possible with the Google Identity Services token
  model: it needs a user gesture for its popup.

| Option | Long-lived? | What it costs |
|---|---|---|
| A0. Status quo (token model) | No, hourly click | Nothing |
| A1. Client secret shipped in the static app (code + PKCE from the browser; the token endpoint allows CORS) | Yes, in Production status | Breaks Google's rule that web-client secrets stay confidential. Anyone can copy the secret and pose as the app's client. Refresh tokens sit in browser storage. Would fail the security assessment needed above 100 users. |
| A2. Stateless token broker: one serverless function with `/token` (code → tokens) and `/refresh`. It holds the secret and stores nothing; the refresh token stays with the browser (an encrypted HttpOnly cookie is safest). | Yes, in Production status | A deployed function, so a small exception to "no backend", but with no database and no user data at rest. |

Current leaning: A2 plus Production status ([decision D1](https://github.com/Froussios/fitbit-nutrition-portal/issues/22)). The auth layer (`src/auth/`) is the only code this decision
touches: the Health client asks a token provider for a token and does not care how it was obtained.

### 5.3 Why a Google Cloud project is needed

Every Google OAuth client belongs to a Cloud project. The project is how Google identifies the app on the
consent screen, which APIs it may call (the Google Health API must be enabled), its quotas, its
verification status and the origins it may run on. Creating one is free.

* **One project for the app**, owned by the developer. **End users never create one**: they sign in with
  their normal Google account. The client ID is public and baked into the build; the "Developer setup"
  screen only appears in a build without one.
* There is no other way to reach Google Health data in the cloud. The legacy Fitbit Web API, which had its
  own app registration, is switched off on **2 November 2026**.
* Use two projects (development and production): the API has no sandbox.

## 6. Food data

The app **never queries the public Open Food Facts API**. Its read limits (about 15 products and
10 searches per minute per IP) cannot support interactive search. All food access goes through
`FoodCatalog` (`search`, `get`):

* **M0:** `LocalFoodCatalog` over a handful of fake records written in the Open Food Facts format.
* **M1:** search-as-you-type over Open Food Facts using exact words in any order, ranked generic products first, then by how much of
  the product name the query covers (DR-13, DR-15). A weekly GitHub Action slims the Open Food Facts export
  of the whole world dataset (dead rows and unused fields dropped), sorts products in ranking order and
  publishes a sharded word index as static files on Cloudflare Pages (never in git), served at
  `food-index.froussios.com`. The browser runs the search itself but
  fetches only the index files each query needs, never the whole index (data use: FOOD_SEARCH.md section 9.1). ODbL allows this, with
  attribution and share-alike on the database. No server and no monthly cost (DR-14). Generic
  foods come from authoritative sources, AFCD and USDA FNDDS, in a small file searched in the browser (DR-16). Full design: [FOOD_SEARCH.md](FOOD_SEARCH.md).

## 7. Decisions, milestones and spikes

These are maintained separately, so they stay in sync with the GitHub issues:

* [DECISIONS.md](DECISIONS.md): recorded decisions (DR-01…) and open ones (D1 long-lived sessions).
  D2 (live updates) is decided as polling: DR-08; D3 (food data mirror) as DR-14.
* [ROADMAP.md](ROADMAP.md): the MVP (M0) and its targets, post-MVP milestones M1–M4 with their issues, spikes, and
  work saved for later.
