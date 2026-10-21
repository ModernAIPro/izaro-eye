import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { Rect, Scenario, StepResult } from '@izaro/shared';
import { api, imageUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { useRunStream } from '../workspace/RunStream';
import { Splitter, usePaneSize } from '../workspace/Splitter';

type Media = 'live' | 'video' | 'screenshot';
type View = 'side' | 'overlay' | 'diff';

/** Centre pane for a run: the browser live (or its video afterwards) above the steps, split by a drag handle. */
export function RunDetail() {
  const { run, results } = useRunStream();
  const [scenario, setScenario] = useState<Scenario>();
  const [selected, setSelected] = useState<string>();
  const [media, setMedia] = useState<Media>('live');
  const stageSize = usePaneSize('stage', 60, 15, 85);
  const split = useRef<HTMLDivElement>(null);
  const active = run && (run.status === 'running' || run.status === 'queued');

  useEffect(() => {
    if (run && scenario?.id !== run.scenarioId) api<Scenario>(`/scenarios/${run.scenarioId}`).then(setScenario);
  }, [run, scenario]);
  useEffect(() => {
    if (run && !active) setMedia(run.hasVideo ? 'video' : 'screenshot');
    if (active) setMedia('live');
  }, [run?.id, active, run?.hasVideo]);

  const review = async (r: StepResult, decision: 'accepted' | 'bug') => {
    await api<StepResult>(`/results/${r.id}/review`, { method: 'POST', json: { decision } });
  };

  if (!run) return <p className="muted">Loading…</p>;
  const current = results.find((r) => r.id === selected);
  const last = [...results].reverse().find((r) => r.imageKey);
  const counts = results.reduce<Record<string, number>>((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});

  return (
    <div className="run-view">
      <div className="panel-head">
        <h2>
          {scenario?.name ?? 'Run'} <StatusBadge status={run.status} />
        </h2>
        <div className="row small muted">
          {Object.entries(counts).map(([k, v]) => (
            <span key={k}>
              {v} {k}
            </span>
          ))}
          {scenario && <Link to={`/scenarios/${scenario.id}`}>Edit scenario</Link>}
        </div>
      </div>
      {run.error && <p className="error">{run.error}</p>}

      <div className="segmented small">
        <button className={media === 'live' ? 'active' : ''} onClick={() => setMedia('live')} disabled={!active}>
          Live
        </button>
        <button className={media === 'video' ? 'active' : ''} onClick={() => setMedia('video')} disabled={!run.hasVideo}>
          Video
        </button>
        <button className={media === 'screenshot' ? 'active' : ''} onClick={() => setMedia('screenshot')} disabled={!last}>
          Last screenshot
        </button>
      </div>
      <div className="run-split" ref={split} style={{ '--stage': `${stageSize.size}%` } as CSSProperties}>
        <div className="stage">
          {media === 'live' && <LiveView />}
          {media === 'video' && run.hasVideo && <video key={run.id} src={`/api/runs/${run.id}/video`} controls autoPlay muted />}
          {media === 'screenshot' && last?.imageKey && <img src={imageUrl(last.imageKey)} alt="last screenshot" />}
          {media === 'live' && !active && <p className="muted stage-note">The run has finished. {run.hasVideo ? 'Watch the video.' : ''}</p>}
        </div>
        <Splitter
          axis="y"
          size={stageSize.size}
          onSize={stageSize.set}
          onReset={stageSize.reset}
          unitsPerPixel={() => 100 / (split.current?.clientHeight || 1)}
          label="Resize video and steps"
        />
        <div className="steps-pane">
          <h3>Steps</h3>
          <ol className="step-list">
            {results.map((r) => (
              <li key={r.id} className={`step-row status-${r.status} ${r.id === selected ? 'selected' : ''}`} onClick={() => setSelected(r.id === selected ? undefined : r.id)}>
                <StatusBadge status={r.status} />
                <span className="step-text">{r.text}</span>
                {r.from && <span className="muted small">from {r.from}</span>}
              </li>
            ))}
            {results.length === 0 && <li className="muted">Starting…</li>}
          </ol>
          {current && <ResultCard result={current} onReview={review} />}
        </div>
      </div>
    </div>
  );
}

function LiveView() {
  const { onFrame } = useRunStream();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [has, setHas] = useState(false);
  useEffect(
    () =>
      onFrame((f) => {
        const c = canvas.current;
        if (!c) return;
        if (c.width !== f.width) c.width = f.width;
        if (c.height !== f.height) c.height = f.height;
        const img = new Image();
        img.onload = () => c.getContext('2d')?.drawImage(img, 0, 0);
        img.src = `data:image/jpeg;base64,${f.data}`;
        setHas(true);
      }),
    [onFrame],
  );
  return (
    <>
      <canvas ref={canvas} className={has ? '' : 'hidden'} />
      {!has && <p className="muted stage-note">Waiting for the browser…</p>}
    </>
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
