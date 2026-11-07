# Food Diary

A food diary that runs entirely in the browser and stores every entry in the user's own
**Google Health** account (the successor of the Fitbit Web API). There is no backend and no database.

This is the MVP, a proof of concept (milestone M0):

1. Sign in with Google and grant Google Health nutrition access (read and write).
2. Log an entry from a small catalogue of local fake foods (written as Open Food Facts records) or from a
   custom food, in g, ml, household measures or portions.
3. See today's whole Google Health nutrition diary, whichever app logged each entry, with amounts and
   totals. Entries made by this app can be deleted, with no confirmation: a deleted entry stays crossed out with
   an Undo until the page is reloaded.

* Design and verified API facts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* MVP targets, post-MVP milestones and work saved for later: [docs/ROADMAP.md](docs/ROADMAP.md)
  (tracked in [GitHub issues](https://github.com/Froussios/fitbit-nutrition-portal/issues/1))
* Decision log: [docs/DECISIONS.md](docs/DECISIONS.md)
* Food search design (milestone M1): [docs/FOOD_SEARCH.md](docs/FOOD_SEARCH.md)

## Google Cloud setup (once, by the developer)

Step-by-step checklist with troubleshooting: [issue #30](https://github.com/Froussios/fitbit-nutrition-portal/issues/30). Summary:

The app needs one Google Cloud project and OAuth client. This is how Google identifies the app; users
never create one, they just sign in with their Google account. The Google Health API has no sandbox, so
use a separate project for development.

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/) and enable the
   **Google Health API**.
2. Under **Google Auth Platform**:
   * **Branding / Audience:** user type *External*, publishing status *Testing*. Add your Google account
     (and up to 100 others) as **test users**.
   * **Data access:** add the scopes `https://www.googleapis.com/auth/googlehealth.nutrition.readonly`
     and `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly`.
   * **Clients → Create client → Web application.** Under **Authorized JavaScript origins** add every
     origin the app runs on, for example `http://localhost:5173` (dev), `http://localhost:4173` (preview)
     and `https://<github-user>.github.io` (Pages). No redirect URI is needed.
3. Copy the client ID. It is public (it identifies the app; it is not a secret). Put it in `.env.local`
   as `VITE_GOOGLE_CLIENT_ID=...` (see `.env.example`), or in the `GOOGLE_CLIENT_ID` repository variable
   for deployments.

Each user must also have opened the **Google Health app** on a phone and signed in once. Otherwise the API
answers `ACCOUNT_NOT_LINKED`, which the app detects and explains.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Without `VITE_GOOGLE_CLIENT_ID`, a "Developer setup" screen asks for the
client ID instead.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 5173 |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` for the app and the index builder |
| `npm run build:index -- --input <export.jsonl.gz>` | Build the food index into `public/food-index/` (ignored by git) from an Open Food Facts export, for local development |
| `npm run build:generics` | Rebuild `src/food/data/generics.json` (committed) from the AFCD and USDA FNDDS downloads |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve `dist/` on port 4173 |

## Deploy

`.github/workflows/ci.yml` tests and builds every push and pull request, and publishes `dist/` to
**GitHub Pages** on pushes to `main`. To enable it:

1. Repository **Settings → Pages → Source: GitHub Actions**.
2. Set `GOOGLE_CLIENT_ID` as a repository secret or variable (Settings → Secrets and variables →
   Actions) so the client ID is built in. It ends up in the published JavaScript either way: the client
   ID is a public identifier, not a credential.
3. Add the Pages origin to the OAuth client's Authorized JavaScript origins.

Any static host works. The build uses relative paths, so it can live under a sub-path.

### Food index

Food search reads a static index of the Open Food Facts database hosted on **Cloudflare Pages** (design:
[docs/FOOD_SEARCH.md](docs/FOOD_SEARCH.md)). `.github/workflows/food-index.yml` builds it from the Open Food
Facts export and deploys it weekly, or when run from the Actions tab. It is never committed to git. Without
an index the app falls back to the sample foods. Product data © Open Food Facts contributors, ODbL. Generic foods come from a small committed file of Australian and US government data, shown first and tagged with their source: © Food Standards Australia New Zealand, and USDA (see `public/generics-LICENSE.txt` and `npm run build:generics`).

One-time setup:

1. Preferably create a **separate free Cloudflare account** for this project (Accounts → Create Account;
   up to five extra free accounts per user). A Pages token can edit every Pages project in its account, so
   a dedicated account keeps this project and your others fully apart.
2. In that account, create an **Account API token** with only **Account → Cloudflare Pages → Edit**, and copy
   the **account ID**.
3. In GitHub, create the environment **food-index** (Settings → Environments), limit its deployment
   branches to `main`, and add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` there.
   Only workflows running from `main` can then use the token.
4. Run the **Food index** workflow. It creates the Pages project `food-diary-index` on its first run (set
   the repository variable `CLOUDFLARE_PAGES_PROJECT` to use another name). It refuses to deploy to an
   existing project that is not this repository's index: every deploy carries a `food-index-owner.json`
   marker, which the next deploy checks first.
5. Give the project a custom domain: Workers & Pages → the project → **Custom domains** → set up
   `food-index.froussios.com` with **My DNS provider**, then add the CNAME it asks for at the DNS host
   (`food-index` → `food-diary-index.pages.dev`). Some networks intercept `*.pages.dev` (the University of
   Sydney's firewall does), and a domain of your own avoids that.
6. Set the **repository variable** (not a secret or an environment variable) `FOOD_INDEX_URL` to
   `https://food-index.froussios.com/`, so the CI build points the app at it. Re-run CI after changing it.

## Project layout

```
src/
  core/      domain logic, no I/O: units, nutrients, food model, Open Food Facts normaliser, ids, time
  health/    Google Health API types (from the discovery document), client and mapping
  auth/      Google Identity Services token flow
  food/      FoodCatalog interface, the static index engine and catalogue, sample foods
  ui/        DOM helpers, log form, food search combobox, diary table
pipeline/    food index builder (Open Food Facts export → public/food-index/), generic foods builder
  main.ts    app shell
tests/       Vitest unit tests
docs/        architecture and decisions
```

## Known limitations (see the architecture doc)

* Access tokens last about an hour; click **Continue** when asked. Long-lived sessions are planned for a
  later milestone (they need refresh tokens, which Google only issues through the client secret).
* The app never queries the public Open Food Facts API (its rate limits are too low). Food search uses our
  own static index of the Open Food Facts export, matching exact words (no typo tolerance).
* Only entries made by this app can be deleted (the write scope covers only the app's own data).
* While the OAuth app is in *Testing*, only listed test users (up to 100) can sign in.
