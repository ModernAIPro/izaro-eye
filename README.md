# izaro-eye

Image-based testing for web applications. You click through your app once; izaro-eye captures every screen into a **screen library** and writes what you did as a **scenario** in plain sentences. Scenarios, recorded or written by hand, are then executed purely from screenshots: **jev-img** (TypeSafe Jev 1.14 visual processing) finds each control on screen and judges each screen against the library. No DOM locators are used anywhere.

```
record ──► screen library (screens + element images) ──┐
   └─────► scenario (plain sentences) ─────────────────┴─► executor ─► screenshot ─► jev-img find / compare ─► pass / review / fail
                write new scenarios by hand ──────────────────┘
```

## Scenarios

One sentence per step, following these patterns (quoted text is what you see on screen, or an exact value):

| Pattern | Example |
| --- | --- |
| `Click "label"` | `Click "Shop individual and family plans"` |
| `Enter "value" in "field"` | `Enter "94105" in "ZIP code"` |
| `Choose "option" in "dropdown"` | `Choose "Family" in "Coverage"` |
| `Press "key"` | `Press "Enter"` |
| `Scroll down` / `Scroll up` | |
| `Go to "address"` | `Go to "/dashboard"` |
| `Expect the "name" screen` | `Expect the "Plans" screen` |
| `Expect to see "text"` | `Expect to see "Plans available in your area"` |
| `Run "scenario"` | `Run "Sign in"` |
| `Wait N seconds` | `Wait 2 seconds` |

Secrets are written as `{{secret:NAME}}` and read from the server environment (e.g. `AUT_PASSWORD`), never stored. The parser lives in `packages/shared/src/scenario.ts`.

## How it works

- **Recording.** The server runs Chromium and streams it into the web UI; your mouse and keyboard are forwarded to it. For every click izaro-eye saves an image of the control (jev-img finds its edges from a crosshair-marked screenshot) and adds a `Click "?"` step; typing turns it into `Enter "..." in "?"`. You name each `?` the way a user would describe it. Each time the screen settles, it is matched against the library (pixels first, jev-img "same screen?" for the same address) and new screens are added, with an `Expect the "..." screen` step.
- **Screen library.** Screens with their names, addresses, the controls used on them (image + name) and which control leads to which screen. Names can be edited on the project's *Screen library* tab.
- **Setup scenario.** Record sign-in as an ordinary scenario and pick it as the project's setup scenario; it runs before every other scenario. Recording is separate from runs: it starts from the project's address, or, if you choose *Start from: after "Sign in"* on the record page, after replaying that scenario. A scenario that fails never stops you from recording.
- **Execution.** For each step:
  1. *Exact match*: if the control's library image is still pixel-identical at the same place, it is clicked without calling jev-img.
  2. *jev-img find*: otherwise jev-img is asked "is the "label" control visible?" and "where is it?" (with the library image as a hint). It retries after a pause and after scrolling.
  3. *Confidence*: ≥ 80% acts normally; 50–80% (or a box of very different size) acts but marks the step **review**; below 50% fails the step and skips the rest.
  4. *Expect the screen*: the screenshot is compared with the library screen (pixel diff, then jev-img classification: `identical`, `noise`, `cosmetic_change`, `content_change`, `layout_regression`, `missing_element`, `error_page`). *Expect to see*: jev-img "does the screen show this text?".
- **Review.** Accepting a changed screen updates the library; accepting a step jev-img had to search for updates that control's image, so the next run is an exact match again.

## Run locally

Requires Node 26 (see `.nvmrc`) and pnpm 10 or newer. Node 26 no longer ships corepack, so install pnpm with npm.

```bash
npm i -g pnpm
pnpm install
pnpm --filter @izaro/server exec playwright install chromium
cp .env.example apps/server/.env   # add TYPESAFE_API_KEY and AUT_PASSWORD
pnpm demo-aut                      # optional sample app on :5050 (admin/admin)
pnpm dev                           # API on :4000, UI on :5173
```

If the Chromium download cannot finish, install Google Chrome and set `BROWSER_CHANNEL=chrome` in `apps/server/.env` to use it instead.

Open http://localhost:5173, create a project with the app's start address (demo: `http://localhost:5050`), then **Record**. For the demo, record signing in (click the username field, type `admin`, click the password field, *Insert secret*, click *Sign in*), name the elements, save it as "Sign in" and choose it as the setup scenario. To record behind the login, pick *Start from: after "Sign in"* on the record page.

To see a regression with the demo app, run `curl -X POST localhost:5050/__variant -d '{"variant":"broken"}'` and run a scenario again.

Docker: `docker build -t izaro-eye . && docker run -p 4000:4000 --env-file .env -v izaro-data:/data izaro-eye`.

## jev-img configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | Required to find elements that moved and to check text. Without it, scenarios only run while every control is pixel-identical to the library. |
| `TYPESAFE_API_URL` | `https://api.typesafe.ai/v1/systemone` | |
| `JEV_MODEL` | `jev-1.14.0` | Pin explicitly; Box needs 1.14. |

`pnpm --filter @izaro/server jev:check` asks each jev-img question once on synthetic screens and prints the answers and timings.

Jev's image input and Box are beta and need the `TypeSafe-Danger-Zone-Images: true` header (sent automatically). Screenshots are fitted to Jev's limits (PNG, 280–1568 px per side) before upload. One call with two screenshots used about 13,000 input tokens in testing.

## Layout

```
apps/server        Fastify API, recorder, screen library, executor, jev-img client, SQLite + on-disk image store
apps/web           React UI (Vite)
packages/shared    Types, the scenario sentence parser and the recorder WebSocket protocol
examples/demo-aut  Small login + order app used by the e2e test
```

## Tests

`pnpm test` runs unit tests for the sentence parser, pixel diff and jev-img requests, and an end-to-end test on the demo app (with a stand-in for jev-img) that records sign-in, builds the library, runs a recorded scenario with exact matches, finds moved controls after a layout change, and runs a hand-written scenario.

## Not yet

Goal-level steps that need planning across screens ("buy the cheapest plan"), Postgres/S3 storage, workers for scale, suites and schedules, multi-browser, popups/new tabs.
