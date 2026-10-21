import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { InsightItem, ProjectInsights } from '@izaro/shared';
import { api } from '../api';

const ICON: Record<string, string> = { passed: '✓', failed: '✕', error: '!', review: '◐' };

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Project-level test results: each scenario's latest run, with trends from its recent runs. */
export function Insights({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectInsights>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<ProjectInsights>(`/projects/${projectId}/insights`).then(setData).catch((e) => setError(e.message));
  }, [projectId]);

  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const { counts } = data;
  const reviewSteps = data.reviews.reduce((n, g) => n + g.count, 0);
  const total = counts.passed + counts.failed + counts.review + counts.notRun;
  const bar = (
    [
      ['passed', counts.passed],
      ['review', counts.review],
      ['failed', counts.failed],
      ['notrun', counts.notRun],
    ] as const
  ).filter(([, n]) => n > 0);

  return (
    <div className="insights">
      <p className="muted small">
        Each scenario&apos;s latest run{data.asOf ? <>, the most recent from {new Date(data.asOf).toLocaleString()}</> : null}. Trends look at up to the last 10 runs.
      </p>
      <div className="tiles">
        <Tile label="Failed" value={counts.failed} tone={counts.failed ? 'bad' : undefined} sub={data.failedNew ? `${data.failedNew} new` : 'none new'} />
        <Tile label="Pass rate" value={data.passRate === undefined ? '–' : `${data.passRate}%`} sub={counts.review ? `${counts.review} waiting for review` : undefined} />
        <Tile label="Duration" value={formatDuration(data.durationMs) || '–'} sub="latest runs together" />
        <Tile label="Scenarios" value={data.scenarios} sub={[data.newScenarios && `${data.newScenarios} new`, data.neverRun && `${data.neverRun} never run`].filter(Boolean).join(' · ') || undefined} />
        <Tile label="Flaky" value={data.flaky} tone={data.flaky ? 'warn' : undefined} />
        <Tile
          label="Health"
          value={data.health?.grade ?? '–'}
          tone={data.health && 'grade-' + data.health.grade}
          sub={data.health ? `${data.health.score} · pass ${data.health.pass} · stability ${data.health.stability} · perf ${data.health.perf}` : 'no runs yet'}
        />
      </div>

      {total > 0 && (
        <>
          <div className="result-bar" role="img" aria-label={`${counts.passed} passed, ${counts.review} review, ${counts.failed} failed, ${counts.notRun} not run`}>
            {bar.map(([k, n]) => (
              <span key={k} className={`seg seg-${k}`} style={{ flexGrow: n }} />
            ))}
          </div>
          <p className="bar-legend small">
            <span className="c-passed">{counts.passed} passed</span>
            {counts.review > 0 && <span className="c-review">{counts.review} review</span>}
            <span className="c-failed">{counts.failed} failed</span>
            {counts.notRun > 0 && <span className="muted">{counts.notRun} not run</span>}
          </p>
        </>
      )}

      <div className="insight-grid">
        <AiSummary projectId={projectId} available={data.aiAvailable} hasRuns={total > counts.notRun} />
        <Section title="Visual changes to review" aside={reviewSteps ? `${reviewSteps} step${reviewSteps === 1 ? '' : 's'}` : undefined}>
          {data.reviews.length === 0 ? (
            <Empty />
          ) : (
            data.reviews.map((g) => (
              <div key={g.label} className="cluster">
                <div className="cluster-head">
                  <code>{g.label.replace(/_/g, ' ')}</code>
                  <span className="count review">{g.count}</span>
                </div>
                <Items items={g.items} />
              </div>
            ))
          )}
        </Section>
        <Section title="Failure clusters" aside={data.clusters.length ? `${data.clusters.length} cluster${data.clusters.length === 1 ? '' : 's'}` : undefined}>
          {data.clusters.length === 0 ? (
            <Empty />
          ) : (
            data.clusters.slice(0, 5).map((c) => (
              <div key={c.error} className="cluster">
                <div className="cluster-head">
                  <code title={c.error}>{c.error}</code>
                  <span className="count bad">{c.count}</span>
                </div>
                <Items items={c.items} />
              </div>
            ))
          )}
        </Section>
        <Section title="Regressions" aside="failed after passing">
          <Items items={data.regressions} />
        </Section>
        <Section title="At risk" aside="passing, failed recently">
          <Items items={data.atRisk} />
        </Section>
        <Section title="Slowest">
          <Items items={data.slowest} showTime />
        </Section>
        <Section title="Most flaky" aside="keeps switching">
          <Items items={data.mostFlaky} />
        </Section>
        <Section title="Fixed" aside="passed after failing">
          <Items items={data.fixed} />
        </Section>
        <Section title="New scenarios" aside="last 7 days">
          <Items items={data.newest} showTime empty="No new scenarios this week." />
        </Section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className={`tile-value ${tone ?? ''}`}>{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="insight">
      <header>
        <h4>{title}</h4>
        {aside && <span className="muted small">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

const Empty = ({ text = 'None in the latest runs.' }: { text?: string }) => <p className="muted small">{text}</p>;

function Items({ items, showTime, empty }: { items: InsightItem[]; showTime?: boolean; empty?: string }) {
  if (!items.length) return <Empty text={empty} />;
  return (
    <ul className="insight-items">
      {items.map((it) => (
        <li key={`${it.scenarioId}-${it.runId ?? ''}-${it.note ?? ''}`}>
          <span className={`run-icon run-${it.status ?? 'none'}`}>{(it.status && ICON[it.status]) ?? '○'}</span>
          <Link to={it.runId ? `/scenarios/${it.scenarioId}?run=${it.runId}` : `/scenarios/${it.scenarioId}`} className="insight-name">
            {it.name}
          </Link>
          {it.note && <span className="muted small insight-note">{it.note}</span>}
          {showTime && <span className="muted small mono">{formatDuration(it.durationMs)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A plain-language summary written by Claude on request, when the server has a key. */
function AiSummary({ projectId, available, hasRuns }: { projectId: string; available: boolean; hasRuns: boolean }) {
  const [summary, setSummary] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      setSummary((await api<{ summary: string }>(`/projects/${projectId}/insights/summary`, { method: 'POST' })).summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="AI summary" aside={available ? 'Claude' : undefined}>
      {!available ? (
        <p className="muted small">
          Not configured. Set <code>ANTHROPIC_API_KEY</code> in <code>apps/server/.env</code> to get a plain-language summary of these results.
        </p>
      ) : summary ? (
        <>
          <p className="ai-summary">{summary}</p>
          <button className="link small" onClick={ask} disabled={busy}>
            {busy ? 'Writing…' : 'Write again'}
          </button>
        </>
      ) : (
        <>
          <p className="muted small">Claude reads the numbers and lists on this page (no screenshots or secrets) and says what needs attention.</p>
          <button className="secondary" onClick={ask} disabled={busy || !hasRuns}>
            {busy ? 'Writing…' : 'Summarise'}
          </button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </Section>
  );
}
