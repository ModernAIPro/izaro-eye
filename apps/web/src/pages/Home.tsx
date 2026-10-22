import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, Run, Scenario } from '@izaro/shared';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const LINES = [
  'Eyes open. Let’s catch the bugs before your users do.',
  'Every pixel has a story. Let’s make sure it’s the right one.',
  'Your screens, watched carefully, so you don’t have to.',
  'Record once, run forever, blink never.',
  'A second pair of eyes that never gets tired of clicking “Save”.',
];

function greeting(hour: number) {
  if (hour < 5) return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

interface ProjectSummary {
  project: Project;
  scenarios: number;
  lastRun?: Run;
}

/** The welcome page the logo leads to: a greeting, how izaro-eye works, and every project at a glance. */
export function Home() {
  const [summaries, setSummaries] = useState<ProjectSummary[]>();
  const [line] = useState(() => LINES[Math.floor(Math.random() * LINES.length)]);

  useEffect(() => {
    let live = true;
    (async () => {
      const projects = await api<Project[]>('/projects');
      const out = await Promise.all(
        projects.map(async (project) => {
          const scenarios = await api<Scenario[]>(`/projects/${project.id}/scenarios`).catch(() => []);
          const runs = await Promise.all(
            scenarios.slice(0, 20).map((s) => api<Run[]>(`/scenarios/${s.id}/runs`).then((r) => r[0]).catch(() => undefined)),
          );
          const lastRun = runs
            .filter((r): r is Run => !!r)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
          return { project, scenarios: scenarios.length, lastRun };
        }),
      );
      if (live) setSummaries(out);
    })().catch(() => live && setSummaries([]));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="home">
      <section className="home-hero">
        <WatchingEye />
        <div>
          <p className="home-greeting">{greeting(new Date().getHours())} 👋</p>
          <h1>Welcome to izaro-eye</h1>
          <p className="home-line">{line}</p>
          <div className="home-cta">
            {summaries?.[0] ? (
              <>
                <Link className="button" to={`/projects/${summaries[0].project.id}/record`}>
                  ● Record a scenario
                </Link>
                <Link className="button secondary" to="/projects/new">
                  New project
                </Link>
              </>
            ) : (
              <Link className="button" to="/projects/new">
                Create your first project
              </Link>
            )}
          </div>
        </div>
      </section>

      <ol className="home-steps">
        <li>
          <span className="home-step-icon">●</span>
          <strong>Record</strong>
          <span className="muted">Click through your app once. Every screen lands in the library.</span>
        </li>
        <li>
          <span className="home-step-icon">✎</span>
          <strong>Write</strong>
          <span className="muted">Turn clicks into plain-English steps anyone on the team can read.</span>
        </li>
        <li>
          <span className="home-step-icon">▶</span>
          <strong>Run</strong>
          <span className="muted">Watch it replay live, and see exactly which pixels changed.</span>
        </li>
      </ol>

      {summaries && summaries.length > 0 && (
        <section>
          <h2 className="home-section">Your projects</h2>
          <div className="home-projects">
            {summaries.map(({ project, scenarios, lastRun }) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="home-project">
                <strong>{project.name}</strong>
                <span className="muted small home-url">{project.baseUrl}</span>
                <span className="home-project-meta small">
                  <span>
                    {scenarios} scenario{scenarios === 1 ? '' : 's'}
                  </span>
                  {lastRun ? <StatusBadge status={lastRun.status} /> : <span className="muted">no runs yet</span>}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** The logo's eye, large, with a pupil that follows the pointer and an occasional blink. */
function WatchingEye() {
  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const dx = e.clientX - (box.left + box.width / 2);
      const dy = e.clientY - (box.top + box.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 300);
      setLook({ x: (dx / d) * 7 * reach, y: (dy / d) * 5 * reach });
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);
  return (
    <svg ref={ref} className="home-eye" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <g className="home-eye-lid">
        <path d="M6 32C13 20 22 14 32 14s19 6 26 18C51 44 42 50 32 50S13 44 6 32Z" fill="#fff" />
        <g style={{ transform: `translate(${look.x}px, ${look.y}px)` }} className="home-eye-pupil">
          <circle cx="32" cy="32" r="12" fill="var(--accent)" />
          <circle cx="32" cy="32" r="5.5" fill="#12151c" />
          <circle cx="36" cy="28" r="2.5" fill="#fff" />
        </g>
      </g>
    </svg>
  );
}
