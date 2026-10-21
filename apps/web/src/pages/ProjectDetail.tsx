import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Project, Run, Scenario, Screen } from '@izaro/shared';
import { api, imageUrl } from '../api';

type Tab = 'scenarios' | 'screens';

export function ProjectDetail({ tab }: { tab: Tab }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project>();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    api<Project>(`/projects/${id}`).then(setProject).catch((e) => setError(e.message));
    api<Scenario[]>(`/projects/${id}/scenarios`).then(setScenarios);
    api<Screen[]>(`/projects/${id}/screens`).then(setScreens);
  };
  useEffect(load, [id]);

  const run = async (s: Scenario) => {
    try {
      const r = await api<Run>(`/scenarios/${s.id}/runs`, { method: 'POST' });
      navigate(`/scenarios/${r.scenarioId}?run=${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Picking a setup scenario only takes effect after Save, so a stray keystroke on the list can't switch it silently.
  const [pendingSetup, setPendingSetup] = useState<string>();
  const saveSetup = async () => {
    // null (not undefined, which JSON drops) so that "none" really clears it.
    setProject(await api<Project>(`/projects/${id}`, { method: 'PUT', json: { setupScenarioId: pendingSetup || null } }));
    setPendingSetup(undefined);
  };

  if (!project) return <p>{error || 'Loading…'}</p>;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{project.name}</h2>
        <div className="row">
          <Link className="button" to={`/projects/${project.id}/record`}>
            ● Record
          </Link>
          <Link className="button secondary" to={`/projects/${project.id}/scenarios/new`}>
            Write a scenario
          </Link>
        </div>
      </div>
      <p className="muted">
        {project.baseUrl} · {project.viewport.width}×{project.viewport.height}
      </p>
      <label className="inline">
        Setup scenario (runs first, e.g. sign-in):{' '}
        <select
          value={pendingSetup ?? project.setupScenarioId ?? ''}
          onChange={(e) => setPendingSetup(e.target.value === (project.setupScenarioId ?? '') ? undefined : e.target.value)}
        >
          <option value="">none</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {pendingSetup !== undefined && (
          <>
            {' '}
            <button onClick={saveSetup}>Save</button>{' '}
            <button className="secondary" onClick={() => setPendingSetup(undefined)}>
              Cancel
            </button>
          </>
        )}
      </label>
      {pendingSetup !== undefined && (
        <p className="hint">
          {pendingSetup
            ? `After saving, "${scenarios.find((s) => s.id === pendingSetup)?.name}" runs before every other scenario.`
            : 'After saving, scenarios run on their own, with no setup scenario first.'}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="segmented tabs">
        <button className={tab === 'scenarios' ? 'active' : ''} onClick={() => navigate(`/projects/${id}`)}>
          Scenarios ({scenarios.length})
        </button>
        <button className={tab === 'screens' ? 'active' : ''} onClick={() => navigate(`/projects/${id}/screens`)}>
          Screen library ({screens.length})
        </button>
      </div>

      {tab === 'scenarios' && (
        <table className="table">
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/scenarios/${s.id}`}>{s.name}</Link>
                  {s.id === project.setupScenarioId && <span className="badge">setup</span>}
                </td>
                <td className="muted">{s.steps.length} steps</td>
                <td className="right">
                  <button onClick={() => run(s)}>Run</button>
                </td>
              </tr>
            ))}
            {scenarios.length === 0 && (
              <tr>
                <td className="muted">No scenarios yet. Record one to start building the screen library.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {tab === 'screens' && <ScreenLibrary screens={screens} onSaved={load} />}
    </section>
  );
}

function ScreenLibrary({ screens, onSaved }: { screens: Screen[]; onSaved: () => void }) {
  if (screens.length === 0) return <p className="muted">Screens appear here as you record.</p>;
  return (
    <div className="screens">
      {screens.map((s) => (
        <ScreenCard key={s.id} screen={s} onSaved={onSaved} />
      ))}
    </div>
  );
}

function ScreenCard({ screen, onSaved }: { screen: Screen; onSaved: () => void }) {
  const [name, setName] = useState(screen.name);
  const [labels, setLabels] = useState(Object.fromEntries(screen.elements.map((e) => [e.id, e.label])));
  const dirty = name !== screen.name || screen.elements.some((e) => labels[e.id] !== e.label);
  const save = async () => {
    await api(`/screens/${screen.id}`, { method: 'PUT', json: { name, elements: Object.entries(labels).map(([id, label]) => ({ id, label })) } });
    onSaved();
  };
  return (
    <div className="screen-card">
      <img src={imageUrl(screen.imageKey)} alt={screen.name} />
      <input className="screen-name" value={name} onChange={(e) => setName(e.target.value)} />
      <p className="hint">{screen.url}</p>
      {screen.elements.length > 0 && (
        <ul className="elements">
          {screen.elements.map((e) => (
            <li key={e.id}>
              <img src={imageUrl(e.cropKey)} alt="" />
              <input value={labels[e.id]} onChange={(ev) => setLabels({ ...labels, [e.id]: ev.target.value })} />
            </li>
          ))}
        </ul>
      )}
      {dirty && <button onClick={save}>Save names</button>}
    </div>
  );
}
