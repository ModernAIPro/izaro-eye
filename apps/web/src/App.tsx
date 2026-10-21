import { useCallback, useState, type CSSProperties } from 'react';
import { Link, Navigate, Route, Routes, useMatch } from 'react-router-dom';
import { NewProject } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Recorder } from './pages/Recorder';
import { ScenarioEditor } from './pages/ScenarioEditor';
import { RunDetail } from './pages/RunDetail';
import { Home } from './pages/Home';
import { LogsPane } from './workspace/LogsPane';
import { ProjectTree } from './workspace/ProjectTree';
import { RunStreamProvider, SidePaneContext } from './workspace/RunStream';
import { Splitter, usePaneSize } from './workspace/Splitter';

/** One page: projects and scenarios on the left, the work in the centre, logs on the right. */
export function App() {
  const runMatch = useMatch('/runs/:id');
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((c) => c + 1);
    return () => setClaims((c) => c - 1);
  }, []);
  const left = usePaneSize('left', 260, 160, 520);
  const right = usePaneSize('right', 400, 260, 900);

  return (
    <RunStreamProvider runId={runMatch?.params.id}>
      <SidePaneContext.Provider value={{ slot, claim }}>
        <div className="workspace" style={{ '--left': `${left.size}px`, '--right': `${right.size}px` } as CSSProperties}>
          <header className="topbar">
            <Link to="/" className="brand">
              izaro-eye
            </Link>
            <span className="tagline">record screens · write scenarios · run visually</span>
          </header>
          <aside className="pane pane-left">
            <ProjectTree />
          </aside>
          <Splitter axis="x" size={left.size} onSize={left.set} onReset={left.reset} label="Resize navigation" />
          <main className="pane pane-center">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/projects/new" element={<NewProject />} />
              <Route path="/projects/:id" element={<ProjectDetail tab="scenarios" />} />
              <Route path="/projects/:id/screens" element={<ProjectDetail tab="screens" />} />
              <Route path="/projects/:id/record" element={<Recorder />} />
              <Route path="/projects/:id/scenarios/new" element={<ScenarioEditor />} />
              <Route path="/scenarios/:id" element={<ScenarioEditor />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
          <Splitter axis="x" size={right.size} onSize={right.set} onReset={right.reset} direction={-1} label="Resize logs" />
          <aside className="pane pane-right">
            <div ref={setSlot} className="side-slot" />
            {claims === 0 && <LogsPane />}
          </aside>
        </div>
      </SidePaneContext.Provider>
    </RunStreamProvider>
  );
}
