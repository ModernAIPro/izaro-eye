import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LogEntry, Run, RunEvent, StepResult } from '@izaro/shared';
import { wsUrl } from '../api';

export interface Frame {
  data: string;
  width: number;
  height: number;
}

interface RunStreamState {
  runId?: string;
  run?: Run;
  results: StepResult[];
  logs: LogEntry[];
  /** Subscribe to live frames; returns an unsubscribe function. */
  onFrame(cb: (f: Frame) => void): () => void;
}

const Ctx = createContext<RunStreamState>({ results: [], logs: [], onFrame: () => () => {} });

/** One WebSocket per open run, shared by the execution view and the logs pane. */
export function RunStreamProvider({ runId, children }: { runId?: string; children: ReactNode }) {
  const [run, setRun] = useState<Run>();
  const [results, setResults] = useState<StepResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const frameSubs = useRef(new Set<(f: Frame) => void>());

  useEffect(() => {
    setRun(undefined);
    setResults([]);
    setLogs([]);
    if (!runId) return;
    const sock = new WebSocket(wsUrl(`/runs/${runId}/events`));
    sock.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as RunEvent;
      if (e.type === 'state') {
        setRun(e.run);
        setResults(e.results);
      } else if (e.type === 'logs') setLogs(e.entries);
      else if (e.type === 'log') setLogs((l) => [...l, e.entry]);
      else if (e.type === 'frame') frameSubs.current.forEach((cb) => cb(e));
    };
    return () => sock.close();
  }, [runId]);

  const onFrame = useCallback((cb: (f: Frame) => void) => {
    frameSubs.current.add(cb);
    return () => {
      frameSubs.current.delete(cb);
    };
  }, []);

  return <Ctx.Provider value={{ runId, run, results, logs, onFrame }}>{children}</Ctx.Provider>;
}

export const useRunStream = () => useContext(Ctx);

/**
 * Lets a page render its own panel in the right-hand pane instead of the logs
 * (the recorder's step list): the page portals into `slot` while it holds a claim.
 */
interface SidePane {
  slot: HTMLElement | null;
  claim(): () => void;
}
export const SidePaneContext = createContext<SidePane>({ slot: null, claim: () => () => {} });

export function useSidePaneSlot(): HTMLElement | null {
  const { slot, claim } = useContext(SidePaneContext);
  useEffect(() => claim(), [claim]);
  return slot;
}
