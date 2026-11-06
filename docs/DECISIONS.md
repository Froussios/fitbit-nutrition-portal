# Decision log

Each decision records what was decided, why, and what would reopen it. Open decisions are GitHub issues
labelled `decision`; when one closes, its outcome is added here. Supporting facts (V1–V10) are in
[ARCHITECTURE.md](ARCHITECTURE.md#2-verified-facts); the plan is in [ROADMAP.md](ROADMAP.md).

## Open

| ID | Question | Milestone | Issue | Current leaning |
|---|---|---|---|---|
| D1 | How to provide long-lived sessions | M3 | [#22](https://github.com/Froussios/fitbit-nutrition-portal/issues/22) | Stateless token broker (option A2) plus OAuth app in Production |

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
the Open Food Facts record format. Real data comes from our own index (D3, decided as DR-14), never from live Open Food Facts calls.
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
Revised by DR-16.
**Decision.** M1 food search indexes Open Food Facts products only. Generic foods (AUSNUT / OpenNutrition)
are parked ([#38](https://github.com/Froussios/fitbit-nutrition-portal/issues/38)).
**Why.** Owner decision (2 November 2026): one source first, to get search working end to end.
**Reopen if.** The coverage test ([#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15)) finds fewer than 45 of 50 items, or generic foods are a frequent miss.

### DR-13 Food search matches exact words, ranked by coverage
Ordering revised by DR-15.
**Decision.** No typo tolerance. Every query word must appear in the product's name or brand, in any order;
the last word matches as a prefix while typing. Results rank by coverage (query words in the name divided by
words in the name), then popularity: "chocolate" ranks a product called "Chocolate" above "Dark chocolate".
**Why.** Owner decision (2 November 2026): it lets a pre-sorted static index serve search for free, with no
search engine or server ([FOOD_SEARCH.md](FOOD_SEARCH.md#4-matching-and-ordering-r3)).
**Reopen if.** Misspellings or word-form misses are common in the coverage test ([#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15)) or daily use; try
the cheap helpers (synonyms, "did you mean", plurals) first.

### DR-14 Food index: a static, pre-sorted word index on Cloudflare Pages
**Decision.** Closes D3 ([#9](https://github.com/Froussios/fitbit-nutrition-portal/issues/9)). A weekly GitHub Action slims the whole Open Food Facts export, numbers products
in ranking order and deploys a sharded word index (195 MB, 18 k files) to the Cloudflare Pages project
`food-diary-index`, served at `https://food-index.froussios.com/`. Search runs in the browser and fetches only
the files a query needs. The index is never committed to git. Design: [FOOD_SEARCH.md](FOOD_SEARCH.md).
**Why.** Owner requirements (2 November 2026): no monthly bill, the whole world dataset, no download of the
dataset to the browser, and no index in git history (each rebuild would stay there for good). With
exact-word matching (DR-13) a pre-sorted static index needs no server, so DR-01 holds without an exception.
Free database tiers could not hold or rebuild the dataset; paid search hosting was ruled out on cost. The
custom domain replaced `*.pages.dev` after the University of Sydney's firewall was found intercepting it.
**Reopen if.** Typo tolerance becomes a requirement (Meilisearch on a home server is the documented path),
the index outgrows Cloudflare Pages' 20,000 files, or mobile latency needs the engine in a Worker.

### DR-15 Food search assumes the generic product
Where generic foods come from, and the order of products with no brand, revised by DR-16.
**Decision.** Unless given evidence otherwise, assume the generic product. Whole-word matches in the name come
first; among them, products the query uses up entirely, then products where a query word is the food and not its
flavour (judged by word position), then products with no brand before branded ones, then the fewest name words the
query does not account for; ties go to the name with the most entries; products that only matched on their brand come last
([FOOD_SEARCH.md](FOOD_SEARCH.md#43-ordering)). Rows with no brand are labelled Generic, and products with no
brand and the same name are collapsed to one. Motivation in full: [#41](https://github.com/Froussios/fitbit-nutrition-portal/issues/41).
**Why.** Owner decision (5 November 2026). Brands often name a product after a flavour, so results looked
arbitrary: searching `vanilla` ranked `Coyo (Vanilla bean)` third. A product the query uses up comes first because
there is nothing more to type to reach it: `Vegemite (Vegemite)` can't be reached by a more specific search.
**Consequence.** The index stores three lists per word (food, rest of name, brand only), which ranks products
without fetching their text. Index format 3. "No brand" is the only available signal for generic, and it is an imperfect one.
**Reopen if.** Unbranded entries prove too unreliable to rank first; a popularity floor or real generic data
([#38](https://github.com/Froussios/fitbit-nutrition-portal/issues/38)) would be the next step.

### DR-16 Generic foods come from authoritative sources, in a small file searched in the browser
**Decision.** Generic foods come from AFCD (FSANZ) and USDA FNDDS, concatenated into one committed file of about
310 KB gzipped that the browser downloads once and searches locally, and they are shown first. Open Food Facts holds
products: those with no brand are labelled "No brand listed", rank below branded ones, and no longer count as
generic. Every row shows a tag naming its source. Sources are never joined on names and their values are never
combined. USDA foods appear only when AFCD has fewer than 3 foods where a query word is the food. Only authoritative
sources are added, and each diary entry's ID records its source
([FOOD_SEARCH.md](FOOD_SEARCH.md#13-generic-foods)).
**Why.** Owner decisions (5 November 2026). Open Food Facts' crowdsourced entries disagree and many are wrong:
unbranded `Vegemite` says 9 kcal, `Dark chocolate` 1 kcal. The tag lets the owner tell which database causes a
problem. Name matching fails even within one agency (AFCD and AUSNUT share 1,201 keys, 482 of them with the same
name), and authorities' values differ for real reasons. FNDDS is included because US sources are acceptable if they
are high quality, and it finds foods AFCD lacks.
**Consequence.** AFCD's licence requires its statements to travel with the data (`public/generics-LICENSE.txt`).
Only the Australian foods have few serving measures until AUSNUT is added.
**Reopen if.** FSANZ confirms AUSNUT 2023 can be redistributed
([#38](https://github.com/Froussios/fitbit-nutrition-portal/issues/38)), or the file grows enough to matter.

### DR-17 An entry has no meal unless the user picks one
**Decision.** The form preselects "No meal" and the app then leaves `mealType` out of the entry. Breakfast, lunch,
dinner and snack stay available, and the form returns to "No meal" after each entry, so a meal never carries over
unnoticed. The app no longer guesses the meal from the time of day, and no longer offers or writes `ANYTIME`.
**Why.** Owner decision (6 November 2026). The API marks `mealType` as optional, and describes `ANYTIME` as legacy
while listing only the other four values for this field.
**Consequence.** Entries logged without a meal cannot gain one later except by deleting and logging them again:
Google does not allow editing logs created from a typed-in food. The diary shows them with a dash.
**Reopen if.** Google Health rejects or misplaces entries with no meal.

### DR-18 No offline queue: the app assumes a connection and says when it has none
**Decision.** Entries are never queued or stored on the device. While the browser reports offline, a banner says
logging will not work and nothing is saved on the device, logging and deleting are disabled, and background refreshes
wait until it is back. When requests only go unanswered, the banner says logging may not work and the controls stay
enabled, because that can be a blip and trying is how the app finds out it has passed.
What the user typed stays in the form. Automatic retries are out too.
**Why.** Owner decision ([#20](https://github.com/Froussios/fitbit-nutrition-portal/issues/20), 6 November 2026): this is a website, so assume a connection, and if there
is none, fail cleanly and show it.
**Consequence.** A write whose answer is lost may still have been saved, and logging again sends a new ID, so it would
create a second entry. The error therefore asks the user to check the diary first. Client-supplied IDs still carry the
food reference, but nothing relies on them for idempotency.
**Reopen if.** Logging without a connection becomes a real need, for example once the app is an installed PWA ([#16](https://github.com/Froussios/fitbit-nutrition-portal/issues/16)).
