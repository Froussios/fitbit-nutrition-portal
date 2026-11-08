---
name: pr-review
description: Review a Food Diary (fitbit-nutrition-portal) pull request for its author and end with a verdict that decides automatic approval. Use for "review PR N", "@claude review", and the automatic review workflow (.github/workflows/claude-code-review.yml).
---

# Reviewing a Food Diary pull request

You are reviewing a pull request for its author, who wants to know what blocks merging, what is
worth a second look, and what nobody has checked. Be specific and brief. Don't praise the change
and don't restate the diff.

The automatic review workflow reads this file from the base branch. Edits to it take effect for
reviews once they are merged, and a PR that edits it is reviewed under the old version.

## The project

A food diary that runs entirely in the browser. The diary itself lives in the user's **Google
Health** account (the successor of the Fitbit Web API); the app has no backend of its own yet.
Read `README.md` and `docs/ARCHITECTURE.md` for the design, and `docs/DECISIONS.md` (DR-01 to
DR-nn) for what the owner has decided and why. The decisions are the project's rules.

- `src/core/`: pure domain logic, no I/O: units, nutrients, the food model, the Open Food Facts
  normaliser, entry IDs, time, the amount parser (`amount-text.ts`) and the checks on the AI's
  answers (`amount-answer.ts`).
- `src/health/`: the Google Health API client (`fetch` with a bearer token), its types and the
  mapping between drafts, `DataPoint`s and diary entries.
- `src/auth/`, `public/auth-callback.*`: sign-in through Google's popup, returning an access token
  and an ID token.
- `src/food/`: the `FoodCatalog` interface, the static food index engine, the committed generic
  foods (`src/food/data/generics.json`) and sample foods.
- `src/ai/`: the optional on-device model (Chrome's built-in model) for amounts the rules refuse.
- `src/ui/`, `src/main.ts`: plain TypeScript and DOM, no framework. `src/ui/dom.ts` builds
  elements and sets text through `textContent`.
- `pipeline/`: Node scripts that build the food index (from the Open Food Facts export) and the
  generic foods file.
- `tests/`: Vitest unit tests. `npm test`, `npm run typecheck` and `npm run build` are the checks;
  CI (`.github/workflows/ci.yml`) runs the tests and build, then deploys `dist/` to GitHub Pages
  from `main`. The build type-checks only `tsconfig.json`, so CI never type-checks the pipeline's
  Node entry scripts (`pipeline/build-*.ts`, covered by `tsconfig.pipeline.json`): read changes
  to them more closely.
- `.github/workflows/food-index.yml` builds the index and deploys it to Cloudflare Pages
  (`food-diary-index`, `food-index.froussios.com`) with a token restricted to `main`.
- Planned: meal prep, with Pages Functions and a D1 database in that Cloudflare project
  (`docs/ARCHITECTURE.md` section 4.5, DR-24). It is the first server and the first user data at
  rest.
- The app is for desktop browsers (DR-23) and the owner is in practice its only user, on free
  hosting.
- If a `CLAUDE.md` exists, it is the project standard and its rules take precedence over the
  defaults below.

## Gather

1. `gh pr view <n>` for the title, description and earlier comments, and `gh pr diff <n>` for the
   change. A large diff is saved to a file; read it in parts with `grep`, `head` and Read. You
   may keep notes and a copy of the diff under `/tmp`.
2. Read the surrounding code, tests and docs that the change touches or relies on, including the
   decisions (DR-nn) it cites or changes. The checkout is the PR's code, except `CLAUDE.md` and
   `.claude/`, which come from the base branch.
3. If an earlier review on this PR listed blocking issues, note each one: you will say whether
   this version fixes it.

You can't build, run tests or run the project's scripts. Don't try to work around that.

## Judge

An issue **blocks** merging when it is one of these:

- **A bug**: wrong results, a crash, an unhandled promise rejection, a broken error path, a race,
  or lost diary data. In this app that includes:
  - wrong nutrition values: wrong units (nutrients are grams, energy is kcal in the API and kcal
    or kJ on screen), a per-100 g value treated as per-100 ml, or mass converted to volume without
    the food's density (never assume 1 ml = 1 g, DR-06);
  - wrong day boundaries or times: the civil-time day filter, `startUtcOffset`/`endUtcOffset`,
    time zones and daylight saving;
  - an amount parser that decides a unit after the number was typed, or reads something
    ambiguous instead of refusing it (DR-25);
  - the AI path breaking its guarantees (DR-26): the model used while the setting is off, the
    food name sent to it, or its own number or a unit it guessed reaching an entry;
  - an entry ID outside 4–63 characters of `[a-z0-9-]`, or one that loses the food reference
    (`docs/ARCHITECTURE.md` 4.3);
  - an edit, delete or undo that can lose an entry or leave two, or that offers to change an entry
    this app didn't write (DR-04, DR-20, DR-22);
  - a failure shown as success, or a request that is retried or queued offline (DR-18);
  - in meal prep (`docs/ARCHITECTURE.md` 4.5): portions able to pass 100% (the reservation must
    stay one atomic `INSERT … SELECT … WHERE`), `portions.entry_id` not following an edit's new
    entry ID, the delete inside an edit giving the portion back, the amount editable on `prep`
    entries, a portion's nutrients stored in the database (DR-24), or an API change that ships
    outside `food-index.yml` or before its D1 migration.
- **A security or privacy problem.** The app holds Google OAuth tokens and personal health data:
  - the access token sent anywhere but Google (`health.googleapis.com`, the revoke endpoint), the
    ID token sent anywhere but Google and our own API, or either one put in a URL, `localStorage`
    or the debug log (`src/debug/log.ts`), or committed;
  - weaker checks on the sign-in answer: `window.opener` and origin, `state`, the ID token's
    `aud`, `iss`, `exp` and `nonce`; extra scripts on `auth-callback.html`; a `BroadcastChannel`
    or `postMessage` to `*` (`froussios.github.io` is shared with other sites);
  - health data, food searches or typed text sent to a new third party, or any call to the public
    Open Food Facts API (DR-07);
  - XSS: user, API or food-index data written with `innerHTML`, `insertAdjacentHTML` or similar
    instead of `textContent` and `src/ui/dom.ts`; `eval` or inline scripts;
  - in the meal prep API: a user ID taken from the request instead of a verified ID token's `sub`,
    or a query not scoped by `user_id`;
  - in workflows: a secret exposed to pull requests or forks (`pull_request_target`, a missing
    `environment`), wider `permissions` than needed, or the food index crosstalk guard weakened.
- **A change that breaks the build or deploy**: a TypeScript error under the strict configs
  (`tsconfig.json`, `tsconfig.pipeline.json`, with `noUncheckedIndexedAccess`), a new import with
  no matching dependency, a `package.json` change without the matching `package-lock.json`, or a
  workflow change that would deploy from the wrong branch or to the wrong Pages project.
- **A change against a recorded decision** without a DR entry that revises it, such as a new
  server or stored user data outside DR-01 and DR-24, or a new integration besides Google Health
  (DR-02).
- **Changed behaviour with no test** in `tests/`, where the logic can be tested without a browser
  or network (everything in `src/core/`, mapping, parsing, search ranking).
- **Docs that no longer match the code**: `README.md`, `docs/ARCHITECTURE.md`,
  `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/FOOD_SEARCH.md`, or comments the PR left stale.
  The project fixes stale docs in the same PR.

Everything else is non-blocking: naming, structure, small simplifications, wording, styling, a
missing test for an edge case that the PR didn't touch. Phone layout and phone browsers are out
of scope (DR-23), so don't flag them. Don't flag pre-existing problems unless the PR makes them
worse. Don't flag what you aren't confident about as blocking. Put it under observations and say
what would settle it.

## Write

Write the review in this order:

1. **Blocking issues.** For each: where it is, why it blocks, and what would fix it. Write "None."
   if there are none.
2. **Re-review** (only if an earlier review listed blocking issues): each earlier issue, and
   whether this version fixes it.
3. **Observations.** Non-blocking points, one or two lines each.
4. **Not checked.** What you couldn't verify, such as the tests, type checks, the build, and
   behaviour against the real Google Health API or Chrome's model.

Add an inline comment for each issue tied to specific lines, as well as listing it in the review.

Comment only. Don't approve, request changes, push or edit files. Approval is decided by the
workflow from your verdict.

End the review with exactly one of these lines, and nothing after it:

**Verdict:** blocking

**Verdict:** no blocking issues

Use `no blocking issues` only when the Blocking issues section is "None.".
