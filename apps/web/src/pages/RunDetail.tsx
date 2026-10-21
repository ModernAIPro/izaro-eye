import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import type { Project, Rect, Scenario, StepResult } from '@izaro/shared';
import { api, imageUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { useRunStream } from '../workspace/RunStream';
import { Splitter, usePaneSize } from '../workspace/Splitter';

type Media = 'live' | 'video' | 'screenshot';
type View = 'side' | 'overlay' | 'diff';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Centre pane for a run: the browser live (or its video afterwards) and the steps, split by a drag handle.
 * The video panel takes the recording's shape: steps sit beside it when the pane is wide, below it otherwise.
 */
export function RunDetail({ embedded = false, picker }: { embedded?: boolean; picker?: ReactNode }) {
  const { run, results } = useRunStream();
  const [scenario, setScenario] = useState<Scenario>();
  const setupName = useSetupName(scenario);
  const [scenarioNames, setScenarioNames] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [media, setMedia] = useState<Media>('live');
  const split = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(1280 / 800);
  const [area, setArea] = useState({ w: 0, h: 0 });
  // 0 means "fit the recording"; dragging stores a percentage, double-click goes back to fitting.
  const sideSize = usePaneSize('stage-side', 0, 0, 85);
  const stackSize = usePaneSize('stage-stack', 0, 0, 85);
  const active = run && (run.status === 'running' || run.status === 'queued');

  useEffect(() => {
    if (run && scenario?.id !== run.scenarioId) api<Scenario>(`/scenarios/${run.scenarioId}`).then(setScenario);
  }, [run, scenario]);
  useEffect(() => {
    if (scenario) api<Scenario[]>(`/projects/${scenario.projectId}/scenarios`).then((ss) => setScenarioNames(new Set(ss.map((x) => x.name.trim().toLowerCase()))));
  }, [scenario?.projectId]);
  useEffect(() => {
    if (run && !active) setMedia(run.hasVideo ? 'video' : 'screenshot');
    if (active) setMedia('live');
  }, [run?.id, active, run?.hasVideo]);

  useEffect(() => {
    const el = split.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!run]);

  const review = async (r: StepResult, decision: 'accepted' | 'bug') => {
    await api<StepResult>(`/results/${r.id}/review`, { method: 'POST', json: { decision } });
  };

  if (!run) return <p className="muted">Loading…</p>;
  const current = results.find((r) => r.id === selected);
  const last = [...results].reverse().find((r) => r.imageKey);
  const side = area.h > 0 && area.w / area.h > aspect * 1.3;
  const pane = side ? sideSize : stackSize;
  const fit = area.h > 0 ? (side ? (area.h * aspect) / area.w : area.w / aspect / area.h) * 100 : 60;
  const stage = clamp(pane.size || fit, 15, 85);
  const fromMedia = (w: number, h: number) => w > 0 && h > 0 && setAspect(w / h);
  const counts = results.reduce<Record<string, number>>((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});

  return (
    <div className="run-view">
      <div className="panel-head run-head">
        {embedded ? (
          <div className="row">
            <StatusBadge status={run.status} />
            {picker}
          </div>
        ) : (
          <h2>
            {scenario?.name ?? 'Run'} <StatusBadge status={run.status} />
          </h2>
        )}
        <div className="row small muted">
          {Object.entries(counts).map(([k, v]) => (
            <span key={k}>
              {v} {k}
            </span>
          ))}
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
      <div className={`run-split ${side ? 'side' : 'stack'}`} ref={split} style={{ '--stage': `${stage}%` } as CSSProperties}>
        <div className="stage">
          {media === 'live' && <LiveView onSize={fromMedia} />}
          {media === 'video' && run.hasVideo && (
            <video
              key={run.id}
              src={`/api/runs/${run.id}/video`}
              controls
              autoPlay
              muted
              onLoadedMetadata={(e) => fromMedia(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
            />
          )}
          {media === 'screenshot' && last?.imageKey && (
            <img src={imageUrl(last.imageKey)} alt="last screenshot" onLoad={(e) => fromMedia(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
          )}
          {media === 'live' && !active && <p className="muted stage-note">The run has finished. {run.hasVideo ? 'Watch the video.' : ''}</p>}
        </div>
        <Splitter
          axis={side ? 'x' : 'y'}
          size={stage}
          onSize={pane.set}
          onReset={pane.reset}
          unitsPerPixel={() => 100 / ((side ? split.current?.clientWidth : split.current?.clientHeight) || 1)}
          label="Resize video and steps"
        />
        <div className="steps-pane">
          <h3>Steps</h3>
          <ol className="step-list">
            {groupSteps(results).map((g) =>
              g.from ? (
                <StepGroup
                  key={g.items[0].id}
                  title={
                    g.from === setupName && g.items[0] === results[0] ? (
                      `Setup scenario: ${g.from}`
                    ) : scenarioNames.has(g.from.trim().toLowerCase()) ? (
                      `Run "${g.from}"`
                    ) : (
                      <>
                        {g.from} <span className="tag">library step</span>
                      </>
                    )
                  }
                  items={g.items}
                  selected={selected}
                  onSelect={setSelected}
                />
              ) : (
                g.items.map((r) => <StepRow key={r.id} r={r} selected={selected} onSelect={setSelected} />)
              ),
            )}
            {results.length === 0 && <li className="muted">Starting…</li>}
          </ol>
          {current && <ResultCard result={current} onReview={review} />}
        </div>
      </div>
    </div>
  );
}

/** The name of the project's setup scenario when it runs before `scenario` (not when it is that scenario). */
export function useSetupName(scenario?: Scenario): string | undefined {
  const [name, setName] = useState<string>();
  useEffect(() => {
    setName(undefined);
    if (!scenario) return;
    api<Project>(`/projects/${scenario.projectId}`)
      .then((p) => (p.setupScenarioId && p.setupScenarioId !== scenario.id ? api<Scenario>(`/scenarios/${p.setupScenarioId}`) : undefined))
      .then((s) => setName(s?.name))
      .catch(() => {});
  }, [scenario?.id, scenario?.projectId]);
  return name;
}

/** Consecutive steps that came from the same reused scenario or library step, so they can be folded under one header. */
function groupSteps(results: StepResult[]) {
  const groups: { from?: string; items: StepResult[] }[] = [];
  for (const r of results) {
    const from = r.from?.split(' › ')[0];
    const last = groups[groups.length - 1];
    if (last && last.from === from) last.items.push(r);
    else groups.push({ from, items: [r] });
  }
  return groups;
}

interface RowProps {
  selected?: string;
  onSelect: (id: string | undefined) => void;
}

function StepRow({ r, selected, onSelect, nested }: RowProps & { r: StepResult; nested?: boolean }) {
  const sub = nested && r.from?.includes(' › ') ? r.from.split(' › ').slice(1).join(' › ') : undefined;
  return (
    <li className={`step-row status-${r.status} ${r.id === selected ? 'selected' : ''}`} onClick={() => onSelect(r.id === selected ? undefined : r.id)}>
      <StatusBadge status={r.status} />
      <span className="step-text">{r.text}</span>
      {!nested && r.from && <span className="muted small">from {r.from}</span>}
      {sub && <span className="muted small">from {sub}</span>}
    </li>
  );
}

/** A folded block of steps from another scenario or a library step; opens by itself when something in it needs attention. */
function StepGroup({ title, items, selected, onSelect }: RowProps & { title: ReactNode; items: StepResult[] }) {
  const bad = items.some((r) => r.status === 'failed' || r.status === 'error');
  const [open, setOpen] = useState(bad);
  useEffect(() => {
    if (bad) setOpen(true);
  }, [bad]);
  const counts = items.reduce<Record<string, number>>((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});
  return (
    <li className="step-group">
      <button className="step-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tree-caret">{open ? '▾' : '▸'}</span>
        <span className="step-group-title">{title}</span>
        <span className="muted small">
          {items.length} steps · {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}
        </span>
      </button>
      {open && (
        <ol className="step-list nested">
          {items.map((r) => (
            <StepRow key={r.id} r={r} selected={selected} onSelect={onSelect} nested />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Old run links (`/runs/:id`) open the run on its scenario's page. */
export function RunRedirect() {
  const { id } = useParams();
  const [to, setTo] = useState<string>();
  useEffect(() => {
    api<{ run: { scenarioId: string } }>(`/runs/${id}`)
      .then(({ run }) => setTo(`/scenarios/${run.scenarioId}?run=${id}`))
      .catch(() => setTo('/'));
  }, [id]);
  return to ? <Navigate to={to} replace /> : <p className="muted">Loading…</p>;
}

function LiveView({ onSize }: { onSize: (width: number, height: number) => void }) {
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
        if (c.dataset.size !== `${f.width}x${f.height}`) {
          c.dataset.size = `${f.width}x${f.height}`;
          onSize(f.width, f.height);
        }
        const img = new Image();
        img.onload = () => c.getContext('2d')?.drawImage(img, 0, 0);
        img.src = `data:image/jpeg;base64,${f.data}`;
        setHas(true);
      }),
    [onFrame, onSize],
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
