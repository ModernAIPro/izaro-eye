import { Link, Route, Routes } from 'react-router-dom';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Recorder } from './pages/Recorder';
import { ScenarioEditor } from './pages/ScenarioEditor';
import { RunDetail } from './pages/RunDetail';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          izaro-eye
        </Link>
        <span className="tagline">record screens · write scenarios · run visually</span>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/record" element={<Recorder />} />
          <Route path="/projects/:id/scenarios/new" element={<ScenarioEditor />} />
          <Route path="/scenarios/:id" element={<ScenarioEditor />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </main>
    </div>
  );
}
