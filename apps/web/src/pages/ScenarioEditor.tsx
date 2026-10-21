import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseStep, STEP_PATTERNS, type Run, type Scenario, type ScenarioStep } from '@izaro/shared';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';

/** Edit or write a scenario: one sentence per line, checked as you type. */
export function ScenarioEditor() {
  const { id, id: projectParam } = useParams();
  const isNew = location.pathname.endsWith('/new');
  const navigate = useNavigate();
  const [scenario, setScenario] = useState<Scenario>();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    if (isNew) return;
    api<Scenario>(`/scenarios/${id}`)
      .then((s) => {
        setScenario(s);
        setName(s.name);
        setText(s.steps.map((st) => st.text).join('\n'));
      })
      .catch((e) => setError(e.message));
    api<Run[]>(`/scenarios/${id}/runs`).then(setRuns);
  }, [id, isNew]);

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
      if (isNew) navigate(`/scenarios/${s.id}`, { replace: true });
      setScenario(s);
      return s;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async () => {
    const s = saved && scenario ? scenario : await save();
    if (!s) return;
    const r = await api<Run>(`/scenarios/${s.id}/runs`, { method: 'POST' });
    navigate(`/runs/${r.id}`);
  };

  return (
    <div className="grid-2 wide-left">
      <section className="panel">
        <div className="panel-head">
          <h2>{isNew ? 'New scenario' : scenario?.name ?? '…'}</h2>
          {scenario && <Link to={`/projects/${scenario.projectId}`}>← project</Link>}
        </div>
        <label className="form">
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <textarea
          className="scenario-text"
          rows={Math.max(10, lines.length + 2)}
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
          <button onClick={save} disabled={!name || lines.length === 0 || problems.length > 0 || saved}>
            Save
          </button>
          <button className="secondary" onClick={run} disabled={!name || lines.length === 0 || problems.length > 0}>
            {saved ? 'Run' : 'Save and run'}
          </button>
        </div>
      </section>
      <div>
        <section className="panel">
          <h3>Step patterns</h3>
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
        </section>
        {runs.length > 0 && (
          <section className="panel">
            <h3>Runs</h3>
            <table className="table">
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`}>{new Date(r.startedAt).toLocaleString()}</Link>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
