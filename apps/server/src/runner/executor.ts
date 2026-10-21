import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import {
  parseStep,
  type Action,
  type FoundTarget,
  type Project,
  type Rect,
  type Run,
  type Scenario,
  type ScenarioStep,
  type StepHint,
  type LogEntry,
  type StepResult,
} from '@izaro/shared';
import { crop, launchBrowser, newContext, screenshot, settle } from '../browser.js';
import { compareScreenshots } from '../compare/index.js';
import type { Vision } from '../compare/jev.js';
import { LoggedVision } from '../compare/logged.js';
import { pixelDiff } from '../compare/pixel.js';
import { verdictFor } from '../compare/policy.js';
import { newId, now } from '../ids.js';
import type { Library } from '../library.js';
import type { Store } from '../store/db.js';
import type { ImageStore } from '../store/images.js';
import { expand } from '../template.js';

export interface ExecutorDeps {
  store: Store;
  images: ImageStore;
  vision: Vision;
  library: Library;
  /** Where run videos are kept; no video is recorded when unset. */
  videoDir?: string;
}

export const videoPath = (videoDir: string, runId: string) => path.join(videoDir, `${runId}.webm`);

/**
 * Emits `update` (runId) whenever a run or one of its step results changes,
 * `log` (runId, LogEntry) for each log line and `frame` (runId, frame) for the
 * live view.
 */
export const runEvents = new EventEmitter();

/** jev-img presence at or above this acts normally; between UNSURE and SURE acts but flags review. */
export const SURE = 0.8;
export const UNSURE = 0.5;
/** Library crop and live pixels this close count as an exact match (no jev-img call). */
const EXACT_MATCH_RATIO = 0.01;
const MAX_RUN_DEPTH = 5;

class StepFailure extends Error {
  constructor(
    message: string,
    readonly status: 'failed' | 'error' = 'error',
  ) {
    super(message);
  }
}

interface Outcome {
  status: StepResult['status'];
  patch?: Partial<StepResult>;
}

/** Runs scenario steps on a page, finding every target from screenshots. */
export class Executor {
  constructor(
    private deps: ExecutorDeps,
    private project: Project,
    private page: Page,
  ) {}

  private viewport() {
    return this.page.viewportSize() ?? this.project.viewport;
  }

  /** Locates a control by label: exact library image match first, then jev-img. */
  async find(label: string, hint?: StepHint): Promise<{ found: FoundTarget; elementId?: string; review: boolean }> {
    const { library, images, vision } = this.deps;
    const known = hint?.elementId
      ? (() => {
          const screen = this.deps.store.getScreen(hint.screenId);
          const element = screen?.elements.find((e) => e.id === hint.elementId);
          return screen && element ? { screen, element } : undefined;
        })()
      : library.findByLabel(this.project.id, label, hint?.screenId);
    const knownCrop = known ? await images.get(known.element.cropKey) : undefined;

    let shot = await settle(this.page);
    if (known && knownCrop) {
      const live = await crop(shot, known.element.rect);
      const d = pixelDiff(knownCrop, live);
      if (!d.sizeMismatch && d.ratio <= EXACT_MATCH_RATIO) {
        return { found: { label, rect: known.element.rect, confidence: 1, method: 'exact-match' }, elementId: known.element.id, review: false };
      }
    }

    const vp = this.viewport();
    // As-is, then once more after a pause (still loading), then scrolling down.
    const retries: (() => Promise<void>)[] = [
      async () => this.page.waitForTimeout(1_000),
      ...Array.from({ length: 3 }, () => async () => {
        await this.page.mouse.wheel(0, Math.round(vp.height * 0.75));
      }),
    ];
    let best = 0;
    for (let attempt = 0; ; attempt++) {
      const ans = await vision.findElement(shot, { label, crop: knownCrop });
      best = Math.max(best, ans.present);
      if (ans.present >= UNSURE && ans.box) {
        const rect: Rect = {
          x: ans.box.left * vp.width,
          y: ans.box.top * vp.height,
          width: (ans.box.right - ans.box.left) * vp.width,
          height: (ans.box.bottom - ans.box.top) * vp.height,
        };
        const area = rect.width * rect.height;
        const knownArea = known ? known.element.rect.width * known.element.rect.height : area;
        const oddSize = area <= 0 || area / knownArea < 0.25 || area / knownArea > 4;
        return {
          found: { label, rect, confidence: ans.present, method: 'jev-img' },
          elementId: known?.element.id,
          review: ans.present < SURE || oddSize,
        };
      }
      if (attempt >= retries.length) break;
      await retries[attempt]();
      shot = await settle(this.page);
    }
    throw new StepFailure(`Could not find "${label}" on screen (jev-img was at most ${(best * 100).toFixed(0)}% sure it is there)`);
  }

  private async clickRect(r: Rect) {
    await this.page.mouse.click(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  }

  /** Performs one action. Returns the outcome, or throws StepFailure. */
  async perform(action: Action, hint?: StepHint): Promise<Outcome> {
    const { vision, images, library } = this.deps;
    switch (action.kind) {
      case 'goto':
        await this.page.goto(new URL(action.url, this.project.baseUrl).toString());
        return { status: 'passed' };
      case 'wait':
        await this.page.waitForTimeout(action.seconds * 1000);
        return { status: 'passed' };
      case 'press':
        await this.page.keyboard.press(action.key);
        return { status: 'passed' };
      case 'scroll':
        await this.page.mouse.wheel(0, (action.direction === 'down' ? 1 : -1) * Math.round(this.viewport().height * 0.75));
        return { status: 'passed' };
      case 'click':
      case 'enter':
      case 'choose': {
        const t = await this.find(action.target, hint);
        await this.clickRect(t.found.rect);
        if (action.kind === 'enter') {
          await this.page.keyboard.press('ControlOrMeta+A');
          await this.page.keyboard.insertText(expand(action.value));
        } else if (action.kind === 'choose') {
          await this.chooseOption(action.option);
        }
        return { status: t.review ? 'review' : 'passed', patch: { found: t.found, elementId: t.elementId } };
      }
      case 'expectScreen': {
        const screen = library.findScreenByName(this.project.id, action.screen);
        if (!screen) throw new StepFailure(`There is no "${action.screen}" screen in the library`, 'failed');
        const shot = await settle(this.page);
        const cmp = await compareScreenshots(await images.get(screen.imageKey), shot, vision, { stepLabel: `Expect the "${screen.name}" screen`, url: this.page.url() });
        const patch: Partial<StepResult> = {
          screenId: screen.id,
          expectedImageKey: screen.imageKey,
          diffRatio: cmp.diffRatio,
          classification: cmp.classification,
        };
        if (cmp.diffPng && cmp.classification.label !== 'identical') patch.diffImageKey = await images.put(cmp.diffPng);
        return { status: verdictFor(cmp.classification), patch };
      }
      case 'expectText': {
        const p = await vision.seesText(await settle(this.page), action.text);
        return { status: p >= SURE ? 'passed' : p >= UNSURE ? 'review' : 'failed', patch: { textConfidence: p } };
      }
      case 'run':
        throw new Error('Run steps are expanded before execution');
    }
  }

  /** Picks an option after opening a dropdown: visually if the list is drawn, otherwise by typing it. */
  private async chooseOption(option: string) {
    const shot = await settle(this.page, 2_000);
    const ans = await this.deps.vision.findElement(shot, { label: option }).catch(() => undefined);
    if (ans && ans.present >= SURE && ans.box) {
      const vp = this.viewport();
      await this.page.mouse.click(((ans.box.left + ans.box.right) / 2) * vp.width, ((ans.box.top + ans.box.bottom) / 2) * vp.height);
    } else {
      // Native <select> lists are drawn by the browser, outside the screenshot.
      await this.page.keyboard.type(option);
      await this.page.keyboard.press('Enter');
    }
  }
}

interface FlatStep {
  step: ScenarioStep;
  from?: string;
  error?: string;
}

/** Expands `Run "..."` steps (and the project's setup scenario) into one flat list. */
export function flatten(store: Store, project: Project, scenario: Scenario): FlatStep[] {
  const byName = new Map(store.listScenarios(project.id).map((s) => [s.name.trim().toLowerCase(), s]));
  const out: FlatStep[] = [];
  const walk = (s: Scenario, from: string | undefined, depth: number, stack: string[]) => {
    for (const step of s.steps) {
      const parsed = parseStep(step.text);
      if (parsed.ok && parsed.action.kind === 'run') {
        const target = byName.get(parsed.action.scenario.trim().toLowerCase());
        if (!target) out.push({ step, from, error: `No scenario named "${parsed.action.scenario}"` });
        else if (depth >= MAX_RUN_DEPTH || stack.includes(target.id)) out.push({ step, from, error: `"${target.name}" runs itself` });
        else walk(target, from ? `${from} › ${target.name}` : target.name, depth + 1, [...stack, target.id]);
      } else {
        out.push({ step, from });
      }
    }
  };
  const setup = project.setupScenarioId ? store.getScenario(project.setupScenarioId) : undefined;
  const callsSetup = setup && scenario.steps.some((st) => {
    const p = parseStep(st.text);
    return p.ok && p.action.kind === 'run' && p.action.scenario.trim().toLowerCase() === setup.name.trim().toLowerCase();
  });
  if (setup && setup.id !== scenario.id && !callsSetup) walk(setup, setup.name, 1, [setup.id]);
  walk(scenario, undefined, 0, [scenario.id]);
  return out;
}

function summarize(results: StepResult[]): Run['status'] {
  if (results.some((r) => r.status === 'error' || r.status === 'failed')) return 'failed';
  if (results.some((r) => r.status === 'review')) return 'review';
  return 'passed';
}

export async function executeRun(deps: ExecutorDeps, scenario: Scenario, run: Run): Promise<Run> {
  const { store, images } = deps;
  const project = store.getProject(scenario.projectId);
  if (!project) throw new Error(`Project ${scenario.projectId} not found`);
  const update = (r: Run) => {
    store.saveRun(r);
    runEvents.emit('update', r.id);
  };
  let currentStep: number | undefined;
  const log = (e: Omit<LogEntry, 'at' | 'source'> & { source?: LogEntry['source'] }) => {
    const entry: LogEntry = { at: now(), source: e.source ?? 'runner', level: e.level, message: e.message, data: e.data, step: e.step ?? currentStep };
    store.appendLog(run.id, entry);
    runEvents.emit('log', run.id, entry);
  };
  const runDeps: ExecutorDeps = { ...deps, vision: new LoggedVision(deps.vision, log) };
  run = { ...run, status: 'running' };
  update(run);
  log({ level: 'info', message: `Running "${scenario.name}" on ${project.baseUrl} with ${deps.vision.name}` });

  const results: StepResult[] = [];
  const browser = await launchBrowser();
  const videoTmp = deps.videoDir ? path.join(deps.videoDir, 'tmp', run.id) : undefined;
  let page: Page | undefined;
  try {
    page = await newContext(browser, project, { videoDir: videoTmp })
      .then((c) => c.newPage())
      .catch(async (e) => {
        // Video needs Playwright's ffmpeg (installed with `playwright install chromium`); run without it if missing.
        log({ level: 'warn', message: `Video recording is not available: ${(e as Error).message.split('\n')[0]}` });
        return (await newContext(browser, project)).newPage();
      });
    watchBrowser(page, log);
    await streamFrames(page, run.id);
    await page.goto(project.baseUrl);
    const exec = new Executor(runDeps, project, page);
    let aborted = false;
    for (const [index, { step, from, error }] of flatten(store, project, scenario).entries()) {
      currentStep = index;
      const result: StepResult = { id: newId('res'), runId: run.id, index, text: step.text, from, status: 'passed' };
      results.push(result);
      if (aborted) {
        result.status = 'skipped';
      } else {
        const started = Date.now();
        log({ level: 'info', message: `Step ${index + 1}: ${step.text}${from ? ` (from ${from})` : ''}` });
        try {
          if (error) throw new StepFailure(error);
          const parsed = parseStep(step.text);
          if (!parsed.ok) throw new StepFailure(parsed.error);
          const outcome = await exec.perform(parsed.action, step.hint);
          Object.assign(result, outcome.patch, { status: outcome.status });
          result.imageKey = await images.put(await settle(page));
        } catch (e) {
          const failure = e instanceof StepFailure ? e : undefined;
          result.status = failure?.status ?? 'error';
          result.error = (e as Error).message.split('\n')[0];
          // A failed action leaves the app in an unknown state; a failed check does not.
          aborted = result.status === 'error';
          const png = await screenshot(page).catch(() => undefined);
          if (png) result.imageKey = await images.put(png);
        }
        const level = result.status === 'passed' ? 'info' : result.status === 'review' ? 'warn' : 'error';
        log({ level, message: `Step ${index + 1} ${result.status} in ${Date.now() - started} ms${result.error ? `: ${result.error}` : ''}` });
      }
      store.saveResult(result);
      runEvents.emit('update', run.id);
    }
    currentStep = undefined;
    run = { ...run, status: summarize(results), finishedAt: now() };
  } catch (e) {
    run = { ...run, status: 'error', error: (e as Error).message, finishedAt: now() };
  } finally {
    const video = page?.video();
    await page?.context().close().catch(() => {});
    if (video && deps.videoDir) {
      try {
        await video.saveAs(videoPath(deps.videoDir, run.id));
        run = { ...run, hasVideo: true };
      } catch (e) {
        log({ level: 'warn', message: `Video not saved: ${(e as Error).message}` });
      }
      if (videoTmp) await fs.rm(videoTmp, { recursive: true, force: true }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  log({ level: run.status === 'passed' ? 'info' : 'warn', message: `Run ${run.status}` });
  update(run);
  return run;
}

/** Forwards the page's console, uncaught errors and failed requests to the run log. */
function watchBrowser(page: Page, log: (e: Omit<LogEntry, 'at' | 'source'> & { source?: LogEntry['source'] }) => void) {
  page.on('console', (m) => {
    const t = m.type();
    log({ source: 'browser', level: t === 'error' ? 'error' : t === 'warning' ? 'warn' : 'info', message: `console.${t}: ${m.text()}` });
  });
  page.on('pageerror', (e) => log({ source: 'browser', level: 'error', message: `Uncaught: ${e.message}` }));
  page.on('requestfailed', (r) => log({ source: 'browser', level: 'warn', message: `${r.method()} ${r.url()} failed: ${r.failure()?.errorText ?? ''}` }));
  page.on('response', (r) => {
    if (r.status() >= 400) log({ source: 'browser', level: r.status() >= 500 ? 'error' : 'warn', message: `${r.status()} ${r.request().method()} ${r.url()}` });
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) log({ source: 'browser', level: 'info', message: `Navigated to ${f.url()}` });
  });
}

/** Live view: JPEG frames of the run's browser, only while someone is watching. */
async function streamFrames(page: Page, runId: string) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    runEvents.emit('frame', runId, { data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = page.viewportSize();
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp?.width, maxHeight: vp?.height }).catch(() => {});
}

/** Small in-process queue. Replace with BullMQ workers to scale out. */
export class RunQueue {
  private active = 0;
  private pending: (() => Promise<void>)[] = [];

  constructor(
    private deps: ExecutorDeps,
    private concurrency = 2,
  ) {}

  enqueue(scenario: Scenario): Run {
    const run: Run = { id: newId('run'), scenarioId: scenario.id, status: 'queued', startedAt: now() };
    this.deps.store.saveRun(run);
    this.pending.push(async () => {
      await executeRun(this.deps, scenario, run);
    });
    this.pump();
    return run;
  }

  private pump() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.active++;
      job().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}
