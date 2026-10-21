import { Link, Route, Routes } from 'react-router-dom';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Recorder } from './pages/Recorder';
import { TestDetail } from './pages/TestDetail';
import { RunDetail } from './pages/RunDetail';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          izaro-eye
        </Link>
        <span className="tagline">record · baseline · rerun · classify</span>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/record" element={<Recorder />} />
          <Route path="/tests/:id" element={<TestDetail />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </main>
    </div>
  );
}
