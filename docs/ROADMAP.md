# Roadmap

The plan from MVP onwards, and what is parked for later. GitHub issues track the work:
[#1 Roadmap](https://github.com/Froussios/fitbit-nutrition-portal/issues/1) is the root, each milestone is a sub-issue of it, and each work item is a sub-issue of
its milestone. Labels: `M0`–`M4`, `spike`, `decision`, `later`, `roadmap`.

Decisions live in [DECISIONS.md](DECISIONS.md); the design in [ARCHITECTURE.md](ARCHITECTURE.md), and food search in
[FOOD_SEARCH.md](FOOD_SEARCH.md).

## Product in one line

A food diary with a better logging UI than the Google Health app. Every entry is stored in the user's
Google Health nutrition log, with no backend and no database of our own. Google Health takes care of
syncing that log with other platforms.

## MVP = the proof of concept (M0)

The MVP is the proof of concept: an app that lets a user **sign in, write minimal entries, and see the
day**. Everything after it is a post-MVP milestone.

### MVP targets

| Area | Target |
|---|---|
| Sign in | A test user signs in with Google and grants nutrition read and write access; an account not linked to Google Health gets a clear message |
| Write | A minimal entry (food name, meal, time, energy, and fat / carbohydrate / protein) is written to the Google Health nutrition log and appears in the Google Health app |
| Display the day | Today's entries from all sources are listed with their amounts, and the totals match the Google Health app |
| Devices | Works in a current browser on phone and desktop |
| Infrastructure | A static site on GitHub Pages, no backend |

Tracked in [M0 #2](https://github.com/Froussios/fitbit-nutrition-portal/issues/2). The app is live at https://froussios.github.io/fitbit-nutrition-portal/ (since 4 November
2026): the Google Cloud setup ([#30](https://github.com/Froussios/fitbit-nutrition-portal/issues/30)) is done and sign-in and reading the day work. Remaining: [#8](https://github.com/Froussios/fitbit-nutrition-portal/issues/8)
(full check against a real Google account) and the last step of [#11](https://github.com/Froussios/fitbit-nutrition-portal/issues/11) (log an entry and see it in the Google Health
app). The PoC already goes beyond the minimum (units and portions, custom foods, deleting
own entries); those are kept but are not MVP criteria.

## Post-MVP milestones

| Milestone | Goal | Done when | Work items |
|---|---|---|---|
| [M1: food search](https://github.com/Froussios/fitbit-nutrition-portal/issues/3) | Search-as-you-type over Open Food Facts (static index, no server) behind `FoodCatalog`, barcode, recent foods ([design](FOOD_SEARCH.md)) | At least 45 of a 50-item Australian test list found with usable nutrients; a recent food logs in 3 taps or fewer; results within 250 ms of the last keystroke | Done: [#9](https://github.com/Froussios/fitbit-nutrition-portal/issues/9) decision D3 (DR-14) · [#12](https://github.com/Froussios/fitbit-nutrition-portal/issues/12) index builder · [#37](https://github.com/Froussios/fitbit-nutrition-portal/issues/37) publish the index · [#13](https://github.com/Froussios/fitbit-nutrition-portal/issues/13) search UI. Open: [#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15) verify on the real index · [#36](https://github.com/Froussios/fitbit-nutrition-portal/issues/36) barcode · [#14](https://github.com/Froussios/fitbit-nutrition-portal/issues/14) recent foods |
| [M2: daily driver](https://github.com/Froussios/fitbit-nutrition-portal/issues/4) | Usable every day on phone and desktop | Installable on Android, iOS and desktop; entries can be edited; any day can be viewed; logging works offline | [#16](https://github.com/Froussios/fitbit-nutrition-portal/issues/16) PWA · [#17](https://github.com/Froussios/fitbit-nutrition-portal/issues/17) edit · [#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18) spike: reuse deleted ID · [#19](https://github.com/Froussios/fitbit-nutrition-portal/issues/19) day navigation · [#20](https://github.com/Froussios/fitbit-nutrition-portal/issues/20) offline queue · [#21](https://github.com/Froussios/fitbit-nutrition-portal/issues/21) kJ/kcal |
| [M3: long-lived sessions](https://github.com/Froussios/fitbit-nutrition-portal/issues/5) | No hourly re-sign-in | A user signs in at most about once a month | [#22](https://github.com/Froussios/fitbit-nutrition-portal/issues/22) decision D1 · [#23](https://github.com/Froussios/fitbit-nutrition-portal/issues/23) spike: unverified production tokens · [#24](https://github.com/Froussios/fitbit-nutrition-portal/issues/24) implement |
| [M4: custom meals](https://github.com/Froussios/fitbit-nutrition-portal/issues/6) | Meals from known ingredients | A meal can be built, logged and logged again | [#25](https://github.com/Froussios/fitbit-nutrition-portal/issues/25) builder and grouped logging · [#26](https://github.com/Froussios/fitbit-nutrition-portal/issues/26) library from history |

Order matters mainly for M1 before M4: meals need real ingredients. M2 and M3 can swap if hourly sign-in
becomes the bigger pain.

## Saved for later

Not scheduled in any milestone. Tracked under [#7 Later](https://github.com/Froussios/fitbit-nutrition-portal/issues/7), label `later`.

| Item | Why it waits |
|---|---|
| [#10](https://github.com/Froussios/fitbit-nutrition-portal/issues/10) Live updates via Google Health webhooks | Needs a server (one verified HTTPS endpoint per project, plus Web Push or FCM keys); polling covers the need (DR-08) |
| [#27](https://github.com/Froussios/fitbit-nutrition-portal/issues/27) Contribute missing foods back to Open Food Facts | Depends on the mirror (M1); best done with the user's own Open Food Facts account |
| [#28](https://github.com/Froussios/fitbit-nutrition-portal/issues/28) OAuth verification and security assessment | Only needed beyond 100 users |
| [#29](https://github.com/Froussios/fitbit-nutrition-portal/issues/29) Identified logs against Google `food` resources | Depends on what `food` list returns; cannot replace our catalogue |
| [#38](https://github.com/Froussios/fitbit-nutrition-portal/issues/38) More generic food sources (AUSNUT 2023) | AFCD and USDA FNDDS are in (DR-16); AUSNUT adds Australian dishes and serving measures once FSANZ confirms its licence |

## Not planned

| Item | Reason |
|---|---|
| Health Connect integration (including an Android companion app) | The app integrates only with the Google Health API; Google Health handles syncing |
| Querying the public Open Food Facts API from the app | Rate limits far too low for interactive search; use the mirror |
| Building on the legacy Fitbit Web API | Switched off on 2 November 2026 |

## Changing the roadmap

Moving work between milestones, or out of `later`, is a roadmap decision: update this file and the
issue hierarchy together, and add an entry to DECISIONS.md if it changes a recorded decision.
