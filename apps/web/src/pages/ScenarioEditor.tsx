import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { parseStep, STEP_PATTERNS, type Run, type Scenario, type ScenarioStep } from '@izaro/shared';
import { api } from '../api';
import { useRunStream } from '../workspace/RunStream';
import { Splitter, usePaneSize } from '../workspace/Splitter';
import { RunDetail } from './RunDetail';

/**
 * Write a scenario and run it on the same page: the sentences on the left, the run (live browser,
 * video, steps) on the right. The run shown is `?run=`, or the latest one.
 */
export function ScenarioEditor() {
  const { id, id: projectParam } = useParams();
  const isNew = !!useMatch('/projects/:id/scenarios/new');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const stream = useRunStream();
  const [scenario, setScenario] = useState<Scenario>();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);
  const editorSize = usePaneSize('editor', 38, 20, 70);
  const patternsSize = usePaneSize('patterns', 35, 10, 80);
  const [patternsOpen, setPatternsOpen] = useState(() => {
    try {
      return localStorage.getItem('izaro.patterns.open') === '1';
    } catch {
      return false;
    }
  });
  const togglePatterns = () => {
    setPatternsOpen(!patternsOpen);
    try {
      localStorage.setItem('izaro.patterns.open', patternsOpen ? '0' : '1');
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  const edit = useRef<HTMLElement>(null);

  useEffect(() => {
    setRuns([]);
    setError('');
    if (isNew) {
      setScenario(undefined);
      setName('');
      setText('');
      return;
    }
    api<Scenario>(`/scenarios/${id}`)
      .then((s) => {
        setScenario(s);
        setName(s.name);
        setText(s.steps.map((st) => st.text).join('\n'));
        setSaved(true);
      })
      .catch((e) => setError(e.message));
  }, [id, isNew]);

  // Refresh the run list when a run starts or finishes, so its status stays current.
  useEffect(() => {
    if (isNew) return;
    api<Run[]>(`/scenarios/${id}/runs`).then((rs) => {
      setRuns(rs);
      if (!runId && rs[0]) setParams({ run: rs[0].id }, { replace: true });
    });
  }, [id, isNew, runId, stream.run?.status]);

  const lines = useMemo(() => text.split('\n').filter((l) => l.trim()), [text]);
  const problems = lines.map((l, i) => ({ i, r: parseStep(l) })).filter((x) => !x.r.ok);

  /** Keeps the library link of recorded steps whose text is unchanged. */
  const toSteps = (): ScenarioStep[] => {
    const pool = [...(scenario?.steps ?? [])];
    return lines.map((l) => {
      const k = pool.findIndex((s) => s.text === l.trim());
      const hint = k >= 0 ? pool.splice(k, 1)[0].hint : undefined;
      return { text: l.trim(), hint };
    });
  };

  const save = async (): Promise<Scenario | undefined> => {
    setError('');
    try {
      const s = isNew
        ? await api<Scenario>(`/projects/${projectParam}/scenarios`, { method: 'POST', json: { name, steps: toSteps() } })
        : await api<Scenario>(`/scenarios/${id}`, { method: 'PUT', json: { name, steps: toSteps() } });
      setSaved(true);
      setScenario(s);
      if (isNew) navigate(`/scenarios/${s.id}`, { replace: true });
      return s;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async () => {
    const s = saved && scenario ? scenario : await save();
    if (!s) return;
    const r = await api<Run>(`/scenarios/${s.id}/runs`, { method: 'POST' });
    navigate(`/scenarios/${s.id}?run=${r.id}`);
  };

  const running = stream.run && (stream.run.status === 'running' || stream.run.status === 'queued');
  const canRun = !!name && lines.length > 0 && problems.length === 0;

  return (
    <div className="scenario-page" style={{ '--editor': `${editorSize.size}%`, '--patterns': `${patternsSize.size}%` } as CSSProperties}>
      <section className={`scenario-edit ${patternsOpen ? 'with-patterns' : ''}`} ref={edit}>
        <div className="panel-head">
          <input
            className="scenario-name"
            value={name}
            placeholder="Scenario name"
            aria-label="Name"
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          {scenario && <Link to={`/projects/${scenario.projectId}`}>← project</Link>}
        </div>
        <textarea
          className="scenario-text"
          value={text}
          spellCheck={false}
          placeholder={'Run "Sign in"\nClick "Shop individual and family plans"\nExpect the "Plans" screen'}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
        />
        {problems.map(({ i, r }) => (
          <p key={i} className="error">
            Line {i + 1}: {!r.ok && r.error}
          </p>
        ))}
        {error && <pre className="error">{error}</pre>}
        <div className="row">
          <button onClick={run} disabled={!canRun || !!running}>
            {running ? 'Running…' : saved ? '▶ Run' : '▶ Save and run'}
          </button>
          <button className="secondary" onClick={save} disabled={!canRun || saved}>
            Save
          </button>
          {!saved && <span className="muted small">Unsaved changes</span>}
        </div>
        {patternsOpen && (
          <Splitter
            axis="y"
            size={patternsSize.size}
            onSize={patternsSize.set}
            onReset={patternsSize.reset}
            direction={-1}
            unitsPerPixel={() => 100 / (edit.current?.clientHeight || 1)}
            label="Resize editor and step patterns"
          />
        )}
        <section className={`patterns ${patternsOpen ? 'open' : ''}`}>
          <button className="link patterns-toggle" onClick={togglePatterns} aria-expanded={patternsOpen}>
            {patternsOpen ? '▾' : '▸'} Step patterns
          </button>
          {patternsOpen && (
            <div className="patterns-body">
              <table className="table compact">
                <tbody>
                  {STEP_PATTERNS.map((p) => (
                    <tr key={p.pattern}>
                      <td>
                        <code>{p.pattern}</code>
                      </td>
                      <td className="muted">{p.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                Labels in quotes are what you see on screen; they are matched to the screen library and found with jev-img. Secrets: <code>{'"{{secret:NAME}}"'}</code>.
              </p>
            </div>
          )}
        </section>
      </section>
      <Splitter
        axis="x"
        size={editorSize.size}
        onSize={editorSize.set}
        onReset={editorSize.reset}
        unitsPerPixel={() => 100 / (document.querySelector('.scenario-page')?.clientWidth || 1)}
        label="Resize editor and run"
      />
      <section className="scenario-run">
        {runId ? (
          <RunDetail
            embedded
            picker={
              <select className="run-picker" aria-label="Run" value={runId} onChange={(e) => setParams({ run: e.target.value })}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.startedAt).toLocaleString()} · {r.status}
                  </option>
                ))}
              </select>
            }
          />
        ) : (
          <p className="muted run-empty">{isNew ? 'Save the scenario, then run it to watch it here.' : 'Press Run to watch the scenario here.'}</p>
        )}
      </section>
    </div>
  );
}
