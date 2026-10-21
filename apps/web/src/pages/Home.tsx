import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { Project } from '@izaro/shared';
import { api } from '../api';

export function Home() {
  const [projects, setProjects] = useState<Project[]>();
  useEffect(() => {
    api<Project[]>('/projects').then(setProjects);
  }, []);
  if (!projects) return null;
  if (projects.length) return <Navigate to={`/projects/${projects[0].id}`} replace />;
  return (
    <section className="panel">
      <h2>Welcome to izaro-eye</h2>
      <p>Create a project for the application you want to test, then record a scenario to start building its screen library.</p>
      <Link className="button" to="/projects/new">
        New project
      </Link>
    </section>
  );
}
