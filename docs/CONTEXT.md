# izaro-eye: project context

The standing facts about izaro-eye: what it is for, the rules it follows, how it is built and how work on it is done. Read this before changing anything. The dated history of changes and the reasons behind them is in [EPISODES.md](EPISODES.md).

## Goal

izaro-eye is a web app for visual regression testing of web applications.

1. **Record.** You click through the application under test (AUT) in a browser streamed into izaro-eye. izaro-eye captures every screen into a **screen library**, and writes what you did as a **business scenario** in plain sentences.
2. **Write.** Once the screens are captured, you write new scenarios yourself, in plain English, with no recording.
3. **Run.** izaro-eye runs scenarios using screenshots only. jev-img finds each control on screen and judges each screen against the library.

The end state: users write test scenarios in plain English and the app executes them.

## Product principles

These are decisions Pradeep made. Follow them unless he changes them.

- **Images only. No DOM locators anywhere.** No CSS or XPath selectors, test ids or DOM queries, whether in recording, running or comparing. Playwright is used only for the mouse, the keyboard, screenshots, navigation and the screencast. (Pradeep: "This product will use only images.")
- **jev-img (TypeSafe Jev) does all the seeing.** Scenarios use fixed sentence patterns, and they are read and executed by Jev only. (Decision card choice: "Jev only, fixed sentence patterns".)
- **Recording and running are separate.** A failing scenario must never stop anyone from recording. Recording starts from the project's address and replays nothing by default. *Start from: after "X"* on the record page is opt-in, and if X stops partway, recording still begins from the screen it reached.
- **The setup scenario is for runs only.** It runs before every other scenario, and it must be obvious when it does. In a run its steps are folded under "Setup scenario: X", and the editor says which setup will run first.
- **No browser or OS dialogs** (`confirm`, `alert`, `prompt`). Use in-page controls, such as Save and Cancel next to a changed setting.
- **One-page workspace.** Projects and scenarios are in the left tree. The work is in the centre: the scenario editor and its run side by side, with the live browser, video and steps. Logs (TypeSafe AI, browser and runner) are on the right. Every split can be resized, and the sizes are remembered per browser.
- **Examples in the UI are generic.** Use labels like "Sign in" or "Email", never a customer site's, so they can't be mistaken for someone's real steps.

## Scenario language

One sentence per step. The parser is `packages/shared/src/scenario.ts` (`parseStep`, `STEP_PATTERNS`).

| Pattern | Example |
| --- | --- |
| `Click "label"` | `Click "Sign in"` |
| `Enter "value" in "field"` | `Enter "jane@example.com" in "Email"` |
| `Choose "option" in "dropdown"` | `Choose "Canada" in "Country"` |
| `Press "key"` | `Press "Enter"` |
| `Scroll down` / `Scroll up` | |
| `Go to "address"` | `Go to "/settings"` |
| `Expect the "name" screen` | `Expect the "Home" screen` |
| `Expect to see "text"` | `Expect to see "Welcome back"` |
| `Run "scenario"` | `Run "Log in"` (nesting depth up to 5) |
| `Wait N seconds` | `Wait 2 seconds` |

Secrets are written as `{{secret:NAME}}` and read from the server's environment, for example `AUT_PASSWORD`. They are never stored. A recorded element nobody has named yet shows as `"?"`.

### Step library

Each project has a **step library**: reusable steps in the project's own words, made of base steps (`packages/shared/src/steps.ts`, table `steps`, API `/api/projects/:id/steps` and `/api/steps/:id`).

- A library step has a **sentence** with `{values}`, e.g. `Search for "{term}"`, a **kind** (action, flow or check), an **intent** in business words, optional **starts on / ends on** screens, **tags** and a **body** of steps that use the same `{values}`. Body lines keep their recorded element links, so runs still use the exact-image match.
- A scenario line that is not a base step is matched against the library (`matchLibraryStep`; quoted values, smart quotes and spacing are tolerated, the most specific sentence wins). **Base steps always win**, so a sentence that would read as a base step is refused.
- `flatten` expands library steps like `Run`, with the values filled in, up to the same depth of 5. In a run they fold under the scenario line, e.g. `Order "Gadget"`, tagged "library step".
- Safeguards: sentences are unique per project; a body can only use `{values}` from its sentence; scenarios must pass real values (no `{x}` left); a step can't use itself, even through another step; a step in use can't be deleted (the API answers 409 with who uses it). Changing a sentence rewrites every scenario and step that uses it, as long as its `{values}` stay the same and in the same order.
- In the UI: the **Step library** tab and tree item, the step editor (`/steps/:id`), **Make reusable step** in the scenario editor (selected lines, or all of them), suggestions under the editor as you type, and the library listed under Step patterns.
- Later phases (see the design doc *Step library: design proposal*): suggestions mined from recordings, start/end screen checks, health and impact, coverage, and exporting the library as an agent skill.

## How it works

- **Recorder** (`apps/server/src/recorder/session.ts`). It runs Chromium and streams it over a CDP screencast, and the UI sends mouse and keyboard input back. On each click it crops the control's image, which jev-img bounds using a screenshot marked with a crosshair, and adds `Click "?"`. Typing turns that step into `Enter`. Each time the screen settles, it is matched against the library: same address with pixel difference ≤3%, a different address ≤0.2%, otherwise Jev's "same screen?" check at ≥0.8 on up to 3 candidates. New screens are added with an `Expect the "…" screen` step.
- **Executor** (`apps/server/src/runner/executor.ts`). `flatten` expands `Run` steps and puts the setup scenario first. For each step:
  1. **Exact match.** If the library crop is pixel-identical (≤1%) at the same place, act on it without calling Jev.
  2. **Jev find.** Otherwise ask Jev "present?" and "where?", with the library crop as a hint. If it isn't found, retry after a 1-second pause, then after scrolling (up to 3 times).
  3. **Confidence.** ≥0.8 acts normally. 0.5–0.8, or a box under 0.25× or over 4× the recorded size, acts but marks the step **review**. Below 0.5 fails the step and skips the rest.
  4. **Screen check.** A pixel diff, then Jev classifies the change as identical, noise, cosmetic_change, content_change, layout_regression, missing_element or error_page.
- **Review.** Accepting a changed screen updates the library. Accepting a step that Jev had to search for updates that control's image, so the next run is an exact match again.
- **Run streaming.** Over the WebSocket `/api/runs/:id/events`: `state`, `frame` (live screencast), `logs` and `log`. Logs come from `typesafe` (every Jev question and its answer, through `LoggedVision`), `browser` (console messages, page errors, failed requests, responses ≥400, navigations) and `runner`. They are stored in the `run_logs` table.
- **Video.** Playwright's `recordVideo` is saved to `<data>/videos/<runId>.webm` and served at `/api/runs/:id/video`. If saving fails, the run carries on and a warning is logged.

## Insights

A project's **Insights** tab (`apps/server/src/insights.ts`, `GET /api/projects/:id/insights`, `pages/Insights.tsx`) reports on each scenario's latest finished run, with trends from up to its last 10 runs. It was modelled on Playwright Smart Reporter's Insights page.

- Tiles: failed (and how many are newly failing), pass rate, total duration, scenarios (new in the last 7 days, never run), flaky, and a health grade. A pass/review/fail/not-run bar sits under the tiles.
- **Review is not failure.** A run in review counts as not failing in trends, and as half a pass in the health score.
- Sections:
  - Visual changes to review, grouped by jev-img's label.
  - Failure clusters: errors grouped with quoted labels and numbers taken out.
  - Regressions (failed after passing) and Fixed (passed after failing).
  - At risk: passing now, but failed within the 5 runs before the last one.
  - Slowest.
  - Most flaky: 3 or more pass/fail switches.
  - New scenarios.
- Health: pass score × 0.6 + stability × 0.25 + performance × 0.15. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, otherwise F. Performance is the share of scenarios whose latest run took no more than 1.5× their median time.
- **AI summary (optional, off by default):** on request, Claude (`claude-opus-5-5`, low effort, with server-side refusal fallback) writes 3–5 sentences from the computed insights only (no screenshots or secrets). It turns on only when `ANTHROPIC_API_KEY` is set in `apps/server/.env`; without it the section is hidden, the SDK is never loaded and nothing is sent to Anthropic. Pradeep: it is "not mandatory feature. it is optional feature". TypeSafe Jev is a vision model, so it isn't used for text.

## jev-img / TypeSafe

- API: `https://api.typesafe.ai/v1/systemone`, model `jev-1.14.0`, which is needed for Box visual processing. Requests send the header `TypeSafe-Danger-Zone-Images: true`.
- Questions used: noul `same`, `error`, `present`; choice `category`; box `changed`, `where`. Images are fitted to 280–1568 px per side as PNG.
- `JevVision` is the live client. `LocalVision` is the offline fallback: exact pixel matches only, plus heuristics. Tests use a `FakeJev` that answers from DOM-measured boxes, and it exists in tests only.
- `pnpm --filter @izaro/server jev:check` asks each question once and prints the answers and timings.

## Architecture

```
apps/server        Fastify 5 API + WebSocket, recorder, executor, screen library, jev client
                   SQLite via node:sqlite (izaro-v2.db, JSON documents per table), images on disk by sha256
apps/web           React 19 + Vite 7 + react-router 7 one-page workspace
packages/shared    Types, the scenario sentence parser, recorder and run WebSocket messages
examples/demo-aut  Small login + order app on :5050 (variant "broken" for regressions)
```

Key web files: `App.tsx` (workspace grid and splitters), `workspace/ProjectTree.tsx`, `workspace/LogsPane.tsx`, `workspace/RunStream.tsx` (one WebSocket per open run), `workspace/Splitter.tsx` (`usePaneSize`, `Splitter`), `pages/ScenarioEditor.tsx` (editor and run on one page, `?run=`), `pages/RunDetail.tsx` (stage, steps with setup grouping), `pages/Recorder.tsx`, `pages/ProjectDetail.tsx`, `pages/StepEditor.tsx` (step editor and the Step library tab), `pages/Insights.tsx`.

## Environment and running

- Node 26 (`.nvmrc`). pnpm 10 or newer, installed with `npm i -g pnpm` because Node 26 has no corepack.
- `pnpm install`, `pnpm --filter @izaro/server exec playwright install chromium`, then `cp .env.example apps/server/.env` and `pnpm dev` (API on :4000, UI on :5173).
- A project can have its own TypeSafe key (project page › Settings). It is write-only: stored server-side in `project_secrets`, never returned or logged. Without one, the server key is used.
- `apps/server/.env` holds `TYPESAFE_API_KEY`, `AUT_PASSWORD` and the optional `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `TYPESAFE_API_URL`, `JEV_MODEL`, `BROWSER_CHANNEL`, `CHROMIUM_PATH` and `DATA_DIR`.
- Tests: `pnpm test` (parser, step library, pixel diff, Jev requests, project settings, insights, and end-to-end tests on the demo app). There are 28 tests.

## Working agreements

- **Repo:** `ModernAIPro/izaro-eye`. Work lands on the **`mvp`** branch. **Ask Pradeep before pushing** to mvp, opening PRs or creating repositories, unless he has already said yes to that change.
- **Secrets:** the TypeSafe and Anthropic API keys and the AUT login live only in the local, gitignored `apps/server/.env`. They never go into commits, docs, archives or artifacts. Before every push, check that `git log -p` has no `apikey_` and that no `.env` is tracked.
- When Pradeep says to skip tests for a task, build and typecheck only.
- Commits end with the Claude co-author and session attribution lines.

## Known gaps

- Video saving could not be verified in the cloud sandbox, because Playwright's ffmpeg there doesn't match. It should work after `playwright install chromium`.
- Not built yet: goal-level steps that need planning across screens ("buy the cheapest plan"), Postgres/S3 storage, workers for scale, suites and schedules, multiple browsers, popups and new tabs.
