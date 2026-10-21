# izaro-eye

Visual regression testing from the browser. Record a flow against your application under test (AUT) the way you would with Playwright codegen or Selenium IDE, keep a screenshot per step as the baseline, replay it later, and let **jev-img** (TypeSafe Jev 1.14 visual processing) classify what changed.

```
record ──► test case ──► baseline run ──► screenshots (baseline)
                              │
                 rerun ───────┴──► screenshots ──► pixel diff ──► jev-img ──► pass / fail / review
```

## How it works

- **Recorder.** The server launches Chromium and streams it into the web UI (CDP screencast). Your mouse and keyboard are forwarded into that browser while an injected script records clicks, typing, selects, checkboxes and key presses. Each step stores a ranked list of selectors (`data-testid` → role + name → id → name/placeholder → text → CSS path).
- **Assertions.** Switch to *Add assertion*, click an element, and choose *is visible*, *text contains/equals*, *value is*, *visual checkpoint* (element screenshot judged by jev-img), or *assert current URL*.
- **Login.** Projects can define a login (URL, field selectors, credentials). Credentials are written as `{{env:AUT_USERNAME}}` / `{{env:AUT_PASSWORD}}` and read from the server environment, never stored in the database. Typed passwords are saved as `{{env:AUT_PASSWORD}}`.
- **Baseline.** Saving a recording immediately replays it in a clean browser and stores those screenshots as baseline v1 (same viewport, locale, timezone, no animations), so baseline and reruns are captured under identical conditions.
- **Rerun.** Each step is replayed with selector fallback (a fallback match is reported as *healed*), DOM assertions run, and the screenshot is compared:
  1. **Pixel diff** (pixelmatch). Below `PIXEL_IDENTICAL_THRESHOLD` the step passes without calling jev-img.
  2. **jev-img.** Baseline and rerun are sent to Jev with four questions: *same state?* (noul), *error page?* (noul), *which kind of change?* (choice) and *where?* (box). The answer maps to a label: `identical`, `noise`, `cosmetic_change`, `content_change`, `layout_regression`, `missing_element`, `error_page`.
  3. **Policy.** `identical`/`noise` pass, `layout_regression`/`missing_element`/`error_page` fail, everything else (and anything under 70% confidence) goes to review.
- **Review.** Side-by-side with the changed region highlighted, opacity overlay, and pixel diff. *Accept as new baseline* or *Mark as bug*.
- **Export.** Any test can be downloaded as a standalone Playwright `.spec.ts`.

## Run locally

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm --filter @izaro/server exec playwright install chromium
cp .env.example apps/server/.env   # then edit
pnpm demo-aut                      # optional sample app on :5050 (admin/admin)
pnpm dev                           # API on :4000, UI on :5173
```

Open http://localhost:5173, create a project (for the demo: base URL `http://localhost:5050/dashboard`, submit selector `[data-testid="login-submit"]`), then **Record new test**.

To see a regression with the demo app, run `curl -X POST localhost:5050/__variant -d '{"variant":"broken"}'` and then *Run regression*.

Docker: `docker build -t izaro-eye . && docker run -p 4000:4000 --env-file .env -v izaro-data:/data izaro-eye`.

## jev-img configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | Without it, a local heuristic classifier is used and anything changed goes to review. |
| `TYPESAFE_API_URL` | `https://api.typesafe.ai/v1/systemone` | |
| `JEV_MODEL` | `jev-1.14.0` | Pin explicitly; Box needs 1.14. |

Images and Box are beta in Jev 1.14 and need the `TypeSafe-Danger-Zone-Images: true` header (sent automatically). Screenshots are fitted to Jev's limits (PNG, 280–1568 px per side) before upload. The `choice` question shape is not in TypeSafe's public examples yet; verify it in `apps/server/src/compare/jev.ts` against docs.typesafe.ai before production use.

## Layout

```
apps/server        Fastify API, recorder, replay runner, comparison, SQLite + on-disk image store
apps/web           React UI (Vite)
packages/shared    Types and the recorder WebSocket protocol
examples/demo-aut  Small login + order app used by the e2e test
```

## Tests

`pnpm test` runs unit tests for the pixel diff and jev-img request/response handling, plus an end-to-end test that records a flow on the demo app, creates a baseline, confirms an unchanged rerun passes, and confirms a broken layout is flagged.

## Not yet

Postgres/S3 storage adapters, BullMQ workers for horizontal scaling, suites and schedules, a CI trigger CLI, multi-browser, popups/new tabs and iframes in the recorder, user accounts.
