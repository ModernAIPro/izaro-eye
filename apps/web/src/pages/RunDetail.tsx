import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Run, StepResult, TestCase } from '@izaro/shared';
import { api, imageUrl, wsUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';

type View = 'side' | 'overlay' | 'diff';

export function RunDetail() {
  const { id } = useParams();
  const [run, setRun] = useState<Run>();
  const [results, setResults] = useState<StepResult[]>([]);
  const [test, setTest] = useState<TestCase>();

  useEffect(() => {
    const sock = new WebSocket(wsUrl(`/runs/${id}/events`));
    sock.onmessage = (e) => {
      const data = JSON.parse(e.data) as { run: Run; results: StepResult[] };
      setRun(data.run);
      setResults(data.results);
    };
    return () => sock.close();
  }, [id]);

  useEffect(() => {
    if (run && !test) api<TestCase>(`/tests/${run.testId}`).then(setTest);
  }, [run, test]);

  const review = async (r: StepResult, decision: 'accepted' | 'bug') => {
    const updated = await api<StepResult>(`/results/${r.id}/review`, { method: 'POST', json: { decision } });
    setResults((rs) => rs.map((x) => (x.id === updated.id ? updated : x)));
  };

  if (!run) return <p>Loading…</p>;
  const stepLabel = (stepId: string) => test?.steps.find((s) => s.id === stepId)?.label ?? stepId;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {run.mode === 'baseline' ? 'Baseline run' : 'Regression run'} <StatusBadge status={run.status} />
        </h2>
        {test && <Link to={`/tests/${test.id}`}>← {test.name}</Link>}
      </div>
      {run.error && <p className="error">{run.error}</p>}
      <div className="results">
        {results.map((r) => (
          <ResultCard key={r.id} result={r} label={stepLabel(r.stepId)} onReview={review} />
        ))}
      </div>
    </section>
  );
}

function ResultCard({ result: r, label, onReview }: { result: StepResult; label: string; onReview: (r: StepResult, d: 'accepted' | 'bug') => void }) {
  const [view, setView] = useState<View>('side');
  const [opacity, setOpacity] = useState(50);
  const c = r.classification;
  const changed = c && c.label !== 'identical';
  return (
    <div className={`result result-${r.status}`}>
      <div className="result-head">
        <span>
          {r.index + 1}. {label}
        </span>
        <StatusBadge status={r.status} />
      </div>
      {r.error && <p className="error">{r.error}</p>}
      {r.healedSelector && <p className="hint">Primary selector failed; healed with <code>{r.healedSelector}</code></p>}
      {c && (
        <p className="classification">
          <strong>{c.label.replace(/_/g, ' ')}</strong> · {(c.confidence * 100).toFixed(0)}% · via {c.source}
          {r.diffRatio !== undefined && <> · {(r.diffRatio * 100).toFixed(2)}% pixels changed</>}
          {c.notes && <span className="muted"> · {c.notes}</span>}
        </p>
      )}
      {changed && r.baselineImageKey && r.imageKey && (
        <>
          <div className="segmented small">
            {(['side', 'overlay', 'diff'] as View[]).map((v) => (
              <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                {v}
              </button>
            ))}
          </div>
          {view === 'side' && (
            <div className="side-by-side">
              <figure>
                <img src={imageUrl(r.baselineImageKey)} alt="baseline" />
                <figcaption>baseline</figcaption>
              </figure>
              <figure className="region-wrap">
                <img src={imageUrl(r.imageKey)} alt="rerun" />
                {c?.region && (
                  <div
                    className="region"
                    style={{
                      top: `${c.region.top * 100}%`,
                      left: `${c.region.left * 100}%`,
                      width: `${(c.region.right - c.region.left) * 100}%`,
                      height: `${(c.region.bottom - c.region.top) * 100}%`,
                    }}
                  />
                )}
                <figcaption>rerun</figcaption>
              </figure>
            </div>
          )}
          {view === 'overlay' && (
            <div>
              <div className="overlay">
                <img src={imageUrl(r.baselineImageKey)} alt="baseline" />
                <img src={imageUrl(r.imageKey)} alt="rerun" style={{ opacity: opacity / 100 }} />
              </div>
              <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
            </div>
          )}
          {view === 'diff' && r.diffImageKey && <img className="full" src={imageUrl(r.diffImageKey)} alt="diff" />}
          {!r.decision && (
            <div className="row">
              <button onClick={() => onReview(r, 'accepted')}>Accept as new baseline</button>
              <button className="danger" onClick={() => onReview(r, 'bug')}>
                Mark as bug
              </button>
            </div>
          )}
          {r.decision && <p className="muted">Reviewed: {r.decision}</p>}
        </>
      )}
      {!changed && r.imageKey && <img className="thumb" src={imageUrl(r.imageKey)} alt="screenshot" />}
    </div>
  );
}
