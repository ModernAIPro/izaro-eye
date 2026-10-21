import type { FailureCluster, InsightItem, ProjectInsights, ReviewGroup, Run, Scenario, StepResult } from '@izaro/shared';

/** How many recent finished runs per scenario the trends look at. */
export const HISTORY = 10;
const NEW_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const done = (r: Run) => r.status !== 'queued' && r.status !== 'running';
const failed = (r: Run) => r.status === 'failed' || r.status === 'error';
/** Review means jev-img saw a change a person has to accept; for trends it counts as not failing. */
const ok = (r: Run) => r.status === 'passed' || r.status === 'review';
const duration = (r: Run) => (r.finishedAt ? Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : undefined);
/** Pass/fail changes between consecutive runs, oldest first. */
const flips = (runs: Run[]) => runs.slice(1).filter((r, i) => ok(r) !== ok(runs[i])).length;

/** Error text with the specifics (quoted labels, numbers) taken out, so the same cause groups together. */
export function errorKey(error: string): string {
  return error
    .replace(/["“”][^"“”]*["“”]/g, '"…"')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export interface InsightsInput {
  scenarios: Scenario[];
  /** Each scenario's runs, newest first. */
  runs: Map<string, Run[]>;
  /** Step results of each scenario's latest finished run. */
  results: Map<string, StepResult[]>;
  now?: number;
  aiAvailable?: boolean;
}

/**
 * Insights across a project, in the spirit of a test report: each scenario's latest finished run
 * is "this run", and its previous runs give the trends (regressions, fixes, flakiness).
 */
export function computeInsights({ scenarios, runs, results, now = Date.now(), aiAvailable = false }: InsightsInput): ProjectInsights {
  const latest = new Map<string, Run>();
  const history = new Map<string, Run[]>();
  for (const s of scenarios) {
    const finished = (runs.get(s.id) ?? []).filter(done).slice(0, HISTORY);
    history.set(s.id, finished);
    if (finished[0]) latest.set(s.id, finished[0]);
  }
  const item = (s: Scenario, run?: Run, note?: string): InsightItem => ({
    scenarioId: s.id,
    name: s.name,
    runId: run?.id,
    status: run?.status,
    durationMs: run && duration(run),
    note,
  });

  const counts = { passed: 0, failed: 0, review: 0, notRun: 0 };
  let failedNew = 0;
  let durationMs = 0;
  const regressions: InsightItem[] = [];
  const fixed: InsightItem[] = [];
  const atRisk: InsightItem[] = [];
  const flaky: { item: InsightItem; flips: number }[] = [];
  for (const s of scenarios) {
    const run = latest.get(s.id);
    if (!run) {
      counts.notRun++;
      continue;
    }
    const prev = history.get(s.id)![1];
    if (failed(run)) counts.failed++;
    else if (run.status === 'review') counts.review++;
    else counts.passed++;
    durationMs += duration(run) ?? 0;
    if (failed(run) && prev && ok(prev)) {
      failedNew++;
      regressions.push(item(s, run, 'failed after passing'));
    }
    if (ok(run) && prev && failed(prev)) fixed.push(item(s, run, 'passed after failing'));
    const oldestFirst = [...history.get(s.id)!].reverse();
    const f = flips(oldestFirst);
    // One failure and a recovery is "at risk"; flaky means it keeps switching.
    if (f >= 3) flaky.push({ item: item(s, run, `${f} flips in ${oldestFirst.length} runs`), flips: f });
    const recentFails = history.get(s.id)!.slice(1, 6).filter(failed).length;
    if (ok(run) && recentFails > 0 && !(prev && failed(prev))) atRisk.push(item(s, run, `${recentFails} of the last ${Math.min(5, history.get(s.id)!.length - 1)} runs before this failed`));
  }

  // Failure clusters and review groups come from the latest runs' step results.
  const clusters = new Map<string, FailureCluster>();
  const reviews = new Map<string, ReviewGroup>();
  for (const s of scenarios) {
    const run = latest.get(s.id);
    if (!run) continue;
    for (const r of results.get(s.id) ?? []) {
      if ((r.status === 'failed' || r.status === 'error') && !r.decision) {
        const error = r.error ?? 'Failed without an error message';
        const key = errorKey(error);
        const c = clusters.get(key) ?? { error, count: 0, items: [] };
        c.count++;
        if (!c.items.some((x) => x.scenarioId === s.id)) c.items.push(item(s, run, r.text));
        clusters.set(key, c);
      }
      if (r.status === 'review' && !r.decision) {
        const label = r.classification?.label ?? (r.found ? 'element found with low certainty' : 'needs a look');
        const g = reviews.get(label) ?? { label, count: 0, items: [] };
        g.count++;
        if (!g.items.some((x) => x.scenarioId === s.id)) g.items.push(item(s, run, r.text));
        reviews.set(label, g);
      }
    }
  }

  const ran = scenarios.length - counts.notRun;
  const passRate = ran ? Math.round((counts.passed / ran) * 100) : undefined;
  const stability = ran ? Math.round(100 - (flaky.length / ran) * 100) : 100;
  // Performance: share of scenarios whose latest run took no more than 1.5x their usual (median) time.
  const perfChecks = scenarios
    .map((s) => history.get(s.id)!.map(duration).filter((d): d is number => d !== undefined))
    .filter((ds) => ds.length > 0)
    .map((ds) => {
      const sorted = [...ds].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return ds[0] <= median * 1.5 + 1000;
    });
  const perf = perfChecks.length ? Math.round((perfChecks.filter(Boolean).length / perfChecks.length) * 100) : 100;
  // Runs waiting for review count half towards the pass score: nothing broke, but nobody has accepted the change yet.
  const pass = ran ? Math.round(((counts.passed + counts.review / 2) / ran) * 100) : 0;
  const score = Math.round(pass * 0.6 + stability * 0.25 + perf * 0.15);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

  const asOf = [...latest.values()].map((r) => r.startedAt).sort().pop();
  const recent = scenarios.filter((s) => now - Date.parse(s.createdAt) <= NEW_DAYS * DAY);
  return {
    asOf,
    scenarios: scenarios.length,
    newScenarios: recent.length,
    neverRun: counts.notRun,
    counts,
    failedNew,
    passRate,
    durationMs,
    flaky: flaky.length,
    health: ran ? { grade, score, pass, stability, perf } : undefined,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count),
    reviews: [...reviews.values()].sort((a, b) => b.count - a.count),
    slowest: scenarios
      .filter((s) => latest.has(s.id))
      .map((s) => item(s, latest.get(s.id)))
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 5),
    atRisk,
    regressions,
    fixed,
    mostFlaky: flaky.sort((a, b) => b.flips - a.flips).slice(0, 5).map((f) => f.item),
    newest: recent
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8)
      .map((s) => item(s, latest.get(s.id), latest.has(s.id) ? undefined : 'not run yet')),
    aiAvailable,
  };
}
