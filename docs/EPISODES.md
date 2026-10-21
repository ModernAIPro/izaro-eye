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
