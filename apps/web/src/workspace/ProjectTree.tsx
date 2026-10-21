import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { Project, Run, Scenario } from '@izaro/shared';
import { api } from '../api';

/** Fired after a project setting changes on another page, so the tree (e.g. its "setup" tag) refreshes. */
export const PROJECTS_CHANGED = 'izaro:projects-changed';

const STATUS_ICON: Record<string, string> = { passed: '✓', failed: '✕', error: '!', review: '◐', running: '●', queued: '○' };

/** Left pane: projects, each with its screen library and a tree of scenarios and their recent runs. */
export function ProjectTree() {
  const location = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = () => setVersion((v) => v + 1);
    window.addEventListener(PROJECTS_CHANGED, changed);
    return () => window.removeEventListener(PROJECTS_CHANGED, changed);
  }, []);
  useEffect(() => {
    api<Project[]>('/projects').then((ps) => {
      setProjects(ps);
      setOpen((o) => (Object.keys(o).length || !ps[0] ? o : { [ps[0].id]: true }));
    });
  }, [location.pathname, version]);

  return (
    <nav className="tree">
      <div className="tree-head">
        <span>Projects</span>
        <NavLink to="/projects/new" className="tree-add" title="New project">
          +
        </NavLink>
      </div>
      {projects.length === 0 && <p className="muted small">No projects yet.</p>}
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <button className="tree-toggle" onClick={() => setOpen({ ...open, [p.id]: !open[p.id] })}>
              {open[p.id] ? '▾' : '▸'}
            </button>
            <NavLink to={`/projects/${p.id}`} end className="tree-item project">
              {p.name}
            </NavLink>
            {open[p.id] && <ProjectChildren project={p} />}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ProjectChildren({ project }: { project: Project }) {
  const location = useLocation();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  useEffect(() => {
    api<Scenario[]>(`/projects/${project.id}/scenarios`).then(setScenarios);
  }, [project.id, location.pathname]);
  return (
    <ul>
      <li className="tree-actions">
        <NavLink to={`/projects/${project.id}/record`} className="tree-item action">
          ● Record
        </NavLink>
        <NavLink to={`/projects/${project.id}/scenarios/new`} className="tree-item action">
          ✎ Write
        </NavLink>
      </li>
      <li>
        <NavLink to={`/projects/${project.id}/screens`} className="tree-item">
          ▦ Screen library
        </NavLink>
      </li>
      {scenarios.map((s) => (
        <ScenarioNode key={s.id} scenario={s} isSetup={s.id === project.setupScenarioId} />
      ))}
    </ul>
  );
}

function ScenarioNode({ scenario, isSetup }: { scenario: Scenario; isSetup: boolean }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    if (open) api<Run[]>(`/scenarios/${scenario.id}/runs`).then((r) => setRuns(r.slice(0, 8)));
  }, [open, scenario.id, location.pathname, location.search]);
  return (
    <li>
      <button className="tree-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'}
      </button>
      <NavLink to={`/scenarios/${scenario.id}`} className="tree-item">
        {scenario.name}
        {isSetup && <span className="tag">setup</span>}
      </NavLink>
      {open && (
        <ul>
          {runs.length === 0 && <li className="muted small tree-empty">No runs yet</li>}
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                to={`/scenarios/${scenario.id}?run=${r.id}`}
                className={`tree-item run run-${r.status} ${location.pathname === `/scenarios/${scenario.id}` && new URLSearchParams(location.search).get('run') === r.id ? 'active' : ''}`}
              >
                <span className="run-icon">{STATUS_ICON[r.status] ?? '·'}</span>
                {new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
