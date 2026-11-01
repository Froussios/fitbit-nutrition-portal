# Food Diary

A food diary that runs entirely in the browser and stores every entry in the user's own
**Google Health** account (the successor of the Fitbit Web API). There is no backend and no database.

This is milestone 0, a proof of concept:

1. Sign in with Google and grant Google Health nutrition access (read and write).
2. Log an entry from a small catalogue of local fake foods (written as Open Food Facts records) or from a
   custom food, in g, ml, household measures or portions.
3. See today's whole Google Health nutrition diary, whichever app logged each entry, with amounts and
   totals. Entries made by this app can be deleted.

The design, the API facts it relies on and the open trade-offs are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Google Cloud setup (once, by the developer)

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
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve `dist/` on port 4173 |

## Deploy

`.github/workflows/ci.yml` tests and builds every push and pull request, and publishes `dist/` to
**GitHub Pages** on pushes to `main`. To enable it:

1. Repository **Settings → Pages → Source: GitHub Actions**.
2. Set the repository variable `GOOGLE_CLIENT_ID` (Settings → Secrets and variables → Actions →
   Variables) so the client ID is built in.
3. Add the Pages origin to the OAuth client's Authorized JavaScript origins.

Any static host works. The build uses relative paths, so it can live under a sub-path.

## Project layout

```
src/
  core/      domain logic, no I/O: units, nutrients, food model, Open Food Facts normaliser, ids, time
  health/    Google Health API types (from the discovery document), client and mapping
  auth/      Google Identity Services token flow
  food/      FoodCatalog interface and the local fake catalogue (Open Food Facts format)
  ui/        DOM helpers, log form, diary table
  main.ts    app shell
tests/       Vitest unit tests
docs/        architecture and decisions
```

## Known limitations (see the architecture doc)

* Access tokens last about an hour; click **Continue** when asked. Long-lived sessions are planned for a
  later milestone (they need refresh tokens, which Google only issues through the client secret).
* The app never queries the public Open Food Facts API (its rate limits are too low). Food search will use
  a mirror; for now the catalogue is local fake data.
* Only entries made by this app can be deleted (the write scope covers only the app's own data).
* While the OAuth app is in *Testing*, only listed test users (up to 100) can sign in.
