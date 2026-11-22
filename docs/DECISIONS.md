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
Ordering revised by DR-15. A loose search runs when nothing matches exactly: DR-30.
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
Which USDA foods are shown, and their order, revised by DR-34.
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
dinner and snack stay available. The meal picked stays picked for the next entry, until the user changes it or
reloads the page, since consecutive entries are usually from the same meal. Everything else empties once an entry is
logged: the food, amount and custom food (but for its energy unit, which stays too), the portion and prep, or the
saved meal, so the form starts again from the search. A portion that counts as eaten despite an error leaves the prep chosen beside the message, with the portion
cleared. The app no longer guesses the meal from the time of day, and no longer offers or writes `ANYTIME`.
**Why.** Owner decision (6 November 2026). The API marks `mealType` as optional, and describes `ANYTIME` as legacy
while listing only the other four values for this field. The form first returned to "No meal" after each entry; the
owner reversed that (18 November 2026), because logging a meal usually takes several entries in a row. The food and
amount first stayed after an entry, as if to log the same again; the owner asked for them to clear (20 November 2026).
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
Revised by DR-40: the control is in the settings panel behind the header's gear.
**Decision.** The diary, the log form's preview and the food search show energy in either kcal or kJ, not both. A control
in the page header chooses which, kcal by default, and the choice is kept in `localStorage` on each device. Google Health
still stores kcal. A custom food's energy can still be typed in either unit, whatever the setting.
**Why.** Owner decision (7 November 2026): the two are the same information, so showing both wastes a column. kcal is the
default because it is what Google Health stores and what the food search already showed.
**Consequence.** The setting does not follow the user to another device or browser.
**Reopen if.** The app gets more settings than the header can hold, or the choice needs to follow the user across devices.

### DR-22 Editing replaces the entry, and recalculates from the food's record when it can
Revised by DR-33: the day can be edited too.
**Decision.** An entry's amount and meal can be edited, on this app's own entries, in the diary row itself. Its nutrient
cells follow what is typed, and a Save button and a Cancel link replace the edit and delete buttons: in words, so that
Cancel never looks like Delete. Escape or a click outside the row cancels too. Time and food cannot be
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
Google Health app sees a delete and a new entry. The amount of every entry this app wrote can be changed. It is in g or
ml when the entry states one, in the food's units when its food is found, and otherwise a multiple of the entry as logged
("2 × this entry" doubles every value), which needs no amount at all. Real entries name their unit under `users/me/`,
while the unit list uses the user's own ID (V12), so units are matched whichever user path they are written under. Unit
names are also read loosely, since Google does not specify them, and any entry with no readable amount is noted in the
debug log.
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
time, never its nutrients ([design](ARCHITECTURE.md#45-meal-prep)).
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
Revised by DR-40: the tickbox is in the settings panel behind the header's gear.
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
quote must be in the text, and spelled close enough to the chosen unit to be a typing mistake, starting with the same letter
and no closer to another unit. So `1 scoop` cannot become a cup, `250 mlitre` cannot become litres, and `1 cpu` cannot pick one of two cups.
Its number counts only if the rules read the quoted words as that number, and the rules' number is the one used. Every other
typed word must be accounted for, so `1-2 cups` and `about 2 cups` are refused.
**Consequence.** Since numbers have to be readable by the rules, phrases such as `two and a half` moved into the rules, which
leaves the model typos and odd word order. Chrome 148+ on desktop only, with 22 GB free, and more than 4 GB of VRAM or 16 GB of
RAM with 4+ cores. Unticking does not delete the model, which Chrome manages. The debug log records each question and answer,
to judge how well the model does. Not yet tried against the real model. The chat (DR-41) is a separate use of the same
model and setting, which is told about the diary.
**Reopen if.** The model turns out too unreliable to be worth keeping, or the header runs out of room for settings (DR-21).

### DR-27 The diary is ordered by meal and has no time column
**Decision.** The diary's rows are grouped by meal, in the order of the day (breakfast, lunch, dinner, then snack), and
by the time eaten within a meal. Entries with no meal come last. The diary does not show the time.
**Why.** Owner decision (7 November 2026): the time and the meal say the same thing, and conflict when they disagree,
such as a breakfast logged at 9 pm.
**Consequence.** Entries still have a time in Google Health, which the log form sets.
**Reopen if.** The owner wants the time back, for example to see when snacks were eaten.

### DR-28 A portion that is only a weight or volume is not offered (revised by DR-31)
**Decision.** A portion is dropped when its name is just a weight or volume, perhaps with equivalents in brackets or a
description after a comma (`100 g`, `1 oz, cooked`, `12 fl oz (355 ml)`), and its size is what that measure says, within 3%.
Portions named as a serving (`1 pie (150 g)`, `1 serving (300 ml)`) stay, and so do measures whose size differs: `1 cup`
of flour at 125 g, `1 tablespoon` at 15 ml, `1 fl oz` of milk at 30.5 g, `1 oz, dry, yields` 170 g.
**Why.** Owner decision (8 November 2026): such a portion reads as a unit, so it invites wrong entries. Someone who ate
200 g picks `× 100 g` and types 200, logging 20 kg. Picked correctly, it makes them do the scaling in their head (2 ×
100 g), and it saves nothing over the `g` unit beside it.
**Consequence.** Applied by the builders, for every source with portions: the food index (Open Food Facts) and the generic
foods file (FNDDS; AFCD has none). Data built earlier keeps them until it is rebuilt. In the generic foods file, plain
weights no longer use up the six portions kept per food. An Open Food Facts serving written as a bare weight, such as
`30 g`, is offered as `serving (30 g)` instead of being dropped (DR-31).
**Reopen if.** A source names real servings as bare weights often enough to be missed.

### DR-29 A saved meal is a recipe in the database, logged as one entry under its name
**Decision.** A saved meal is a name and a list of ingredients, stored per user in the meal prep database (DR-24, table
`meals`). Logging one writes one diary entry named after the meal, with the ingredients' nutrients summed, and nothing
in the database. Its ingredients can be changed for that one entry, which leaves the saved meal as it was. A saved meal
can be added to another meal, or to a meal being logged, as copies of its ingredients scaled to the servings given,
never as a link to it ([design](ARCHITECTURE.md#46-saved-meals)).
**Why.** Owner decisions (13 November 2026). It replaces the plan in #25 and #26: one entry per ingredient, grouped by ID,
with the library rebuilt from the diary and no database. One entry per meal reads as the meal in every app that shows
the diary, and a meal exists before it is first logged. Expanding a meal into its ingredients avoids loops and depth
limits, keeps every ingredient adjustable, and matches how ingredients already keep the nutrients worked out when added.
**Consequence.** The diary does not record the ingredients of a logged meal, or which changes were made for it. Editing
or deleting a saved meal changes no entry already logged, and no meal it was copied into. Its diary row has no amount,
like a meal prep portion, and can be scaled with "× this entry". Amounts change in the unit each ingredient was added
in, so no food is looked up again.
**Reopen if.** The owner wants a logged meal broken down by ingredient, or edits to one meal to flow into others.

### DR-30 When nothing matches exactly, search again with prefixes and variants
**Decision.** Only when a search finds nothing at all (logged foods, generic foods and products together), it runs
again loosely: every query word, not just the last, also matches any word starting with it, and the word without a
plural or past-tense ending (`iced` also finds `ice`, `biscuits` `biscuit`, `baked` `bake`). Every word must still
match, and there is still no typo tolerance ([FOOD_SEARCH.md](FOOD_SEARCH.md#42-matching)).
**Why.** Owner decision (14 November 2026), from [#107](https://github.com/Froussios/fitbit-nutrition-portal/issues/107):
`tall ice americano` found nothing because only the last word could be a prefix, so `ice` had to be a whole word.
Running only after an empty search leaves every search that finds something exactly as before, and costs one more
search only when the user would otherwise see no results.
**Consequence.** Loose results rank as partial matches (rule 1, tier 1) unless every word is whole after all. A word's longer forms are capped like a
prefix's (its 16 commonest), so a short, common word can miss rare longer words. Highlighting marks the words a
loose search matched.
**Reopen if.** Loose results are often wrong, or exact searches that find only poor matches would be better loose.

### DR-31 An Open Food Facts serving is offered as the serving, with its size
**Decision.** A product's serving portion says both that it is the serving and how big it is. A serving text that names
what it is (`1 cup (40 g)`, `2 biscuits (30 g)`) is kept as written. One that is only its size (`30 g`,
`354.88199999999995mL`) becomes `serving (30 g)`, and with no text it is `serving (200 g)` from the quantity. When the pack is
the size of the serving, within 3%, only the serving is offered.
**Why.** Owner decision (14 November 2026). A Starbucks Tall Iced Americano offered only `× pack (12 fl oz)`: DR-28 dropped
its serving, written as a bare volume, and kept the pack, though a café drink has no pack. Open Food Facts' serving
field is a serving whatever its wording, so naming it as one keeps it without the risk DR-28 guards against. A pack
the size of the serving would offer the same amount twice under two names.
**Consequence.** Many more products offer a serving, and their search rows show energy per serving again. A product whose
serving is a placeholder `100 g` offers `serving (100 g)`. Multi-serve products still offer `pack (…)`. Indexes built
earlier keep the old portions until rebuilt.
**Reopen if.** Placeholder servings are common enough to mislead, or `pack` reads wrongly on products that have one.

### DR-32 Synonyms only for words that name the same food everywhere
**Decision.** The generic food search's synonym table holds only words that name the same food in every source's
region: spellings (`yoghurt`, `yogurt`) and regional names (`capsicum`, `bell pepper`). `biscuit` and `cookie` are no
longer synonyms. Plurals of words ending in `ie` keep the `ie` (`cookies` is `cookie`, not `cooky`)
([FOOD_SEARCH.md](FOOD_SEARCH.md#13-generic-foods)).
**Why.** Owner decision (17 November 2026). `cookie` showed AFCD biscuits, including rice crackers and crispbreads, and
no cookies at all: the 36 AFCD biscuits it matched were enough Australian foods to hide FNDDS, which has 93 cookies.
The table was added with DR-16 to bridge spelling conventions that split the sources; the biscuit/cookie pair went
beyond that.
**Consequence.** `cookie` finds FNDDS cookies, and `biscuit` finds only AFCD biscuits.
**Reopen if.** Ranking takes the user's region into account, so a regional name could map to its local meaning.

### DR-33 The log button names a day other than today, and an edit can move an entry to another day
**Decision.** When an entry would go on another day than today (the day shown, or a time typed for another day), the log
button turns amber and names the day: "Log entry for yesterday", "Log meal for Monday, 16 Nov 2026". Beside it, the
regular log button logs the entry for today instead, at the same clock time, which can be later than now, as a time
typed for today can (owner request, 20 November 2026). The row editor
(DR-22) has a date field under the meal, up to today. A new day keeps the entry's local clock time and length, with the
local UTC offsets of the new day, so a move across a daylight saving change keeps the clock time; the clock time itself
still cannot be edited. A moved entry leaves the day shown, and a note under the heading says where it went, with a
button that shows that day.
**Why.** Owner request (18 November 2026): entries were logged on the wrong day by mistake, which nothing pointed out,
and the only fix was to delete the entry and log it again on the right day.
**Consequence.** A move is an edit like any other: a copy under a new ID, then a delete of the original (DR-22). The note
goes when the day shown changes. A meal prep share still cannot be edited, so it cannot be moved. A clock time that
does not exist on the new day, in the hour skipped when daylight saving starts, moves an hour later (02:30 becomes
03:30). Moving a late entry to today can put it later than now, as a time typed in the log form can.
**Reopen if.** Moving needs the clock time too, or entries are moved often enough to want it from the log form.

### DR-34 Generic foods rank by what the food is; region only breaks ties
Which region comes first revised by DR-35.
Revises DR-16, where USDA foods appeared only when AFCD had fewer than 3 matches.
**Decision.** The generic food search ranks first by what the food is: a query word that names it (English puts the food
last, so `Peanut butter` is a butter), then a word that modifies it, then a word after the comma. Then whole words, then
Australian before US, then the food the query's last word names, then the fewest words of the name the query leaves
unsaid. USDA foods are never hidden for being from the US: one is left out only when an Australian food that matched
has the same words before and after the first comma, apart from plain words and numbers, so a regional equivalent
(`reduced fat (~1%)` for `reduced fat (2%)`) stands in for it. AFCD's class-first names (`Nut, peanut`, `Seed, chia`,
`Melon, watermelon`) count as the food they name, and `crisps` is no longer read as `crisp`
([FOOD_SEARCH.md](FOOD_SEARCH.md#133-searching)).
**Why.** Owner decision (18 November 2026). `peanuts` showed `Peanut butter, smooth & crunchy, added sugar & salt` first.
The source ranked above how much of the name the query covered, and every word before the comma counted as the food.
AFCD's own peanuts, written `Nut, peanut`, didn't count at all. The rule that hid USDA foods also caused the cookie bug in
DR-32. Region is a good tie-breaker, and a good way to choose which of two copies of a food to keep, but no reason to show
a worse match.
**Consequence.** On 170 everyday queries, 41 change in their top 3. Nuts, seeds and melons find AFCD's own rows
(`Nut, almond` before `Almond beverage`), `oats` finds oats before oat milk, and where AFCD has nothing better, USDA's
plain food comes before an Australian compound one. Some half-typed words find a US food that has them as a whole word
(`mush`: cornmeal mush), until the next letter.
**Reopen if.** The app learns the user's country ([#42](https://github.com/Froussios/fitbit-nutrition-portal/issues/42)),
so region comes from the locale rather than a fixed list of overseas sources; or more class-first names turn up that the
list of classes misses.

### DR-35 The user's country comes from the device's time zone, never from a location permission
Revises DR-34, where region meant Australian before US for every user.
**Decision.** The app works out the user's country in the browser (`userCountry()` in `src/core/countries.ts`): the
device's time zone first (`Australia/Sydney` is Australia, from a table generated from the IANA time zone database by
`npm run build:time-zones`), else the region of the first preferred language that has one (`en-AU`), else none. Search
favours that country: in DR-34's tie-break and choice of which copy to keep, the generic database from it comes first
(FOOD_SEARCH.md section 13.3); equally good product matches sold there come first; and the dropdown shows its flag.
With no country, or none that a source is from, nothing is favoured. The product index's fixed order still favours one
country, chosen when it is built (`INDEX_COUNTRY`, Australia).
**Why.** Owner request (18 November 2026): the preference for Australian foods was hardcoded, and the app needs only the
country. Asking for location data would be overreach for a food diary: the geolocation permission gives coordinates,
and an IP lookup sends the user's address to a service for a country. The time zone is already known to every page,
needs no prompt, and never leaves the device. It follows where the device is set to be, while a language is only a
preference (many devices outside the US say `en-US`), so the time zone goes first.
**Consequence.** A user who sets their device to another country's time zone gets that country. Zones that name no
country (`UTC`) fall back to the language. A user outside Australia gets products ranked for their country only among
the candidates the Australian-ordered index offers; a fuller fix needs an index per country or a Worker (#42). Household
measures (DR-06) and number formats are still Australian.
**Reopen if.** The index is built per country, or a user's detected country is wrong often enough to want a setting.

### DR-36 Any diary entry can be logged again for today
**Decision.** Every row of the diary, on any day, has a Log again button beside Edit and Delete (or beside the lock, on
another app's entry). It logs a new entry with the same name, amount, meal and nutrients, today at the current time and
for as long as the original, under a new ID that keeps the original's source and food (`copiedEntryId`). The original is
left as it is. When another day is shown, the note under the heading says the entry was logged again for today, with a
button that shows today. A deleted row (which has Undo) and a meal prep share (which would need a portion of its batch)
have no Log again button.
**Why.** Owner request (19 November 2026): from the diary, pick a past entry and repeat it for today, rather than
searching for the food and typing the amount again.
**Consequence.** Another app's entry is copied as an anonymous log of this app's, so its reference to a Google `food`
is left out, and the copy can be edited and deleted here. The current time can disagree with the meal (yesterday's
breakfast, repeated in the evening, is still breakfast); the diary groups by meal and shows no time, and the copy can be
edited like any other entry. Repeating an entry already on today logs a second one.
**Reopen if.** Copies need another time (the original's clock time, or one picked), or several entries, such as a whole
meal, should be repeated at once.

### DR-37 A + button on today's entries adds one more of what was logged, recorded in the entry's ID
**Decision.** On today's diary, each entry made by this app that has an amount in grams or millilitres has a + button
first in its row, which says what it adds (`+35 g`, `+250 ml`). Its step is one of the portion or household measure
(tsp, tbsp, cup) the entry was logged in, else the entry's amount as logged (`90 g` steps by 90 g, `2 oz` by 2 oz). A
tap replaces the entry with a corrected copy at the larger amount, every value scaled with it, as an edit does (DR-22).
The step is recorded in the entry's ID, after its 4 random characters, in hundredths of a gram or millilitre in base
36 (ARCHITECTURE.md section 4.3). Copies keep it (undo, Log again). An edit to a portion or measure records one of
it; an edit in grams or millilitres keeps the step; an edit that turns grams into millilitres, or back, drops it. The
first + on an entry with no step records its amount as logged, so later taps add the same again rather than double it.
Log again (DR-36) stays on today's rows beside it.
**Why.** Owner request (19 November 2026): a button to increase the amount is better than logging a second entry. The
owner asked to store the unit logged so that it can be the step, since a serving in grams can't say a slice was meant,
and for the button to show how much it adds.
**Consequence.** The step is the portion's size when logged: a food whose portion has since changed still steps by the
old size, which the button shows. Entries logged before this change, and those logged in grams or millilitres, step by
their whole amount until the first tap fixes it. Saved meals, meal prep shares and other apps' entries have no +.
Each tap is a write and a delete, so the entry's ID changes on every tap.
**Reopen if.** The step should be chosen (half a portion), the + is wanted on other days, or a minus is wanted too.

### DR-38 A dashboard charts the viewed day and the 7 days ending on it
**Decision.** Under the diary, a Dashboard card shows the day the diary shows: its energy, protein, carbs and fat, a bar
splitting its energy by macronutrient (by the Atwater factors, 4 kcal a gram of protein and carbohydrate and 9 of fat,
each part labelled with its share and its grams in the legend) and a bar splitting its energy by meal. Below, the 7 days
ending on that day: a stacked column per day of protein, carbs and fat in grams, and one of energy by meal, with the
average energy over the days that have entries. Meals are grouped as Breakfast, Lunch, Dinner, Snacks (Google Health's
snack times, such as `BEFORE_DINNER`, included) and Other (`ANYTIME` and no meal). The week is one listing of the 7 days
(`listNutritionLogsBetween`), made after each diary load; the viewed day's own figures come from the diary's listing,
so this session's writes, edits and deletes show at once. Charts are SVG and HTML drawn by the app, with no chart
library; each has a legend, a tooltip on hover and keyboard focus, and a table of its figures; colours are checked for
colour-blind separation in both themes. Protein is red, carbs green and fat yellow (owner request, 20 November 2026).
**Why.** Owner request (19 November 2026): graphs for the basic metrics, presented as a dashboard; for the day, a
breakdown by macro and by meal; for the week, daily totals by macro and by meal.
**Consequence.** One more request to Google Health per diary load (polling included). Energy by macronutrient can differ
a little from the energy logged: labels round, fibre gives less energy than other carbohydrate, and alcohol has none of
the three. A day with nothing logged is an empty column, and does not lower the week's average.
**Reopen if.** Targets (an energy or protein goal) are wanted, the week should be a calendar week or a longer range, or
the extra listing costs too much quota.

### DR-39 Search collapses products that only repeat their brand, and branded energy within 10%
**Decision.** In the word index, a branded product is a duplicate of a better-ranked one with the same words in name
and brand when their kcal per 100 are within 10%, or 5 kcal for low-energy foods (before, they had to round to the same
whole kcal). A product whose name adds no word to its brand (`Chobani (Chobani)`, `Cola (Coca-Cola)`, `Milk (Milk)`)
is collapsed with others of the same brand whatever its energy, as products with no brand already are (DR-15).
Which of the two really is the brand isn't judged: the rule only asks whether the row carries one piece of
information. A brand that adds to the name is the usual case (`Greek Yogurt (Chobani)`) and is not collapsed. The rest
stay reachable by barcode ([FOOD_SEARCH.md](FOOD_SEARCH.md#53-slimming-the-dataset)).
**Why.** Owner report (19 November 2026): searching `chobani` showed six `Chobani (Chobani)` rows from 38 to 167 kcal,
with nothing on screen, or in Open Food Facts, to tell them apart; `Coca Cola (Coca Cola)` filled five rows between 39
and 45 kcal. Removing products that only repeat their brand was ruled out: `Vegemite (Vegemite)` and `Nutella (Nutella)`
are real products found this way. #48 found 84% of branded same-name groups agree within 10% or 10 kcal.
**Consequence.** A name that only repeats its brand shows its best-ranked entry in the DR-15 order; among identical
names that is the most scanned, sold in the user's country and most complete, which is right for `Nutella` and still a
guess for `Chobani`. A diet version stored under the same bare name (`Cola (Coca-Cola)` at 0 kcal) is hidden too.
Different products under one name and brand whose energy is within 10% now show as one.
**Reopen if.** Collapsed entries hide products people look for by name, or a better tie-break than popularity is
needed (energy agreeing with the macros, or with the group's median).

### DR-40 Settings live in a panel behind a gear in the header
**Decision.** The header shows only the title, Sign out and a gear button. The gear opens a small panel under it with
the settings: the energy unit (DR-21), the AI tickbox (DR-26) and, in builds with no client ID built in, the link to
the OAuth client ID setup screen. The panel closes on the gear, Escape (which gives focus back to the gear), or a click
or focus outside it, and a redraw of the page leaves it as it was. With nothing to set (signed out, client ID built in),
there is no gear. Sign out stays in the header, since it is an action, not a setting.
**Why.** Owner request (19 November 2026): settings should not be always visible; move them to a popup panel or a new
page and leave a gear behind as the link. A panel was chosen over a page because the settings are few and change what
the current page shows, so it stays in view while they change.
**Consequence.** Changing a setting takes one more click. The AI download's progress, and its notes that the model is
not available here or could not start, show only while the panel is open.
**Reopen if.** The settings outgrow a small panel, or some need explaining at length: then a settings page.

### DR-41 A chat beside the diary, run by the on-device model, proposes changes for the user to accept
**Decision.** A Chat button in the page header opens a panel on the right of the page. A speech-bubble button on each
diary row opens it on that entry: a new chat, with the model told about that entry first. The chat uses Chrome's
built-in model (DR-26), only while the AI setting is on and the model is ready, and turning the setting off ends the
chat. The model answers each message with one action as JSON, held to a schema: reply, read a day, read the totals of
up to 14 days, search foods, or propose a log, a change or a delete. Reading and searching happen straight away. A
proposal is a card in the chat showing what the diary row shows (food, amount, meal, day and time, nutrients), and for
a change each value before and after, with Accept and Reject. Nothing is written before Accept, and nothing else can
be sent until the user decides. Accepted changes go through the diary's own code (DR-20, DR-22, DR-33), once the app
has read the entry again and found it as the chat saw it. The model is told the outcome and carries on, so one message
can log several foods, each accepted on its own.
**Why.** Owner request (19 November 2026): a chat on the right of the page, where a local agent gets the context it
needs and can change the diary, every change asking for approval in a short structured card, and an entry named so the
user can tell which it is, since they never see its ID. A plain chat pulls context through its actions, and a chat
opened on an entry gets that entry up front. The Prompt API's own tool calls are specified, but not in every Chrome that
runs the model, and a schema is.
**How it is kept in bounds.** The model never sees an entry's ID or a food's reference: it names them by handles (`E1`,
`F1`) that the app hands out, and the schema allows only handles already handed out. Amounts are text read by the
amount rules (DR-25): a log must name a unit, and a bare number in a change is in the unit the entry was logged in, as
in the row editor. Days after today are refused. Only this app's entries can be changed or deleted (DR-04), and a meal
prep share only deleted. The app adds up totals and averages; the model only quotes them. Each message gets at most 8
model calls, each one at most a minute.
**Consequence.** Unlike the amount reader (DR-26), the chat sends the diary's food names, amounts and nutrients to the
model, which runs on the device; nothing goes anywhere but Google Health, and the debug log records the model's
answers. The model's number can reach an entry, but only as amount text the rules read, and only after the user
accepts a card that shows the result. A chat lives only in the page: reloading, signing out, another account signing
in, or turning the setting off ends it. Logging covers catalogue foods only, not custom foods, saved meals or meal prep
portions. Rows have one more button while the chat can be used. Not yet tried against the real model, which is small,
so the instructions in `src/ai/chat-protocol.ts` may need tuning.
**Reopen if.** Tool calls reach every Chrome that runs the model, the model proves too unreliable to be worth it, or the owner wants some
changes made without asking.

### DR-42 Open Food Facts energy is checked against the macronutrients, and a product that fails is flagged
**Decision.** When the index is built, each Open Food Facts product's energy is compared with what its fat,
carbohydrate and protein imply, with fibre, alcohol and sugar alcohols accounted for
([FOOD_SEARCH.md](FOOD_SEARCH.md#53-slimming-the-dataset)). A product more than 20% off (10 kcal for low-energy foods)
is flagged. Its dropdown row says **⚠ Energy doesn't add up**, and the tooltip gives the implied energy. It ranks after
otherwise equal products, just before popularity, so a group of duplicates (DR-39) shows an entry that adds up if it
has one. Flagged products stay searchable and can be logged. Generic foods (AFCD, FNDDS) are not checked. A product
missing fat, carbohydrate or protein can't be checked and is not flagged.
**Why.** Owner request (19 November 2026): after DR-39, `Vegemite (Vegemite)` showed its more scanned entry at 6 kcal
per 100 g over the one at 177. The owner asked for poor entries to be hidden behind better ones, and for every food to
be validated, with one beyond the tolerance flagged in the suggestions. #48 counted 3.6% of products whose energy
disagrees with their macros.
**Consequence.** Summary rows gain an optional last field, so older indexes, and apps reading newer ones, keep
working. A label can be wrong and still add up (`Vegemite` at 6 kcal with 5 g of carbohydrate and no protein, which
is flagged only because 6 is 14 kcal short of 20). Per-serving values typed as per 100 g also add up, so they pass
(#48 item 2). About 1% of measured foods disagree for real reasons, such as the organic acids in citrus and vinegar,
and the same goes for products like them.
**Reopen if.** Flags turn up often on products that are right, the tolerance needs to differ by food type, or a
flagged product should be hidden from search rather than ranked lower.

### DR-43 A saved meal's ingredients are rows that stay open until the meal is saved
**Decision.** In the saved meal builder, new or edited, each ingredient is a row with its own food search, amount and
unit, and a ✕. Add ingredient adds an empty row; Enter in a row's amount goes on to the next row, and from the last
one adds a row. Any row can change its food, amount or unit until the meal is saved. An empty row is left out; a row
with text but no food chosen keeps the meal from being saved. A saved meal chosen in a row stays one row, in servings,
and becomes copies of its ingredients when the meal is saved (DR-29). A row from the meal as saved, or from a draft,
scales its own nutrients to another amount, or to a unit of the same kind (g to kg, or the same portion). Its food is
loaded when the amount or unit is first focused, to offer the food's other portions and units, which take the
catalogue's nutrients as they are now. Meal prep keeps its builder: one search that adds an ingredient to the list.
**Why.** Owner request (19 November 2026): Add should not conclude an ingredient, but add a row to configure another,
and every ingredient should stay open to editing until the meal is saved. The rows keep the nutrients an ingredient
was saved with for as long as its unit allows, as ingredients always have (DR-29).
**Consequence.** A draft holds each row's last good ingredients, so a saved meal chosen in a row comes back from a
draft as its ingredients. An ingredient whose food has left the catalogue, or no longer has the unit it was saved in,
can change its amount but only to units of the same kind.
**Reopen if.** The owner wants meal prep built the same way, or a saved meal in a meal kept as a link to it.

### DR-44 A saved meal's entry shows "saved meal" for its amount
**Decision.** In the diary, the Amount of a saved meal's entry (ID source `meal`, DR-29) is a small muted label,
**saved meal**, with a tooltip saying it was logged from a saved meal as one entry with no amount of its own. The
chat's approval card and its "About:" line say the same, and the chat model is told the entry is a saved meal with
no amount of its own. Every other entry without an amount, a meal prep share or another app's entry, still shows "–".
**Why.** Owner request (19 November 2026): a saved meal's "–" looked the same as an amount that had wrongly not been
recorded. A label says where the entry came from without inventing a number: "1 serving" would be wrong after
"× this entry" (DR-22) scales it, since the entry keeps no `serving`.
**Consequence.** The label is read from the entry's ID, so it shows only on this app's entries. It does not say how
many servings an entry holds after it was scaled.
**Reopen if.** The owner wants meal prep shares marked too, or a scaled meal to show its multiple.

### DR-45 Each part of the page has a colour of its own
**Decision.** Each card has a hue (`--tint` in `src/styles.css`). It shows as a stripe along the card's top, in its
heading, as a faint wash behind it, and in its alternate rows, chips and hovers. Log food is green, Meal prep teal and
Saved meals violet: the card above the diary takes the hue of the tab shown, and each tab has a dot in its own. The
diary is blue, the dashboard rose and the chat slate. Sign-in and the developer setup take the log's green, the debug log
stays gray and a connection error is red. The
dashboard's tiles take the colours of their series in the charts (energy in the dashboard's own), and a chat proposal
takes the colour of what it does: green to log, the diary's blue to change, red to delete. Buttons, links and focus
rings keep the one accent.
**Why.** Owner request (19 November 2026): subtle colour coding for the page's sections and cards.
**Consequence.** Colours are mixed with `color-mix()` (every major browser since 2023); an older browser would draw
cards without their background and borders. The wash stays under 10%, so text keeps its contrast in both themes.
**Reopen if.** A hue is mistaken for a state, such as the amber of logging on another day, or the owner wants the
colours stronger, weaker or gone.

### DR-46 Calories burnt, with an optional permission, are set against the energy eaten on the dashboard
**Decision.** Sign-in also asks for `googlehealth.activity_and_fitness.readonly`, which the user may untick on Google's
consent screen like the nutrition read scope (DR-04). With it, each week listing (DR-38) is joined by one `dailyRollUp`
of `total-calories` over the same 7 days, today's window ending at the current local time (V13). The figures are drawn
into the charts there are, not given a row of their own: under the day's energy, "of 2,300 kcal burnt" (first "burnt so
far" for today; the owner found it unnecessary, 20 November 2026); on the bar of energy by meal, a marker where the
calories burnt fall, with an outlined gap up to it while less was eaten, and the difference in the legend; on each day's
energy column, a line at its calories burnt, dashed for today, with the figure in the tooltip and a Burnt column in the
table, and above it the day's difference, eaten − burnt as shown ("+200", "−340"; "200 kcal surplus" in the tooltip and a
Difference column; none on a day with nothing logged; owner request, 20 November 2026). The week's summary adds the average burnt over the complete days recorded, leaving today out. Without the scope
nothing is asked and the dashboard is as before, with a "Show calories burnt" link to sign in again and tick it (in the
totals card beside the log since DR-47; first in the dashboard's note). A failed roll-up only adds a note under the
week's summary.
**Why.** Owner request (19 November 2026): pull the total calories burnt to compare calories in with calories out; the
connection must be optional, and skipped when the user doesn't agree; calories burnt should inform the graphs and the
dashboard rather than be a row; "burnt so far" for today, because the current day is the only one the user can still act
on.
**Consequence.** One more request to Google Health per diary load, polling included, when the scope is granted. The
OAuth consent screen's data access needs the new scope added (README). Today's figure lags behind the last device sync.
The roll-up leaves out time a wearable was not worn; whether a day without one has a resting estimate is not known yet
(V13). Wrist estimates of energy are rough, so a day's difference is a guide, not a measurement.
**Reopen if.** V13's open points turn out otherwise (another scope, or today's figure projected to the day's end), the
owner wants the time of the last sync shown, a target derived from the calories burnt, or a longer range than 14 days.

### DR-47 The day's totals sit beside the log, without making the page taller
**Decision.** A totals card sits to the right of the log card (38% of the row, at least 270px), headed "Today's totals",
"Yesterday's totals" or "Totals for Tue 17 Nov" after the day shown. It sums the day up in three lines: the difference
between the calories burnt and the energy eaten as its strongest figure ("340 kcal deficit", "200 kcal surplus" or
"Even"), with Eaten and Burnt beside it in the same type as each other (only the energy eaten, without DR-46's scope); a
slim bar of energy by meal (no percentages or legend, every figure in its tooltips and accessible name), drawn up to the
calories burnt with its marker; and the grams of protein, carbs and fat. Without the scope it has DR-46's "Show calories
burnt" link, moved here from the dashboard's note. If the day could not be loaded it says so. The log card alone sets
the row's height: the totals card is sized as if empty (`contain: size`), stretched to the row and scrolls only if its
content ever overflows, which it does not at rest. Below 720px for the row, on a phone or beside the open chat, it goes
under the log. The Dashboard card below keeps the day in full and the week (DR-38).
**Why.** Owner request (20 November 2026): the dashboard is a major motivation to keep logging, so the day's totals
should be seen often, next to the logging section; they must not take vertical space, and the form has room to spare
horizontally. Then: the energy eaten was in a strong font and the calories burnt understated, so make them equal; the
strongest number is the difference; "so far" is unnecessary.
**Consequence.** The log form is narrower on wide screens. On a phone the summary adds about 120px under the log. The
day's figures appear twice on the page, in brief beside the log and in full in the dashboard.
**Reopen if.** The log card's content is ever shorter than the summary at rest (it would scroll), the owner wants the
summary on a phone above the log or hidden, or targets are added (DR-38).
**Revised by DR-49** (20 November 2026): the card fills the height the log card gives it, with a ring in place of the
slim bar, and a signed difference.

### DR-48 Each meal's summary closes its entries in the diary, with a bar of its macronutrients to scale
**Decision.** The diary's entries stay grouped by meal type, in the table's meal order, and each meal is now a
`tbody` of its own, closed by a summary row that reads as a summary of the rows above rather than another row: no meal
name and nothing under Meal or Food, below the same line as every entry has. Across Amount to Fat it has a slim
bar of the meal's protein, carbs and fat, with no text in it; in the column after Fat, the meal's energy, which keeps its
place whatever the bar's length. Like the dashboard's bar by macronutrient (DR-38), each block is as wide as the energy
that macronutrient gives by the Atwater factors, and its tooltip and the bar's accessible name give the grams. The
bar's whole length is the meal's energy from macronutrients as a share of the largest meal's, so only that meal's bar
spans Amount to Fat and the others compare at a glance. Deleted entries count in neither a meal's summary nor the
scale, and a meal whose entries are all deleted has no summary. A meal with no protein, carbs or fat recorded says so
instead of a bar. Meal types are not merged as the dashboard merges them into snacks: the rows above each summary are
what it sums, and meal types the API adds later are kept apart by name.
**Why.** Owner request (20 November 2026): per-meal stats between the entries, with a horizontal bar breaking down the
macros; the bars must stay proportional between meals rather than each fill the width, and only the largest meal may.
The first version, with the meal's name and its figures in the table's columns, looked like "just an uglier row" rather
than a summary: the owner asked for no repeated meal name and the bar across Amount to Fat, not in the Food column.
The second printed grams in the blocks and the energy right after the bar's end; the owner found the grams clipped and
the energy taking room from the bar and moving with it, so the bar prints nothing and the energy has a column of its own.
The third had no line between a meal's last entry and its summary, which made the summary look like part of that entry;
the owner asked for consistent borders on the entries, so the last one keeps its line like the rest.
**Consequence.** The diary is one short row taller per meal. A meal's grams are only in its bar's tooltips, not printed.
A meal's bar is scaled by the energy its macronutrients give, not its logged energy, so a meal of energy-only entries
from another app has no bar, and two meals of similar logged energy can differ a little in length.
**Reopen if.** The owner wants the bars scaled by logged energy or by grams, the summary above a meal's entries, or meal
types merged as on the dashboard.

### DR-49 The totals card fills the height the log card gives it, and signs the difference
**Decision.** The totals card beside the log (DR-47) keeps its place and its rule that the log card alone sets the
row's height, but shows more as that height grows. Always: the difference as its strongest figure, now signed eaten −
burnt as on the dashboard's energy chart (DR-46): "−340 kcal deficit", "+200 kcal surplus" or "Even", with Eaten and
Burnt beside it alike; a ring of energy by meal in place of the slim bar, going round once for the larger of eaten and
burnt, with an outlined gap from the last meal up to the calories burnt after a deficit, a band outside the ring from
them to the end after a surplus, a tick where they fall, and in the middle the energy eaten as a share of them ("44%",
"of burnt"; without DR-46's scope a plain ring by meal with nothing in the middle); and beside the ring each
macronutrient's grams, share of the energy by the Atwater factors (DR-38) and a bar of that share. From 250px for the
card's content a larger ring and its legend: Breakfast, Lunch, Dinner and Snacks always (a dash for one with nothing
yet), Other only when it has some, and the key of the calories burnt. From 340px the 7 days ending on the day: a
column of each day's energy eaten, a line at its calories burnt (dashed for today), the signed difference above it
(none on a day with nothing eaten), and the average difference over the complete days with both, leaving today out (or
the average eaten without the scope); the week is left out until it loads. Every figure is in hover titles and
accessible names. The heights are CSS container queries on the card (a size container), so nothing is measured in
script. Without the scope, "Show calories burnt" sits beside the card's heading. Below 720px for the row the card goes
under the log as before, with the legend but not the week.
**Why.** Owner request (20 November 2026): the panel next to the input form had too much empty space; once a food is
picked the log card is about 410px tall and the summary filled its top 120px. Of four layouts mocked up, the owner
chose the ring with macronutrient bars, on condition that eaten against burnt stays its main comparison, and that a
deficit and a surplus of the same size read apart at a glance: by a sign, not by colour or a badge, which the owner
found ugly.
**Consequence.** At rest the card is as full as before (DR-47's three lines, with a 72px ring in place of the bar's
line); it never scrolls in the heights checked. The week is drawn twice on a wide screen, small here and in full in the
dashboard. A meal under 1% of the ring is a sliver.
**Reopen if.** The log card's height at rest changes enough that the card scrolls or leaves space again, the owner
wants the week or the legend at other heights, or targets are added (DR-38).
**Amended** (22 November 2026, owner request): the week's columns grow with the card only up to 160px. A long log card,
as with a saved meal's ingredients, stretched them over the whole height; the space past 160px is now left empty under
the week.
