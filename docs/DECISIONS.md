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
Revised by DR-24: meal prep may keep user data in a database, so its API is not stateless. Everything else stays as below.
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
all sources; offer edit and delete only on entries whose `dataSource.application.googleWebClientId`
is ours. If the user withholds the read scope, fall back to our own entries with a notice.
**Why.** Totals must match the Google Health app (V2, V3). The write scope covers only data the app added (V4).

### DR-05 Entries are anonymous logs; the ID carries the food reference; the amount goes in `serving`
**Decision.** Each entry carries its own name and nutrients (our foods are not Google `food` resources).
Client-supplied IDs `e-<time>-<rand>-<source>[-<foodId>]` record which food it was. The amount goes in
`serving` (the API's gram or millilitre unit, keeping the kind of unit the user chose); only if that unit
cannot be resolved does the amount go into the display name.
**Why.** `NutritionLog` has no metadata field (V7); IDs enable "log again" and meals without a database.
**Consequence.** Anonymous logs cannot be updated, so an edit writes a corrected copy and deletes the original (DR-22).
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

### DR-09 Authentication: short-lived tokens from a Google popup for now
Revised by DR-24: the popup also returns an ID token, and the app asks Google directly because Google's token client cannot.
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
the index outgrows Cloudflare Pages' 20,000 files, or latency needs the engine in a Worker.

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
**Consequence.** Google does not allow editing logs created from a typed-in food, so giving an entry a meal later
replaces it with a copy (DR-22). The diary shows entries with no meal with a dash.
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
**Reopen if.** Logging without a connection becomes a real need.

### DR-19 Food search favours foods the user logged before, from a short look at the history
**Decision.** The last 20 distinct foods logged, and anything logged in the last 2 weeks, go first in the suggestions
whenever they match. Any other logged food goes next, in at most 3 rows, and only if it is a good match: a query word
is the food, not its flavour or brand. These rows go ahead of generic foods. History comes from one request for the
newest 300 entries this app wrote, in the background, and is not stored between page loads
([FOOD_SEARCH.md](FOOD_SEARCH.md#14-foods-logged-before)).
**Why.** Owner decision (6 November 2026): recently logged products are likely to be what the user wants to log again,
and the history must not be searched exhaustively, because that can be expensive and block the main path.
**Consequence.** A logged food can outrank a better match, and a wrong entry stays boosted until it is deleted. Foods
logged in other apps and custom foods can't be boosted, because the catalogue can't load them again.
**Reopen if.** One page proves too short or too slow in daily use, or the boosts crowd out foods the user wants.


### DR-20 Deleting asks nothing, and can be undone until the page is reloaded
**Decision.** The delete button acts at once. The entry stays in the diary, crossed out and tagged, and no longer counts
towards the totals. Its button becomes Undo, which logs an equivalent entry: same food, time, meal and nutrients, under a
new ID. Deleted rows are kept in memory only, until the page is reloaded, the user signs out or the day changes.
**Why.** Owner decision ([#53](https://github.com/Froussios/fitbit-nutrition-portal/issues/53), 7 November 2026): feedback and a way back cost less attention than a question every time.
A new ID because whether a deleted ID can be reused is still open ([#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18)).
**Consequence.** Undo cannot restore the original data point: the copy has a new ID, and the Google Health app sees a
delete and a new entry. As with logging (DR-18), an undo whose answer is lost may still have been saved, so the error asks
the user to check the diary first. A reload ends the chance to undo.
A row is disabled while its delete or undo is under way, and enabled again if it fails, with an alert in the diary that
stays until it is dismissed or the action is tried again, so that a refresh cannot hide it.
**Reopen if.** Deleted entries need to survive a reload, or [#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18) shows that the original ID can be reused.

### DR-21 Energy is shown in one unit, chosen in the page header
**Decision.** The diary, the log form's preview and the food search show energy in either kcal or kJ, not both. A control
in the page header chooses which, kcal by default, and the choice is kept in `localStorage` on each device. Google Health
still stores kcal. A custom food's energy can still be typed in either unit, whatever the setting.
**Why.** Owner decision (7 November 2026): the two are the same information, so showing both wastes a column. kcal is the
default because it is what Google Health stores and what the food search already showed.
**Consequence.** The setting does not follow the user to another device or browser.
**Reopen if.** The app gets more settings than the header can hold, or the choice needs to follow the user across devices.

### DR-22 Editing replaces the entry, and recalculates from the food's record when it can
**Decision.** An entry's amount and meal can be edited, on this app's own entries, in the diary row itself. Its nutrient
cells follow what is typed, and Save and Cancel take the place of the edit and delete buttons. Time and food cannot be
edited. Saving writes a corrected copy under a new ID, then deletes the original. For a new amount, nutrients are calculated again from the food's
record, found through the reference in the entry's ID. With no record (a custom food, or a failed lookup), the logged values
are scaled. A meal-only edit copies the logged values. Any entry offers the units of the kind it was logged in; a food found
in the catalogue adds its named portions, and the other kind of unit if it has a density.
**Why.** Owner decisions ([#17](https://github.com/Froussios/fitbit-nutrition-portal/issues/17), 7 November 2026). Logs cannot be updated (DR-05). Writing first means a failure cannot
lose the entry. The record gives exact values, while the logged ones are rounded to 0.1 mg: scaling 40 g to 400 g leaves iron
typically 5% out, and a value rounded to 0 stays 0. A new ID because whether a deleted ID can be reused is still open ([#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18)).
**Consequence.** If the delete fails, both entries stay in the diary and both count in the totals, with an alert saying to
delete the old one. If a food's record has changed since logging, an amount edit takes the new values. The unit originally
chosen is not stored, so "1 × can" reopens as 375 ml. There is no Undo for an edit: the user edits the entry back. The
Google Health app sees a delete and a new entry. An amount can be changed if the entry states one in g or ml, or if its food
is found. Otherwise, as with a meal prep portion, only the meal can be changed, and the debug log says why. Google does not
specify how it words its unit names, so they are read loosely, and how real entries word them is still to be confirmed.
**Reopen if.** Identified logs become practical ([#29](https://github.com/Froussios/fitbit-nutrition-portal/issues/29)), or scaling turns out to be common because lookups fail or Google does not keep our IDs.

### DR-23 The app is for desktop browsers; phones are not a requirement
**Decision.** The app targets current desktop browsers. Working on a phone, installing as an app and scanning barcodes with
a camera are not requirements, and changes need no phone testing. The installable app ([#16](https://github.com/Froussios/fitbit-nutrition-portal/issues/16)) is not planned. Existing layout
that happens to suit phones stays until there is a reason to change it.
**Why.** Owner decision (7 November 2026): Google Health already has a phone app.
**Consequence.** Barcode lookup ([#36](https://github.com/Froussios/fitbit-nutrition-portal/issues/36)) is manual entry only. Users still need the Google Health phone app once, to link their account:
that is Google's requirement, not ours.
**Reopen if.** The owner wants to log from a phone in this app.

### DR-24 Meal prep keeps its recipes in a database, in the food index's Cloudflare project
**Decision.** One-off meal prep ([#55](https://github.com/Froussios/fitbit-nutrition-portal/issues/55)) stores recipes and what is left of them in a Cloudflare D1 database, behind Pages Functions
in the existing `food-diary-index` project and `food-index.froussios.com` domain. Every row belongs to one user: there are
no shared recipes. The database adds to the Google Health API and does not mirror it: the diary stays in Google Health,
and a logged portion is one ordinary entry there. The database keeps only the portion's fraction, entry ID, state and
time, never its nutrients ([design](ARCHITECTURE.md#45-meal-prep-planned)).
**Why.** Owner decisions (7 November 2026). Recipes must sync across devices, and Google Health has nowhere to hold them
(V7). Browser storage stays on one device and can be cleared. Google Drive's app-data folder was considered and rejected.
Reusing the project and domain avoids new hosting, and the domain avoids the firewall that intercepts `*.pages.dev`
(DR-14).
The API identifies users by a Google ID token, because a token that can use the diary must not reach it. One sign-in
returns both tokens (V11), so a second sign-in is not needed.
**Consequence.** This is the first server and the first user data at rest, an exception to DR-01. The app's sign-in
moves off Google's token client, which never returns an ID token, to its own popup and callback page (revising DR-09),
although Google recommends its library for this flow. Both tokens last 60 minutes, so **Continue** renews both. A Pages deploy replaces the whole site, so an API change ships only with the Food index workflow, and a rollback there
covers both. Recipes can be lost with the database; D1's Time Travel covers the last 7 days, and the diary is unaffected.
**Reopen if.** Shipping the API with the index becomes a real obstacle, or the free limits are reached.

### DR-25 Amounts are typed as free text, read by fixed rules, and a unit is never decided after the number
**Decision.** Amount is a text field in the log form and the row editor. Fixed rules read numbers, fractions, unit names and
the food's portions: `90 g`, `1 1/2 cups`, `two and a half cups`, `2 × can`. On leaving the field or pressing Enter, the number stays
in Amount and the unit moves to Unit. A bare number uses the unit that was already showing when it was typed. If none was
showing because the food was still loading, Unit stays blank and asks, and nothing logs until the user chooses. A food's
own portion beats a metric cup, tablespoon or teaspoon, and exact weights and volumes beat portions. What the rules cannot
read for certain is refused with a reason: several different cups, `1,5`, `1-2 cups`, `T`.
**Why.** Owner requirement ([#64](https://github.com/Froussios/fitbit-nutrition-portal/issues/64)): entry should be fluent, and processing deterministic where possible. Owner decision (7 November 2026):
telling the user the unit after they entered the amount is wrong, so `90` means 90 cups only if cups was already visible.
**Consequence.** `1 cup` is refused on the 46% of generic foods with no cup portion and no density, because DR-06 forbids
assuming one. The number spinner and arrow-key stepping are gone. A readable amount logs on the first Enter, so the unit
showing is what counts.
**Reopen if.** Refused input turns out to be common in real use.

### DR-26 An on-device model can read what the rules refuse, behind a setting, and cannot supply a number or a guess
**Decision.** A "Use AI processing of input" tickbox in the page header turns on Chrome's built-in model. It is off by default,
kept in `localStorage` on each device, and ticking it starts the model's download, with progress shown. Unticked, the model is
never used, even if installed. If the browser or computer cannot run it, the box is disabled with the reason. The model is
asked only when the user has finished typing and the rules have refused the text as unreadable or naming no known unit. Its
answer fills the fields and says where it came from, and logging it takes another Enter.
**Why.** Owner requirements ([#64](https://github.com/Froussios/fitbit-nutrition-portal/issues/64)): use an LLM only if one is available locally, and it must use only what was typed, not guess that sugar
is usually measured in cups. Owner decision (7 November 2026): the download starts when the setting is ticked. Chrome's model
is the only one a static site can reach without a server.
**How it cannot guess.** This is enforced in `core/amount-answer.ts`, not left to the prompt. A bare number never reaches the
model. The food's name is never sent, only the typed text and the food's units. The model must quote the words it read: the
quote must be in the text, and spelled close enough to the chosen unit to be a typing mistake, so `1 scoop` cannot become a cup.
Its number counts only if the rules read the quoted words as that number, and the rules' number is the one used. Every other
typed word must be accounted for, so `1-2 cups` and `about 2 cups` are refused.
**Consequence.** Since numbers have to be readable by the rules, phrases such as `two and a half` moved into the rules, which
leaves the model typos and odd word order. Chrome 148+ on desktop only, with 22 GB free, and more than 4 GB of VRAM or 16 GB of
RAM with 4+ cores. Unticking does not delete the model, which Chrome manages. The debug log records each question and answer,
to judge how well the model does. Not yet tried against the real model.
**Reopen if.** The model turns out too unreliable to be worth keeping, or the header runs out of room for settings (DR-21).
