import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@izaro/shared';
import { api } from '../api';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:5050');
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(800);

  const load = () => api<Project[]>('/projects').then(setProjects).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/projects', { method: 'POST', json: { name, baseUrl, viewport: { width, height } } });
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
            Start address <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Width <input type="number" value={width} onChange={(e) => setWidth(+e.target.value)} />
            </label>
            <label>
              Height <input type="number" value={height} onChange={(e) => setHeight(+e.target.value)} />
            </label>
          </div>
          <p className="hint">
            Sign-in is recorded like any other scenario, then chosen as the project's setup scenario so it runs before the others.
          </p>
          {error && <p className="error">{error}</p>}
          <button type="submit">Create project</button>
        </form>
      </section>
    </div>
  );
}
