import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@izaro/shared';
import { api } from '../api';

const emptyAuth = {
  loginUrl: '/login',
  usernameSelector: '#username',
  passwordSelector: '#password',
  submitSelector: 'button[type=submit]',
  username: '{{env:AUT_USERNAME}}',
  password: '{{env:AUT_PASSWORD}}',
  successSelector: '',
};

const authLabels: Record<keyof typeof emptyAuth, string> = {
  loginUrl: 'Login URL',
  usernameSelector: 'Username field selector',
  passwordSelector: 'Password field selector',
  submitSelector: 'Submit button selector',
  username: 'Username',
  password: 'Password',
  successSelector: 'Logged-in check selector (optional)',
};

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:5050');
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(800);
  const [useAuth, setUseAuth] = useState(true);
  const [auth, setAuth] = useState(emptyAuth);

  const load = () => api<Project[]>('/projects').then(setProjects).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/projects', {
        method: 'POST',
        json: {
          name,
          baseUrl,
          viewport: { width, height },
          auth: useAuth ? { ...auth, successSelector: auth.successSelector || undefined } : undefined,
        },
      });
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="grid-2">
      <section className="panel">
        <h2>Projects</h2>
        {projects.length === 0 && <p className="muted">No projects yet. Create one to start recording.</p>}
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>{p.name}</Link>
              <span className="muted"> {p.baseUrl}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>New project</h2>
        <form onSubmit={create} className="form">
          <label>
            Name <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Base URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Width <input type="number" value={width} onChange={(e) => setWidth(+e.target.value)} />
            </label>
            <label>
              Height <input type="number" value={height} onChange={(e) => setHeight(+e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={useAuth} onChange={(e) => setUseAuth(e.target.checked)} /> App requires login
          </label>
          {useAuth && (
            <fieldset>
              <legend>Login</legend>
              {(Object.keys(emptyAuth) as (keyof typeof emptyAuth)[]).map((k) => (
                <label key={k}>
                  {authLabels[k]}
                  <input value={auth[k]} onChange={(e) => setAuth({ ...auth, [k]: e.target.value })} />
                </label>
              ))}
              <p className="hint">
                Use <code>{'{{env:NAME}}'}</code> so credentials stay in the server environment, not the database.
              </p>
            </fieldset>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit">Create project</button>
        </form>
      </section>
    </div>
  );
}
