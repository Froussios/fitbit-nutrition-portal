# Decision log

Each decision records what was decided, why, and what would reopen it. Open decisions are GitHub issues
labelled `decision`; when one closes, its outcome is added here. Supporting facts (V1–V10) are in
[ARCHITECTURE.md](ARCHITECTURE.md#2-verified-facts); the plan is in [ROADMAP.md](ROADMAP.md).

## Open

| ID | Question | Milestone | Issue | Current leaning |
|---|---|---|---|---|
| D1 | How to provide long-lived sessions | M3 | [#22](https://github.com/Froussios/fitbit-nutrition-portal/issues/22) | Stateless token broker (option A2) plus OAuth app in Production |
| D3 | Design of the food data mirror | M1 | [#9](https://github.com/Froussios/fitbit-nutrition-portal/issues/9) | A slimmed, pre-sorted word index of the whole world dataset, built weekly by a GitHub Action and deployed as static files to Cloudflare Pages (~350–600 MB, under 20,000 files). Never committed to git: every rebuild would stay in the history (owner, 2 Nov 2026). Search runs in the browser, which fetches only the few small files each query needs (tens of KB), never the index; no server, so no DR-01 exception. The same engine can move into a free Cloudflare Worker if mobile latency needs it. Owner requirements (2 Nov 2026): no monthly bill; whole world dataset (Australian tagging is incomplete); the dataset may be slimmed; exact-word matching (DR-13); the browser must not download the dataset. Free database tiers (D1, Supabase, Turso) cannot hold or rebuild the whole dataset. See [FOOD_SEARCH.md](FOOD_SEARCH.md#5-hosting-and-execution-r7-decision-d3). |

## Decided

### DR-01 No custom backend
**Decision.** The app is a static site. Everything runs in the browser. A server-side component is allowed
only as a recorded exception here, and must be stateless (no user data at rest).
**Why.** Owner requirement: keep all data in existing services, with no database of our own.
**Reopen if.** A required capability has no client-side or build-time path (D1 may add the first exception).

### DR-02 The Google Health API is the only integration
**Decision.** The app reads and writes only the user's Google Health `nutrition-log`. Health Connect,
Android companions and the legacy Fitbit Web API are out of scope.
**Why.** Google Health syncs with other platforms itself. The legacy API is switched off on
2 November 2026.
**Reopen if.** Google Health stops syncing nutrition where the owner needs it.

### DR-03 The browser calls the Google Health API directly
**Decision.** No proxy. The Health client uses `fetch` with a bearer token.
**Why.** The API allows CORS from any origin (V1).

### DR-04 Read the whole diary; write and delete only our own entries
**Decision.** Request `googlehealth.nutrition.readonly` and `googlehealth.nutrition.writeonly`. Show
all sources; offer delete (and later edit) only on entries whose `dataSource.application.googleWebClientId`
is ours. If the user withholds the read scope, fall back to our own entries with a notice.
**Why.** Totals must match the Google Health app (V2, V3). The write scope covers only data the app added (V4).

### DR-05 Entries are anonymous logs; the ID carries the food reference; the amount goes in `serving`
**Decision.** Each entry carries its own name and nutrients (our foods are not Google `food` resources).
Client-supplied IDs `e-<time>-<rand>-<source>[-<foodId>]` record which food it was. The amount goes in
`serving` (the API's gram or millilitre unit, keeping the kind of unit the user chose); only if that unit
cannot be resolved does the amount go into the display name.
**Why.** `NutritionLog` has no metadata field (V7); IDs enable "log again" and meals without a database.
**Consequence.** Anonymous logs cannot be updated: edit = delete and recreate ([#17](https://github.com/Froussios/fitbit-nutrition-portal/issues/17), [#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18)).
**Reopen if.** Identified logs become practical ([#29](https://github.com/Froussios/fitbit-nutrition-portal/issues/29)).

### DR-06 Unit model
**Decision.** Foods store nutrients per 100 g or per 100 ml, plus named portions. Mass↔volume conversion
only with an explicit density. Household measures are Australian metric (tsp 5 ml, tbsp 20 ml, cup 250 ml).
**Why.** Sources differ in basis; assuming 1 ml = 1 g is wrong by up to about 2× for some foods.

### DR-07 Food data behind `FoodCatalog`; never query the public Open Food Facts API
**Decision.** All food access goes through `FoodCatalog` (`search`, `get`). M0 uses local fake data in
the Open Food Facts record format. Real data comes from a mirror (D3), never from live Open Food Facts calls.
**Why.** Open Food Facts allows about 10 searches and 15 product reads per minute per IP, far too few for
interactive search.

### DR-08 Live updates by polling
**Decision.** Refetch on tab focus and every 5 minutes while the tab is visible. No webhooks or push.
**Why.** Webhooks need a verified HTTPS endpoint per project and a server-held key to reach browsers
(V10). Polling costs one list call per poll, far below the 300 requests/min/user limit.
**Reopen if.** Multi-device use makes polling feel stale ([#10](https://github.com/Froussios/fitbit-nutrition-portal/issues/10)).

### DR-09 Authentication: Google Identity Services token model for now
**Decision.** Short-lived access tokens from a Google popup, kept in `sessionStorage`; the user clicks
Continue about hourly. Long-lived sessions are deferred to M3, after the MVP (D1).
**Why.** Refresh tokens need the client secret for web clients, even with PKCE (V8), so they need a server
or a policy-breaking shortcut. Not worth it before the product is usable.

### DR-10 One Google Cloud project for the app; users never create one
**Decision.** The developer owns the Cloud project and OAuth client (separate dev and prod projects). The
public client ID is built in (`VITE_GOOGLE_CLIENT_ID`); a developer setup screen appears only in builds
without it.
**Why.** Every Google OAuth client belongs to a Cloud project; there is no other way to reach Google
Health data from the web.

### DR-11 The MVP is the proof of concept
**Decision.** The MVP is M0: sign in, write minimal entries, display the day. Food search (M1), daily-driver
features (M2), long-lived sessions (M3) and custom meals (M4) are post-MVP milestones.
**Why.** Owner decision: prove the Google Health API round trip first; meals also depend on real food
data (M1).

### DR-12 Food search starts with Open Food Facts only
**Decision.** M1 food search indexes Open Food Facts products only. Generic foods (AUSNUT / OpenNutrition)
are parked ([#38](https://github.com/Froussios/fitbit-nutrition-portal/issues/38)).
**Why.** Owner decision (2 November 2026): one source first, to get search working end to end.
**Reopen if.** The coverage test ([#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15)) finds fewer than 45 of 50 items, or generic foods are a frequent miss.

### DR-13 Food search matches exact words, ranked by coverage
**Decision.** No typo tolerance. Every query word must appear in the product's name or brand, in any order;
the last word matches as a prefix while typing. Results rank by coverage (query words in the name divided by
words in the name), then popularity: "chocolate" ranks a product called "Chocolate" above "Dark chocolate".
**Why.** Owner decision (2 November 2026): it lets a pre-sorted static index serve search for free, with no
search engine or server ([FOOD_SEARCH.md](FOOD_SEARCH.md#4-matching-and-ordering-r3)).
**Reopen if.** Misspellings or word-form misses are common in the coverage test ([#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15)) or daily use; try
the cheap helpers (synonyms, "did you mean", plurals) first.
