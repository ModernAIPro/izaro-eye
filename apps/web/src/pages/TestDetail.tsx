import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Run, TestCase } from '@izaro/shared';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';

export function TestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [test, setTest] = useState<TestCase>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<TestCase>(`/tests/${id}`).then(setTest).catch((e) => setError(e.message));
    api<Run[]>(`/tests/${id}/runs`).then(setRuns);
  }, [id]);

  const start = async (mode: 'baseline' | 'check') => {
    try {
      const r = await api<Run>(`/tests/${id}/runs`, { method: 'POST', json: { mode } });
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!test) return <p>{error || 'Loading…'}</p>;
  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-head">
          <h2>{test.name}</h2>
          <Link to={`/projects/${test.projectId}`}>← project</Link>
        </div>
        <div className="row">
          <button onClick={() => start('check')} disabled={!test.baselineId}>
            Run regression
          </button>
          <button className="secondary" onClick={() => start('baseline')}>
            Re-capture baseline
          </button>
          <a className="button secondary" href={`/api/tests/${test.id}/spec`}>
            Export Playwright spec
          </a>
        </div>
        {error && <p className="error">{error}</p>}
        <ol className="steps">
          {test.steps.map((s) => (
            <li key={s.id}>
              <span className={`step-action step-${s.action}`}>{s.action}</span>
              <span className="step-label">{s.label}</span>
              {s.selectors[0] && <code className="step-value">{s.selectors[0]}</code>}
            </li>
          ))}
        </ol>
      </section>
      <section className="panel">
        <h2>Runs</h2>
        <table className="table">
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>{new Date(r.startedAt).toLocaleString()}</Link>
                </td>
                <td>{r.mode}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
