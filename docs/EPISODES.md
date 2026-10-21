# izaro-eye: episodes

What happened on the project, in order, and why. Each entry gives the request, what was done and the commit. The standing rules these episodes produced are collected in [CONTEXT.md](CONTEXT.md). Add a new entry for each change.

## 2026-10-21

### 1. The idea and the first MVP (`59ed2bb`, `ac9d462`)
**Ask:** a web app like Selenium IDE or Playwright codegen. The user clicks through the AUT, types and adds assertions. izaro-eye stores the screenshots as baselines, turns the session into a test case to re-run, and uses jev-img to classify differences during regression runs.
**Done:** pnpm monorepo (Fastify server, React UI, shared types). Recorder, baselines, replay and jev-img classification. A demo AUT behind an admin/admin login, with the credentials kept in env. `apps/server/.env` is loaded on startup, and a `jev:check` script was added.
**Notes:** jev-img is TypeSafe Jev with Box visual processing (jev-1.14.0). The repo was created by Pradeep under ModernAIPro. React was chosen for the frontend.

### 2. Matching the live TypeSafe API (`0a5ab72`)
The request shape was checked against the live API, including the danger-zone image header and the image size limits. The API key is kept only in the local `.env`.

### 3. Node 26 (`eda7541`)
**Ask:** "upgrade the app to latest node". **Done:** Node 26, pnpm 12 (installed with npm, since there's no corepack) and Playwright 1.64.

### 4. No locators: images only (`dd2bff0`)
**Trigger:** a re-run failed with "No selector matched" on *Shop individual and family plans*. Pradeep: "No - I dont want to use any locators. This product will use only images." He also clarified: recording exists to collect the app's screens and to write the test as a business scenario, and eventually users will just write scenarios in plain English. He picked **"Jev only, fixed sentence patterns"**.
**Done:** a full redesign around a **screen library** and **plain-sentence scenarios**. Steps are executed by exact image match first, then Jev find and confidence levels, then the screen check. Also added: the setup scenario, `Run "…"` nesting and `{{secret:NAME}}`. Pushed to mvp on Pradeep's "push to mvp".

### 5. Single-page workspace (`5029822`)
**Ask:** projects and the run view were two screens. Pradeep wanted one page, with projects and a scenario tree on the left, the execution in the centre (Chrome rendering and video) and TypeSafe AI and browser logs on the right.
**Done:** a three-pane workspace, live CDP screencast, run video, and per-run logs from three sources (typesafe, browser, runner) stored in `run_logs`.

### 6. Resizable panes (`c58c738`)
**Ask:** the left navigation and the right logs should be resizable, and the video and steps should be split and resizable. **Done:** a `Splitter` with sizes remembered per browser. Double-click resets a split, and arrow keys move it.

### 7. No black bars around the video (`16d258e`)
**Trigger:** wide black bars on each side of the video. **Done:** the panel takes the recording's shape. On wide screens the steps move beside the video, and on narrow ones they sit below it. Tests were skipped at Pradeep's request.

### 8. Edit and run on one page (`8c18641`)
**Ask:** "Why we need to have different view. We have lot of space." **Done:** the scenario page holds the editor on the left and the run on the right. Run starts in place, a picker shows earlier runs, and tree links and `/runs/:id` open this page.

### 9. Resizable step patterns (`95a9866`)
**Ask:** the editor and Step patterns were fixed blocks. **Done:** a drag handle between them, and the patterns scroll on their own.

### 10. Record was blocked by a failing setup scenario (`db1b8b9`, `1521eaa`)
**Trigger:** Record showed only the address bar and an error. The cause: Test 2 was the setup scenario and failed, and recording ran the setup first.
**First fix:** recording starts anyway and shows a notice.
**Pradeep's principle:** "We should not link test run failure and record module, these are 2 different tasks."
**Final fix:** recording never replays a scenario by default. *Start from: after "X"* was added as an opt-in. The setup scenario applies to runs only.

### 11. Step pattern examples looked like Test 2, and the setup tag moved (`2fdfeeb`)
**Trigger:** the new Search_Test scenario seemed to show Test 2's steps under Step patterns, and the "setup" tag had moved to Search_Test.
**Cause 1:** the examples were fixed text, but they used Kaiser site labels. They were made generic.
**Cause 2:** the setup is only written from the project page's dropdown, and the change couldn't be reproduced. Most likely the dropdown, which saved on every change, was switched by accident.
**Done:** the editor is recreated per scenario, so text can't be saved onto a different scenario. A confirmation was added before changing the setup; it was later replaced, see 13.

### 12. "I loaded Test 2 but it is executing Search_Test" (`fbf3279`)
**Cause:** Search_Test was still the setup scenario, so its steps ran first.
**Done:** setup steps are folded under "Setup scenario: X · N steps · summary", and the group opens by itself if a step fails. The editor shows "Each run first runs the setup scenario X. Change".

### 13. Choosing "none" didn't clear the setup, and no OS dialogs (`38edd29`, `e4437c3`)
**Trigger:** picking "none" popped a browser dialog, and even after OK the setup stayed. Pradeep: it "should not prompt for os dialog", and "do it properly" (no curl workaround).
**Cause:** the UI sent `undefined`, which JSON drops, so the server's merge kept the old id.
**Done:** "none" is sent as `null`, and the server clears it. `confirm()` was replaced with in-page Save and Cancel and a one-line explanation. The recorder's Start-from picker is offered only before anything is recorded. The project tree refreshes after the change.

### 14. Project memory (this document)
**Ask:** consolidated context memory and episodic memory for the project. **Done:** `docs/CONTEXT.md` (standing context) and `docs/EPISODES.md` (this log), both kept in the repo.

### 15. Project-level TypeSafe key and deleting projects
**Ask:** "add a config to accept TypeSafe Key for project level and add functionality to delete project".
**Done:** a **Settings** tab on the project page.
- *TypeSafe API key:* each project can have its own key, used for every jev-img call of that project's runs and recordings. Without one, the server's `TYPESAFE_API_KEY` is used. The key is write-only. It is stored in a separate `project_secrets` table, never returned by the API (only its last 4 characters), and never logged. `PUT /api/projects/:id` now accepts only name, baseUrl, viewport and setupScenarioId.
- *Delete project:* an in-page confirmation, with no browser dialog, that removes the project's scenarios, runs, step results, logs, videos, screen library and secrets in one transaction, and closes any open recording. Images are content-addressed and may be shared, so they stay on disk.

### 16. Step library, phase 1
**Ask:** "Can we add step pattern library similar to screen library - eventually this will become skill for agent ? may be - Think like a QA Architect". A design proposal was written (Claude Doc *Step library: design proposal*), and Pradeep chose **"Build Phase 1 as proposed"**.
**Done:**
- *Library steps:* a sentence with `{values}`, kind, intent, start and end screens, tags and a body of base or other library steps. Stored per project in a new `steps` table.
- *Runs:* scenario lines that match a library step expand into its body with the values filled in, keeping the recorded element images. Run results fold them under the line, tagged "library step".
- *Safeguards:* base steps always win; unique sentences; body `{values}` must be in the sentence; scenarios must pass real values; no step can use itself; a step in use can't be deleted; renaming a step rewrites every use.
- *UI:* Step library tab and tree item, a step editor with "Used by", "Make reusable step" from selected scenario lines, suggestions while typing, and the library under Step patterns.
- *Tests:* matching, validation, expansion, renaming and cycles, plus an end-to-end run of `Order "Widget"` on the demo app.

### 17. Test results insights
**Ask:** "Create Test Results insights in the project level - Sample screen included", with a screenshot of Playwright Smart Reporter's Insights page.
**Done:** an **Insights** tab on the project page and in the tree.
- It reads each scenario's latest finished run and up to 10 earlier runs.
- Tiles: failed, pass rate, duration, scenarios, flaky and a health grade, with a result bar under them.
- Sections for izaro-eye's runs:
  - Visual changes waiting for review, grouped by jev-img's label.
  - Failure clusters.
  - Regressions, at risk, slowest, most flaky, fixed and new scenarios.
- Every item links to that run on the scenario page.
- *AI summary:* Claude writes a short summary from the computed numbers when `ANTHROPIC_API_KEY` is set on the server. TypeSafe Jev only answers visual questions, so it can't write the summary. Without a key the section says it is not configured. The live call wasn't exercised in the sandbox, which has no key.
- *Not carried over from the sample:* quality gate and quarantine, which izaro-eye doesn't have.

### 18. The AI summary is optional
**Ask:** "disable ANTHROPIC_API_KEY - It is not mandatory feature. it is optional feature".
**Done:** with no key, the Insights tab hides the AI summary section instead of showing "not configured". The server never loads the Anthropic SDK and answers 404 on the summary endpoint. `.env.example` has the key commented out, marked optional, and the README has a short "Optional: AI summary" section.


### 19. Vercel multi-service config
**Ask:** "Configure this repository to deploy on Vercel as a project with multiple services", starting from an auto-detected `vercel.json`.
**Done:**
- `vercel.json` with two services. `web` (Vite, `apps/web`) is public on `/(.*)`, and `server` (container runtime, `apps/server/Dockerfile`) is public on `/api/(.*)`. The suggested root `app` container was dropped, because it duplicated the server and web and left `web` unused behind the catch-all.
- The server image comes from the root `Dockerfile` (see *Build context* below).
- No bindings: the only caller is the browser, which uses relative `/api` URLs on the same domain, and the server never calls the web service. Vercel keeps the `/api` prefix when it forwards, which matches the server's routes, so no code change was needed.
- *Hosting:* Pradeep chose to keep both services on Vercel as a demo, accepting that data resets. Vercel containers have no persistent disk and can run several instances, so SQLite, images and videos are lost on restart, and recorder or live-run WebSockets need to reach the instance that holds the session. Deep links into the UI (`BrowserRouter`) need an SPA fallback to `index.html`, to verify on the first preview deploy.
- *Node version:* Vercel rejected `engines.node: ">=26"` (it supports up to 24.x). The root and `apps/web` now say `24.x || >=26`, so Vercel builds the UI on Node 24. `apps/server` keeps `>=26`, and its container uses `node:26`.
- *Build context:* Vercel builds a container from the folder its Dockerfile is in, so `apps/server/Dockerfile` couldn't see the root lockfile. The `server` service now uses the root `Dockerfile`, which also builds the UI. Vercel never routes UI paths to it, so that only costs a few seconds of build time.
