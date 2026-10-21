import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogSource } from '@izaro/shared';
import { useRunStream } from './RunStream';

type Filter = 'all' | LogSource;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'typesafe', label: 'TypeSafe AI' },
  { key: 'browser', label: 'Browser' },
  { key: 'runner', label: 'Runner' },
];

/** Right pane: the open run's logs, filterable by source, following new lines. */
export function LogsPane() {
  const { runId, logs } = useRunStream();
  const [filter, setFilter] = useState<Filter>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (filter === 'all' ? logs : logs.filter((l) => l.source === filter)), [logs, filter]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length };
    for (const l of logs) c[l.source] = (c[l.source] ?? 0) + 1;
    return c;
  }, [logs]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="logs">
      <div className="logs-head">
        <span>Logs</span>
        <label className="small muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
      </div>
      <div className="segmented small logs-filter">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label} {counts[f.key] ? <span className="count">{counts[f.key]}</span> : null}
          </button>
        ))}
      </div>
      <div className="logs-body" ref={box}>
        {!runId && <p className="muted small">Open or start a run to see TypeSafe AI, browser and runner logs here.</p>}
        {runId && shown.length === 0 && <p className="muted small">No log lines yet.</p>}
        {shown.map((l, i) => (
          <div key={i} className={`log log-${l.level}`}>
            <span className="log-time">{new Date(l.at).toLocaleTimeString(undefined, { hour12: false })}</span>
            <span className={`log-src src-${l.source}`}>{l.source === 'typesafe' ? 'jev' : l.source}</span>
            <span className="log-msg">
              {l.step !== undefined && <span className="log-step">#{l.step + 1}</span>}
              {l.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
