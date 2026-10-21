import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import type { Baseline, Run, RunMode, Step, StepResult, TestCase } from '@izaro/shared';
import { capture, launchBrowser, login, newContext, settle } from '../browser.js';
import { compareScreenshots } from '../compare/index.js';
import type { ImageClassifier } from '../compare/jev.js';
import { verdictFor } from '../compare/policy.js';
import { newId, now } from '../ids.js';
import type { Store } from '../store/db.js';
import type { ImageStore } from '../store/images.js';
import { expand } from '../template.js';
import { locate, type Located } from './locate.js';

export interface RunnerDeps {
  store: Store;
  images: ImageStore;
  classifier: ImageClassifier;
}

/** Emits `update` with the run id whenever a run or one of its step results changes. */
export const runEvents = new EventEmitter();

async function perform(page: Page, step: Step): Promise<Located | undefined> {
  switch (step.action) {
    case 'navigate':
      await page.goto(step.url!);
      return undefined;
    case 'click': {
      const l = await locate(page, step.selectors);
      await l.locator.click();
      return l;
    }
    case 'fill': {
      const l = await locate(page, step.selectors);
      await l.locator.fill(expand(step.value ?? ''));
      return l;
    }
    case 'select': {
      const l = await locate(page, step.selectors);
      await l.locator.selectOption(step.value ?? '');
      return l;
    }
    case 'check':
    case 'uncheck': {
      const l = await locate(page, step.selectors);
      await l.locator.setChecked(step.action === 'check');
      return l;
    }
    case 'press': {
      const l = await locate(page, step.selectors);
      await l.locator.press(step.value ?? 'Enter');
      return l;
    }
    case 'assert':
      return assertStep(page, step);
  }
}

async function assertStep(page: Page, step: Step): Promise<Located | undefined> {
  const a = step.assertion!;
  if (a.kind === 'url') {
    if (!new RegExp(a.pattern).test(page.url())) throw new Error(`URL ${page.url()} does not match ${a.pattern}`);
    return undefined;
  }
  const l = await locate(page, step.selectors);
  if (a.kind === 'text') {
    const text = ((await l.locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();
    const ok = a.op === 'equals' ? text === a.expected : text.includes(a.expected);
    if (!ok) throw new Error(`Expected text to ${a.op} "${a.expected}", got "${text}"`);
  } else if (a.kind === 'value') {
    const v = await l.locator.inputValue();
    if (v !== a.expected) throw new Error(`Expected value "${a.expected}", got "${v}"`);
  }
  // 'visible' is satisfied by locate(); 'visual' is judged by the comparison.
  return l;
}

function summarize(results: StepResult[]): Run['status'] {
  if (results.some((r) => r.status === 'error' || r.status === 'failed')) return 'failed';
  if (results.some((r) => r.status === 'review')) return 'review';
  return 'passed';
}

/**
 * Replays a test. In `baseline` mode the screenshots become a new baseline;
 * in `check` mode each screenshot is compared with the current baseline.
 */
export async function executeRun(deps: RunnerDeps, test: TestCase, run: Run): Promise<Run> {
  const { store, images, classifier } = deps;
  const project = store.getProject(test.projectId);
  if (!project) throw new Error(`Project ${test.projectId} not found`);
  const baselineImages = run.mode === 'check' && test.baselineId ? store.baselineImages(test.baselineId) : {};

  const update = (r: Run) => {
    store.saveRun(r);
    runEvents.emit('update', r.id);
  };
  run = { ...run, status: 'running' };
  update(run);

  const results: StepResult[] = [];
  const captured: Record<string, string> = {};
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser, project);
    const page = await context.newPage();
    await login(page, project);

    let aborted = false;
    for (const [index, step] of test.steps.entries()) {
      const result: StepResult = { id: newId('res'), runId: run.id, stepId: step.id, index, status: 'passed' };
      results.push(result);
      if (aborted) {
        result.status = 'skipped';
        store.saveResult(result);
        continue;
      }
      try {
        const located = await perform(page, step);
        if (located?.healed) result.healedSelector = located.selector;
        await settle(page);
        const png = await capture(page, step, located?.locator);
        if (png) {
          result.imageKey = await images.put(png);
          captured[step.id] = result.imageKey;
          const baseKey = baselineImages[step.id];
          if (run.mode === 'check' && baseKey) {
            result.baselineImageKey = baseKey;
            const cmp = await compareScreenshots(await images.get(baseKey), png, classifier, { stepLabel: step.label, url: page.url() });
            result.diffRatio = cmp.diffRatio;
            result.classification = cmp.classification;
            if (cmp.diffPng && cmp.classification.label !== 'identical') result.diffImageKey = await images.put(cmp.diffPng);
            result.status = verdictFor(cmp.classification);
          } else if (run.mode === 'check') {
            result.status = 'review';
            result.error = 'No baseline image for this step';
          }
        }
      } catch (e) {
        result.status = step.action === 'assert' ? 'failed' : 'error';
        result.error = (e as Error).message.split('\n')[0];
        // A failed action leaves the page in an unknown state; later steps are skipped.
        aborted = step.action !== 'assert';
        const png = await page.screenshot({ animations: 'disabled', caret: 'hide' }).catch(() => undefined);
        if (png) result.imageKey = await images.put(png);
      }
      store.saveResult(result);
      runEvents.emit('update', run.id);
    }

    run = { ...run, status: summarize(results), finishedAt: now() };
    if (run.mode === 'baseline') {
      if (run.status === 'passed') {
        const baseline: Baseline = {
          id: newId('base'),
          testId: test.id,
          version: store.nextBaselineVersion(test.id),
          runId: run.id,
          createdAt: now(),
        };
        store.saveBaseline(baseline, captured);
        store.saveTest({ ...test, baselineId: baseline.id, updatedAt: now() });
      } else {
        run.error = 'Baseline not saved because the run did not pass';
      }
    }
  } catch (e) {
    run = { ...run, status: 'error', error: (e as Error).message, finishedAt: now() };
  } finally {
    await browser.close().catch(() => {});
  }
  update(run);
  return run;
}

/** Small in-process queue. Replace with BullMQ workers to scale out. */
export class RunQueue {
  private active = 0;
  private pending: (() => Promise<void>)[] = [];

  constructor(private deps: RunnerDeps, private concurrency = 2) {}

  enqueue(test: TestCase, mode: RunMode): Run {
    if (mode === 'check' && !test.baselineId) throw new Error('Test has no baseline yet; run it in baseline mode first');
    const run: Run = { id: newId('run'), testId: test.id, mode, status: 'queued', startedAt: now() };
    this.deps.store.saveRun(run);
    this.pending.push(async () => {
      await executeRun(this.deps, test, run);
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
