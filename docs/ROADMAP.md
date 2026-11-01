# Roadmap

The plan from proof of concept to MVP, and what is parked for later. GitHub issues track the work:
[#1 MVP](https://github.com/Froussios/fitbit-nutrition-portal/issues/1) is the root, each milestone is a sub-issue of it, and each work item is a sub-issue of its
milestone. Labels: `M0`–`M4`, `spike`, `decision`, `later`, `roadmap`.

Decisions live in [DECISIONS.md](DECISIONS.md); the design in [ARCHITECTURE.md](ARCHITECTURE.md).

## Product in one line

A food diary with a better logging UI than the Google Health app. Every entry is stored in the user's
Google Health nutrition log, with no backend and no database of our own. Google Health takes care of
syncing that log with other platforms.

## MVP definition

**MVP = milestones M0 to M4.** It is reached when every target below holds.

### MVP targets (proposed; confirm or adjust in [#1](https://github.com/Froussios/fitbit-nutrition-portal/issues/1))

| Area | Target |
|---|---|
| Food coverage | At least 45 of a 50-item Australian test list (packaged, generic, 10 chains including a Big Mac) found with usable nutrients ([#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15)) |
| Logging speed | A recent food in 3 taps or fewer; a searched food in under 15 seconds |
| Units | g, ml, Australian household measures and named portions; no mass↔volume conversion without a density |
| Correct totals | The day's totals match the Google Health app for the same day (all sources) |
| Devices | Installable on Android and iOS and usable on desktop, from one static site |
| Sessions | A user signs in at most about once a month (after M3) |
| Meals | A custom meal of known ingredients can be built, logged and logged again |
| Infrastructure | Static hosting plus, at most, the stateless exceptions recorded in DECISIONS.md |
| Users | Up to 100 (the unverified OAuth cap) |

## Milestones

| Milestone | Goal | Work items | Status |
|---|---|---|---|
| [M0: proof of concept](https://github.com/Froussios/fitbit-nutrition-portal/issues/2) | Sign in, log simple entries from fake foods, today's whole diary with amounts and totals, delete own entries | [#8](https://github.com/Froussios/fitbit-nutrition-portal/issues/8) spike: real-account check · [#11](https://github.com/Froussios/fitbit-nutrition-portal/issues/11) deploy to Pages | Built and tested against mocks; awaiting #8 and #11 |
| [M1: food search](https://github.com/Froussios/fitbit-nutrition-portal/issues/3) | Real food data from a mirror behind `FoodCatalog`, search, barcode, recent foods | [#9](https://github.com/Froussios/fitbit-nutrition-portal/issues/9) decision D3: mirror design · [#12](https://github.com/Froussios/fitbit-nutrition-portal/issues/12) mirror pipeline · [#13](https://github.com/Froussios/fitbit-nutrition-portal/issues/13) search UI and barcode · [#14](https://github.com/Froussios/fitbit-nutrition-portal/issues/14) recent foods · [#15](https://github.com/Froussios/fitbit-nutrition-portal/issues/15) spike: coverage test | Not started |
| [M2: daily driver](https://github.com/Froussios/fitbit-nutrition-portal/issues/4) | Usable every day on phone and desktop | [#16](https://github.com/Froussios/fitbit-nutrition-portal/issues/16) PWA · [#17](https://github.com/Froussios/fitbit-nutrition-portal/issues/17) edit · [#18](https://github.com/Froussios/fitbit-nutrition-portal/issues/18) spike: reuse deleted ID · [#19](https://github.com/Froussios/fitbit-nutrition-portal/issues/19) day navigation · [#20](https://github.com/Froussios/fitbit-nutrition-portal/issues/20) offline queue · [#21](https://github.com/Froussios/fitbit-nutrition-portal/issues/21) kJ/kcal | Not started |
| [M3: long-lived sessions](https://github.com/Froussios/fitbit-nutrition-portal/issues/5) | No hourly re-sign-in | [#22](https://github.com/Froussios/fitbit-nutrition-portal/issues/22) decision D1 · [#23](https://github.com/Froussios/fitbit-nutrition-portal/issues/23) spike: unverified production tokens · [#24](https://github.com/Froussios/fitbit-nutrition-portal/issues/24) implement | Not started (deferred from M0) |
| [M4: custom meals](https://github.com/Froussios/fitbit-nutrition-portal/issues/6) | Meals from known ingredients | [#25](https://github.com/Froussios/fitbit-nutrition-portal/issues/25) builder and grouped logging · [#26](https://github.com/Froussios/fitbit-nutrition-portal/issues/26) library from history | Not started |

Order matters mainly for M1 before M4: meals need real ingredients. M2 and M3 can swap if hourly sign-in
becomes the bigger pain.

### M0 scope notes
- Food data is local fake data in the Open Food Facts record format.
- Out of scope for M0: meals, food search, offline use, long-lived sessions.

## Saved for later (after the MVP)

Tracked under [#7 Later](https://github.com/Froussios/fitbit-nutrition-portal/issues/7), label `later`.

| Item | Why it waits |
|---|---|
| [#10](https://github.com/Froussios/fitbit-nutrition-portal/issues/10) Live updates via Google Health webhooks | Needs a server (one verified HTTPS endpoint per project, plus Web Push or FCM keys); polling covers the need (D2) |
| [#27](https://github.com/Froussios/fitbit-nutrition-portal/issues/27) Contribute missing foods back to Open Food Facts | Depends on the mirror (M1); best done with the user's own Open Food Facts account |
| [#28](https://github.com/Froussios/fitbit-nutrition-portal/issues/28) OAuth verification and security assessment | Only needed beyond 100 users |
| [#29](https://github.com/Froussios/fitbit-nutrition-portal/issues/29) Identified logs against Google `food` resources | Depends on what `food` list returns; cannot replace our catalogue |

## Not planned

| Item | Reason |
|---|---|
| Health Connect integration (including an Android companion app) | The app integrates only with the Google Health API; Google Health handles syncing |
| Querying the public Open Food Facts API from the app | Rate limits far too low for interactive search; use the mirror |
| Building on the legacy Fitbit Web API | Switched off on 2 November 2026 |

## Changing the roadmap

Moving work between milestones, or out of `later`, is a roadmap decision: update this file and the
issue hierarchy together, and add an entry to DECISIONS.md if it changes a recorded decision.
