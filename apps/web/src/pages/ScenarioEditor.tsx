import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { matchLibraryStep, parseStep, STEP_PATTERNS, stepParams, type LibraryStepView, type Run, type Scenario, type ScenarioStep } from '@izaro/shared';
import { api } from '../api';
import { useRunStream } from '../workspace/RunStream';
import { Splitter, usePaneSize } from '../workspace/Splitter';
import { RunDetail, useSetupName } from './RunDetail';
import type { NewStepState } from './StepEditor';

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
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [library, setLibrary] = useState<LibraryStepView[]>([]);
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const projectId = scenario?.projectId ?? (isNew ? projectParam : undefined);
  useEffect(() => {
    if (projectId) api<LibraryStepView[]>(`/projects/${projectId}/steps`).then(setLibrary);
  }, [projectId]);

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
  // A line is fine if it is a base step or one of the project's library steps.
  const problems = lines
    .map((l, i) => {
      const param = stepParams(l)[0];
      if (param) return { i, error: `replace {${param}} with a value` };
      const r = parseStep(l);
      return { i, error: r.ok || matchLibraryStep(l, library) ? undefined : r.error };
    })
    .filter((x) => x.error);

  /** The line the caret is on, and library steps that start the way it does. */
  const lineStart = text.lastIndexOf('\n', caret.start - 1) + 1;
  const lineEnd = text.indexOf('\n', caret.start) === -1 ? text.length : text.indexOf('\n', caret.start);
  const currentLine = text.slice(lineStart, lineEnd).trim();
  const typed = currentLine.split(/["“”]/)[0].trim().toLowerCase();
  const suggestions =
    typed.length >= 2 && !parseStep(currentLine).ok && !matchLibraryStep(currentLine, library)
      ? library.filter((st) => st.pattern.toLowerCase().startsWith(typed) || st.intent.toLowerCase().includes(typed)).slice(0, 5)
      : [];
  const trackCaret = (el: HTMLTextAreaElement) => setCaret({ start: el.selectionStart, end: el.selectionEnd });
  const edited = (next: string) => {
    setText(next);
    setSaved(false);
  };
  /** Puts a library step's sentence on the caret's line (replacing what was typed there) and selects its first {value} to type over. */
  const insertStep = (pattern: string) => {
    const append = !currentLine && caret.start === text.length && !!text && !text.endsWith('\n');
    const at = append ? text.length + 1 : lineStart;
    edited(append ? `${text}\n${pattern}` : text.slice(0, lineStart) + pattern + text.slice(lineEnd));
    const m = /\{[^}]+\}/.exec(pattern);
    const [from, to] = m ? [at + m.index, at + m.index + m[0].length] : [at + pattern.length, at + pattern.length];
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(from, to);
      if (textarea.current) trackCaret(textarea.current);
    });
  };
  /** Opens a new library step made of the selected lines (or all of them), keeping their element images. */
  const makeReusable = () => {
    const all = toSteps();
    // The textarea keeps its selection after the button takes focus.
    const sel = textarea.current ? { start: textarea.current.selectionStart, end: textarea.current.selectionEnd } : caret;
    const picked = sel.end > sel.start ? text.slice(0, sel.end).split('\n').filter((l) => l.trim()).length : 0;
    const first = sel.end > sel.start ? text.slice(0, sel.start).split('\n').slice(0, -1).filter((l) => l.trim()).length : 0;
    const body = picked ? all.slice(first, picked) : all;
    const state: NewStepState = { body, fromScenario: scenario && { id: scenario.id, name: scenario.name } };
    navigate(`/projects/${projectId}/steps/new`, { state });
  };

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

  const setupName = useSetupName(scenario);
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
          ref={textarea}
          className="scenario-text"
          value={text}
          spellCheck={false}
          placeholder={'Run "Log in"\nClick "Settings"\nExpect the "Settings" screen'}
          onChange={(e) => {
            edited(e.target.value);
            trackCaret(e.currentTarget);
          }}
          onSelect={(e) => trackCaret(e.currentTarget)}
          onKeyUp={(e) => trackCaret(e.currentTarget)}
          onMouseUp={(e) => trackCaret(e.currentTarget)}
        />
        {suggestions.length > 0 && (
          <div className="suggestions">
            <span className="muted small">Library steps:</span>
            {suggestions.map((st) => (
              <button key={st.id} className="chip" title={st.intent} onMouseDown={(e) => e.preventDefault()} onClick={() => insertStep(st.pattern)}>
                {st.pattern}
              </button>
            ))}
          </div>
        )}
        {problems.map(({ i, error }) => (
          <p key={i} className="error">
            Line {i + 1}: {error}
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
          <button
            className="link small push-right"
            onClick={makeReusable}
            disabled={!projectId || lines.length === 0}
            title="Turn the selected lines (or all of them) into a step in the project's step library"
          >
            Make reusable step
          </button>
        </div>
        {setupName && scenario && (
          <p className="setup-hint small">
            Each run first runs the setup scenario <strong>{setupName}</strong>.{' '}
            <Link to={`/projects/${scenario.projectId}`}>Change</Link>
          </p>
        )}
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
              <h4>
                Step library{' '}
                {projectId && (
                  <Link className="small" to={`/projects/${projectId}/steps`}>
                    open
                  </Link>
                )}
              </h4>
              {library.length === 0 ? (
                <p className="hint">This project has no library steps yet. Select lines above and choose Make reusable step.</p>
              ) : (
                <table className="table compact">
                  <tbody>
                    {library.map((st) => (
                      <tr key={st.id} className="clickable" title="Insert at the cursor" onMouseDown={(e) => e.preventDefault()} onClick={() => insertStep(st.pattern)}>
                        <td>
                          <code>{st.pattern}</code>
                        </td>
                        <td className="muted">{st.intent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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
