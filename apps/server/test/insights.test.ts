import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { LocalVision } from '../src/compare/jev.js';
import type { Run, RunStatus, Scenario, StepResult } from '@izaro/shared';
import { computeInsights, errorKey } from '../src/insights.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const scenario = (id: string, daysOld = 30): Scenario => ({
  id,
  projectId: 'p',
  name: id,
  steps: [],
  createdAt: new Date(NOW - daysOld * 864e5).toISOString(),
  updatedAt: '',
});
/** Runs newest first; each takes `secs` seconds. */
const runs = (id: string, statuses: RunStatus[], secs = 10): Run[] =>
  statuses.map((status, i) => {
    const start = NOW - (i + 1) * 36e5;
    return { id: `${id}-${i}`, scenarioId: id, status, startedAt: new Date(start).toISOString(), finishedAt: new Date(start + secs * 1000).toISOString() };
  });
const result = (runId: string, status: StepResult['status'], extra: Partial<StepResult> = {}): StepResult => ({ id: `${runId}-r`, runId, index: 0, text: 'Click "Pay"', status, ...extra });

describe('project insights', () => {
  it('reads regressions, fixes, flakiness, risk, clusters and reviews from run history', () => {
    const scenarios = [scenario('stable'), scenario('broke'), scenario('fixed'), scenario('flaky'), scenario('risky'), scenario('changed'), scenario('new', 1)];
    const history = new Map<string, Run[]>([
      ['stable', runs('stable', ['passed', 'passed', 'passed'], 5)],
      ['broke', runs('broke', ['failed', 'passed', 'passed'], 40)],
      ['fixed', runs('fixed', ['passed', 'failed'])],
      ['flaky', runs('flaky', ['failed', 'passed', 'failed', 'passed'])],
      ['risky', runs('risky', ['passed', 'passed', 'error', 'passed'])],
      ['changed', runs('changed', ['review', 'passed'])],
      ['new', [{ id: 'q', scenarioId: 'new', status: 'queued', startedAt: new Date(NOW).toISOString() }]],
    ]);
    const results = new Map<string, StepResult[]>([
      ['broke', [result('broke-0', 'failed', { error: 'Could not find "Pay" on screen (confidence 0.31)' })]],
      ['flaky', [result('flaky-0', 'failed', { error: 'Could not find "Next" on screen (confidence 0.12)' })]],
      ['changed', [result('changed-0', 'review', { classification: { label: 'layout_regression', confidence: 0.9, source: 'jev-img' } })]],
    ]);
    const i = computeInsights({ scenarios, runs: history, results, now: NOW, aiAvailable: false });

    expect(i.counts).toEqual({ passed: 3, failed: 2, review: 1, notRun: 1 });
    expect(i.passRate).toBe(50);
    expect(i.scenarios).toBe(7);
    expect(i.newScenarios).toBe(1);
    expect(i.newest[0]).toMatchObject({ name: 'new', note: 'not run yet' });
    expect(i.regressions.map((x) => x.name)).toEqual(['broke', 'flaky']);
    expect(i.failedNew).toBe(2);
    expect(i.fixed.map((x) => x.name)).toEqual(['fixed']);
    expect(i.mostFlaky.map((x) => x.name)).toEqual(['flaky']);
    expect(i.atRisk.map((x) => x.name)).toEqual(['risky']);
    expect(i.slowest[0]).toMatchObject({ name: 'broke', durationMs: 40000, runId: 'broke-0' });
    // The two "could not find" failures share a cause even though the labels and numbers differ.
    expect(i.clusters).toHaveLength(1);
    expect(i.clusters[0]).toMatchObject({ count: 2 });
    expect(i.reviews).toEqual([expect.objectContaining({ label: 'layout_regression', count: 1 })]);
    expect(i.health?.grade).toMatch(/^[A-F]$/);
    expect(i.durationMs).toBe(5000 + 40000 + 10000 * 4);
  });

  it('handles a project with no runs', () => {
    const i = computeInsights({ scenarios: [scenario('a')], runs: new Map(), results: new Map(), now: NOW });
    expect(i.passRate).toBeUndefined();
    expect(i.health).toBeUndefined();
    expect(i.counts.notRun).toBe(1);
  });

  it('groups errors by their shape', () => {
    expect(errorKey('No scenario named "A"')).toBe(errorKey('No scenario named "B"'));
    expect(errorKey('Timed out after 30 s')).not.toBe(errorKey('No scenario named "B"'));
  });
});

describe('insights API', () => {
  it('serves insights, and says the AI summary needs a Claude key when none is set', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'izaro-insights-'));
    const key = process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ dataDir, vision: new LocalVision() });
    try {
      const p = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', baseUrl: 'http://localhost:1' } })).json();
      await app.inject({ method: 'POST', url: `/api/projects/${p.id}/scenarios`, payload: { name: 'S', steps: [{ text: 'Scroll down' }] } });
      const res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/insights` });
      expect(res.json()).toMatchObject({ scenarios: 1, counts: { notRun: 1 }, aiAvailable: !!key });
      if (!key) expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/insights/summary` })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/projects/nope/insights' })).statusCode).toBe(404);
    } finally {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
