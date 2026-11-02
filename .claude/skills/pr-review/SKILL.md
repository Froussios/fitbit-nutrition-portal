---
name: pr-review
description: Review a Fitbit Nutrition Portal pull request for its author and end with a verdict that decides automatic approval. Use for "review PR N", "@claude review", and the automatic review workflow (.github/workflows/claude-code-review.yml).
---

# Reviewing a Fitbit Nutrition Portal pull request

You are reviewing a pull request for its author, who wants to know what blocks merging, what is
worth a second look, and what nobody has checked. Be specific and brief. Don't praise the change
and don't restate the diff.

The automatic review workflow reads this file from the base branch. Edits to it take effect for
reviews once they are merged, and a PR that edits it is reviewed under the old version.

## The project

- `function.ts`: an Express app exported as a Google Cloud Function (gen2, Node 22), or run
  locally with `--local`. It serves the API and the built frontend from `static/`.
- `static/`: the frontend, a separate package. Lit web components in `static/scripts/`
  (TypeScript, strict), bundled by Parcel from `static/static/index.html`.
- `package.json`: build, serve and deploy scripts; `config` holds the function name, GCP project
  and region. `yarn.lock` files pin dependencies for both packages.
- If a `CLAUDE.md` exists, it is the project standard and its rules take precedence over the
  defaults below.

## Gather

1. `gh pr view <n>` for the title, description and earlier comments, and `gh pr diff <n>` for the
   change. A large diff is saved to a file; read it in parts with `grep`, `head` and Read. You
   may keep notes and a copy of the diff under `/tmp`.
2. Read the surrounding code and docs that the change touches or relies on. The checkout is the
   PR's code, except `CLAUDE.md` and `.claude/`, which come from the base branch.
3. If an earlier review on this PR listed blocking issues, note each one: you will say whether
   this version fixes it.

You can't build, run tests or run the project's scripts. Don't try to work around that.

## Judge

An issue **blocks** merging when it is one of these:

- A bug: wrong results, a crash, an unhandled promise rejection in a request handler, a broken
  error path, a race, lost data. Nutrition values with wrong units or wrong day boundaries
  (time zones) count as wrong results.
- A security or privacy problem. This app handles Fitbit OAuth tokens and personal health data:
  - a secret, OAuth client secret, access or refresh token committed to the repo, sent to the
    browser, put in a URL, or logged;
  - personal health data logged, or sent anywhere other than the user's own browser and Fitbit;
  - an endpoint that returns or changes one user's data without checking who is asking;
  - missing OAuth `state`/PKCE checks, open redirects, or a token stored where page scripts or
    other users can read it;
  - XSS: user or API data rendered as HTML (`unsafeHTML`, `innerHTML`) instead of through Lit
    bindings; `eval` or new inline scripts;
  - user input passed unchecked to file paths, shell commands or outbound URLs.
- A change that breaks the build or deploy: a TypeScript error the strict configs would reject, a
  new import with no matching dependency in the right `package.json`, a `package.json` change
  without the matching `yarn.lock` change, or a deploy script/`config` change that would point at
  the wrong project, region or runtime.
- A secret or real project id placed in `package.json` `config` or any other committed file.
- Changed behaviour with no test, once the project has a test suite.
- Docs or README that no longer match the code they describe.

Everything else is non-blocking: naming, structure, small simplifications, wording, styling, a
missing test for an edge case that the PR didn't touch. Don't flag pre-existing problems unless
the PR makes them worse. Don't flag what you aren't confident about as blocking. Put it under
observations and say what would settle it.

## Write

Write the review in this order:

1. **Blocking issues.** For each: where it is, why it blocks, and what would fix it. Write "None."
   if there are none.
2. **Re-review** (only if an earlier review listed blocking issues): each earlier issue, and
   whether this version fixes it.
3. **Observations.** Non-blocking points, one or two lines each.
4. **Not checked.** What you couldn't verify, such as the build, type checks or the deployed
   function's behaviour.

Add an inline comment for each issue tied to specific lines, as well as listing it in the review.

Comment only. Don't approve, request changes, push or edit files. Approval is decided by the
workflow from your verdict.

End the review with exactly one of these lines, and nothing after it:

**Verdict:** blocking

**Verdict:** no blocking issues

Use `no blocking issues` only when the Blocking issues section is "None.".
