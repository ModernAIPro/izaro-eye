import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Project, Run, Scenario, Screen } from '@izaro/shared';
import { PROJECTS_CHANGED } from '../workspace/ProjectTree';
import { api, imageUrl } from '../api';

type Tab = 'scenarios' | 'screens' | 'settings';

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
    window.dispatchEvent(new Event(PROJECTS_CHANGED));
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
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => navigate(`/projects/${id}/settings`)}>
          Settings
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
      {tab === 'settings' && <ProjectSettings project={project} scenarioCount={scenarios.length} screenCount={screens.length} onChange={setProject} />}
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

/** Project-level settings: its own TypeSafe key, and deleting the project. No browser dialogs; confirmations are in the page. */
function ProjectSettings({
  project,
  scenarioCount,
  screenCount,
  onChange,
}: {
  project: Project;
  scenarioCount: number;
  screenCount: number;
  onChange: (p: Project) => void;
}) {
  const navigate = useNavigate();
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const saveKey = async (value: string | null) => {
    setError('');
    setBusy(true);
    try {
      onChange(await api<Project>(`/projects/${project.id}/typesafe-key`, { method: 'PUT', json: { key: value } }));
      setEditingKey(false);
      setKey('');
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError('');
    setBusy(true);
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <section className="setting">
        <h3>TypeSafe API key</h3>
        <p className="muted small">
          jev-img calls for this project use this key. Without one, the server&apos;s key (<code>TYPESAFE_API_KEY</code> in{' '}
          <code>apps/server/.env</code>) is used. The key is stored on the server and never shown again; only its last 4 characters are.
        </p>
        {!editingKey ? (
          <div className="row">
            <span>{project.typesafeKey ? <>Project key ••••{project.typesafeKey.last4}</> : <span className="muted">Using the server&apos;s key</span>}</span>
            <button className="secondary" onClick={() => setEditingKey(true)}>
              {project.typesafeKey ? 'Replace' : 'Set a project key'}
            </button>
            {project.typesafeKey && (
              <button className="secondary" disabled={busy} onClick={() => saveKey(null)}>
                Remove
              </button>
            )}
          </div>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              saveKey(key);
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="apikey_…"
              aria-label="TypeSafe API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy || !key.trim()}>
              Save
            </button>
            <button type="button" className="secondary" onClick={() => (setEditingKey(false), setKey(''))}>
              Cancel
            </button>
          </form>
        )}
      </section>

      <section className="setting danger">
        <h3>Delete project</h3>
        {!confirmDelete ? (
          <>
            <p className="muted small">Removes the project with its scenarios, runs, logs, videos and screen library.</p>
            <button className="danger" onClick={() => setConfirmDelete(true)}>
              Delete project…
            </button>
          </>
        ) : (
          <div className="confirm">
            <p>
              Delete <strong>{project.name}</strong>, its {scenarioCount} scenario{scenarioCount === 1 ? '' : 's'}, their runs and its {screenCount} library screen
              {screenCount === 1 ? '' : 's'}? This can&apos;t be undone.
            </p>
            <div className="row">
              <button className="danger" disabled={busy} onClick={remove}>
                {busy ? 'Deleting…' : 'Delete project'}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </div>
          </div>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
