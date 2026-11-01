# Food Diary

A food diary that runs entirely in the browser and stores every entry in the user's own
**Google Health** account (the successor of the Fitbit Web API). There is no backend and no database.

This is milestone 0, a proof of concept:

1. Sign in with Google and grant Google Health nutrition access.
2. Log an entry from a small sample catalogue (written as Open Food Facts records, the database used from
   milestone 1) or from a custom food, in g, ml, household measures or portions.
3. See today's entries and totals in a table, and delete entries.

The design, the API facts it relies on and the open trade-offs are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Google Cloud setup (once)

You need your own Google Cloud project and OAuth client. The Google Health API has no sandbox, so use a
separate project for development.

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/) and enable the
   **Google Health API**.
2. Under **Google Auth Platform**:
   * **Branding / Audience:** user type *External*, publishing status *Testing*. Add your Google account
     (and up to 100 others) as **test users**.
   * **Data access:** add the scope `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly`.
   * **Clients → Create client → Web application.** Under **Authorized JavaScript origins** add every
     origin the app runs on, for example `http://localhost:5173` (dev), `http://localhost:4173` (preview)
     and `https://<github-user>.github.io` (Pages). No redirect URI is needed.
3. Copy the client ID. It is public (it identifies the app; it is not a secret).

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

Open http://localhost:5173 and paste the client ID on the setup screen. Or put it in `.env.local` as
`VITE_GOOGLE_CLIENT_ID=...` (see `.env.example`) to build it in.

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
2. Optionally set a repository variable `GOOGLE_CLIENT_ID` (Settings → Secrets and variables → Actions →
   Variables) to build the client ID in. Without it, users enter it on the setup screen.
3. Add the Pages origin to the OAuth client's Authorized JavaScript origins.

Any static host works. The build uses relative paths, so it can live under a sub-path.

## Project layout

```
src/
  core/      domain logic, no I/O: units, nutrients, food model, Open Food Facts normaliser, ids, time
  health/    Google Health API types (from the discovery document), client and mapping
  auth/      Google Identity Services token flow
  data/      sample food catalogue (Open Food Facts format, arbitrary values)
  ui/        DOM helpers, log form, diary table
  main.ts    app shell
tests/       Vitest unit tests
docs/        architecture and decisions
```

## Known limitations (see the architecture doc)

* Google publishes only a **write-only** nutrition scope, so the app lists only the entries it wrote itself,
  not entries from the Google Health app or other apps.
* Access tokens last about an hour, and the app has no refresh tokens without a backend. Click **Continue**
  when asked.
* While the OAuth app is in *Testing*, only listed test users (up to 100) can sign in.
