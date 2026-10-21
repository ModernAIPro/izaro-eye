import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Rect, Run, Scenario, StepResult } from '@izaro/shared';
import { api, imageUrl, wsUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';

type View = 'side' | 'overlay' | 'diff';

export function RunDetail() {
  const { id } = useParams();
  const [run, setRun] = useState<Run>();
  const [results, setResults] = useState<StepResult[]>([]);
  const [scenario, setScenario] = useState<Scenario>();

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
    if (run && !scenario) api<Scenario>(`/scenarios/${run.scenarioId}`).then(setScenario);
  }, [run, scenario]);

  const review = async (r: StepResult, decision: 'accepted' | 'bug') => {
    const updated = await api<StepResult>(`/results/${r.id}/review`, { method: 'POST', json: { decision } });
    setResults((rs) => rs.map((x) => (x.id === updated.id ? updated : x)));
  };

  if (!run) return <p>Loading…</p>;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {scenario?.name ?? 'Run'} <StatusBadge status={run.status} />
        </h2>
        {scenario && <Link to={`/scenarios/${scenario.id}`}>← scenario</Link>}
      </div>
      {run.error && <p className="error">{run.error}</p>}
      <div className="results">
        {results.map((r) => (
          <ResultCard key={r.id} result={r} onReview={review} />
        ))}
      </div>
    </section>
  );
}

function Box({ rect, width, height }: { rect: Rect; width: number; height: number }) {
  return (
    <div
      className="region found"
      style={{ left: `${(rect.x / width) * 100}%`, top: `${(rect.y / height) * 100}%`, width: `${(rect.width / width) * 100}%`, height: `${(rect.height / height) * 100}%` }}
    />
  );
}

function ResultCard({ result: r, onReview }: { result: StepResult; onReview: (r: StepResult, d: 'accepted' | 'bug') => void }) {
  const [view, setView] = useState<View>('side');
  const [opacity, setOpacity] = useState(50);
  const [size, setSize] = useState<{ w: number; h: number }>();
  const c = r.classification;
  const screenChanged = r.expectedImageKey && c && c.label !== 'identical';
  const reviewable = r.status === 'review' || (r.status === 'failed' && (screenChanged || r.textConfidence !== undefined));
  return (
    <div className={`result result-${r.status}`}>
      <div className="result-head">
        <span>
          {r.index + 1}. {r.text}
          {r.from && <span className="muted"> · from {r.from}</span>}
        </span>
        <StatusBadge status={r.status} />
      </div>
      {r.error && <p className="error">{r.error}</p>}
      {r.found && (
        <p className="hint">
          Found "{r.found.label}" {r.found.method === 'exact-match' ? 'by exact image match' : `with jev-img, ${(r.found.confidence * 100).toFixed(0)}% sure`}
        </p>
      )}
      {r.textConfidence !== undefined && <p className="hint">jev-img: {(r.textConfidence * 100).toFixed(0)}% sure the text is on screen</p>}
      {c && (
        <p className="classification">
          <strong>{c.label.replace(/_/g, ' ')}</strong> · {(c.confidence * 100).toFixed(0)}% · via {c.source}
          {r.diffRatio !== undefined && <> · {(r.diffRatio * 100).toFixed(2)}% pixels changed</>}
        </p>
      )}
      {screenChanged && r.imageKey && (
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
                <img src={imageUrl(r.expectedImageKey!)} alt="library screen" />
                <figcaption>screen library</figcaption>
              </figure>
              <figure className="region-wrap">
                <img src={imageUrl(r.imageKey)} alt="this run" />
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
                <figcaption>this run</figcaption>
              </figure>
            </div>
          )}
          {view === 'overlay' && (
            <div>
              <div className="overlay">
                <img src={imageUrl(r.expectedImageKey!)} alt="library screen" />
                <img src={imageUrl(r.imageKey)} alt="this run" style={{ opacity: opacity / 100 }} />
              </div>
              <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
            </div>
          )}
          {view === 'diff' && r.diffImageKey && <img className="full" src={imageUrl(r.diffImageKey)} alt="diff" />}
        </>
      )}
      {!screenChanged && r.imageKey && (
        <figure className="region-wrap thumb-wrap">
          <img className="thumb" src={imageUrl(r.imageKey)} alt="screenshot" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {r.found && r.found.method === 'jev-img' && size && <Box rect={r.found.rect} width={size.w} height={size.h} />}
        </figure>
      )}
      {reviewable && !r.decision && (
        <div className="row">
          <button onClick={() => onReview(r, 'accepted')}>{screenChanged ? 'Accept as new library screen' : 'Accept'}</button>
          <button className="danger" onClick={() => onReview(r, 'bug')}>
            Mark as bug
          </button>
        </div>
      )}
      {r.decision && <p className="muted">Reviewed: {r.decision}</p>}
    </div>
  );
}
