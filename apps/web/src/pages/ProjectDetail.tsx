import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Project, Run, TestCase } from '@izaro/shared';
import { api } from '../api';

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project>();
  const [tests, setTests] = useState<TestCase[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Project>(`/projects/${id}`).then(setProject).catch((e) => setError(e.message));
    api<TestCase[]>(`/projects/${id}/tests`).then(setTests);
  }, [id]);

  const run = async (t: TestCase) => {
    try {
      const r = await api<Run>(`/tests/${t.id}/runs`, { method: 'POST', json: {} });
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!project) return <p>{error || 'Loading…'}</p>;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{project.name}</h2>
        <Link className="button" to={`/projects/${project.id}/record`}>
          ● Record new test
        </Link>
      </div>
      <p className="muted">
        {project.baseUrl} · {project.viewport.width}×{project.viewport.height} · {project.auth ? 'login enabled' : 'no login'}
      </p>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Test</th>
            <th>Steps</th>
            <th>Baseline</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t.id}>
              <td>
                <Link to={`/tests/${t.id}`}>{t.name}</Link>
              </td>
              <td>{t.steps.length}</td>
              <td>{t.baselineId ? 'yes' : <span className="muted">none</span>}</td>
              <td className="right">
                <button onClick={() => run(t)}>{t.baselineId ? 'Run regression' : 'Create baseline'}</button>
              </td>
            </tr>
          ))}
          {tests.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No tests yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
