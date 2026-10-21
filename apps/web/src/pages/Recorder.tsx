import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Assertion, InspectedElement, RecorderClientMessage, RecorderServerMessage, Step, Viewport } from '@izaro/shared';
import { api, wsUrl } from '../api';

type Mode = 'interact' | 'assert';
const BUTTONS = ['left', 'middle', 'right'] as const;

export function Recorder() {
  const { id: projectId } = useParams();
  const navigate = useNavigate();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ws = useRef<WebSocket>(null);
  const lastMove = useRef(0);
  const [session, setSession] = useState<{ id: string; viewport: Viewport }>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('interact');
  const [picked, setPicked] = useState<InspectedElement | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  // Start a recording session and connect to its stream.
  useEffect(() => {
    let closed = false;
    let sid: string | undefined;
    api<{ id: string; viewport: Viewport }>(`/projects/${projectId}/recordings`, { method: 'POST', json: {} })
      .then((s) => {
        if (closed) return api(`/recordings/${s.id}`, { method: 'DELETE' });
        sid = s.id;
        setSession(s);
        const sock = new WebSocket(wsUrl(`/recordings/${s.id}/ws`));
        ws.current = sock;
        sock.onmessage = (ev) => onServer(JSON.parse(ev.data));
      })
      .catch((e) => setError(e.message))
      .finally(() => setStarting(false));
    return () => {
      closed = true;
      ws.current?.close();
      if (sid) fetch(`/api/recordings/${sid}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onServer = (m: RecorderServerMessage) => {
    if (m.type === 'frame') {
      const img = new Image();
      img.onload = () => canvas.current?.getContext('2d')?.drawImage(img, 0, 0);
      img.src = `data:image/jpeg;base64,${m.data}`;
    } else if (m.type === 'steps') setSteps(m.steps);
    else if (m.type === 'url') setUrl(m.url);
    else if (m.type === 'inspected') setPicked(m.element);
    else if (m.type === 'error') setError(m.message);
  };

  const send = (m: RecorderClientMessage) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));

  const point = (e: MouseEvent | WheelEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  const onMouse = (event: 'down' | 'up' | 'move') => (e: MouseEvent) => {
    if (mode === 'assert') {
      if (event === 'down') send({ type: 'inspect', ...point(e) });
      return;
    }
    if (event === 'move') {
      if (Date.now() - lastMove.current < 50) return;
      lastMove.current = Date.now();
    }
    if (event === 'down') canvas.current?.focus();
    send({ type: 'mouse', event, ...point(e), button: BUTTONS[e.button] ?? 'left' });
  };

  const onKey = (event: 'down' | 'up') => (e: KeyboardEvent) => {
    if (mode !== 'interact' || e.key === 'Dead' || e.key === 'Unidentified') return;
    e.preventDefault();
    send({ type: 'key', event, key: e.key });
  };

  const addAssertion = (assertion: Assertion) => {
    if (!picked && assertion.kind !== 'url') return;
    send({ type: 'assert', selectors: picked?.selectors ?? [], assertion });
    setPicked(null);
  };

  const save = async () => {
    if (!session || !name) return;
    try {
      const res = await api<{ test: { id: string }; run?: { id: string } }>(`/recordings/${session.id}/save`, { method: 'POST', json: { name } });
      ws.current?.close();
      navigate(res.run ? `/runs/${res.run.id}` : `/tests/${res.test.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="recorder">
      <div className="recorder-main">
        <div className="toolbar">
          <form
            className="urlbar"
            onSubmit={(e) => {
              e.preventDefault();
              send({ type: 'navigate', url });
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL" />
          </form>
          <div className="segmented">
            <button className={mode === 'interact' ? 'active' : ''} onClick={() => setMode('interact')}>
              Interact
            </button>
            <button className={mode === 'assert' ? 'active' : ''} onClick={() => setMode('assert')}>
              Add assertion
            </button>
          </div>
        </div>
        {starting && <p className="muted">Starting browser…</p>}
        {error && <p className="error">{error}</p>}
        {session && (
          <canvas
            ref={canvas}
            className={`screen ${mode === 'assert' ? 'picking' : ''}`}
            width={session.viewport.width}
            height={session.viewport.height}
            tabIndex={0}
            onMouseDown={onMouse('down')}
            onMouseUp={onMouse('up')}
            onMouseMove={onMouse('move')}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => mode === 'interact' && send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
            onKeyDown={onKey('down')}
            onKeyUp={onKey('up')}
          />
        )}
      </div>

      <aside className="recorder-side">
        {mode === 'assert' && (
          <div className="panel">
            <h3>Assertion</h3>
            {!picked && <p className="muted">Click an element in the page to assert on it.</p>}
            {picked && <AssertionPicker element={picked} onAdd={addAssertion} />}
            <button className="secondary" onClick={() => addAssertion({ kind: 'url', pattern: escapeRegex(url) })}>
              Assert current URL
            </button>
          </div>
        )}
        <div className="panel">
          <h3>Steps ({steps.length})</h3>
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.id}>
                <span className={`step-action step-${s.action}`}>{s.action}</span>
                <span className="step-label">{s.label}</span>
                {s.value && s.action !== 'press' && <code className="step-value">{s.secret ? '••••••' : s.value}</code>}
                <button className="link" title="Remove step" onClick={() => send({ type: 'deleteStep', stepId: s.id })}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="panel">
          <h3>Save test</h3>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Test name" />
          <button onClick={save} disabled={!name || steps.length === 0}>
            Save and create baseline
          </button>
        </div>
      </aside>
    </div>
  );
}

function AssertionPicker({ element, onAdd }: { element: InspectedElement; onAdd: (a: Assertion) => void }) {
  const [text, setText] = useState(element.text);
  useEffect(() => setText(element.text), [element]);
  return (
    <div className="picker">
      <p>
        <code>{element.selectors[0]}</code>
      </p>
      <button onClick={() => onAdd({ kind: 'visible' })}>Is visible</button>
      <button onClick={() => onAdd({ kind: 'visual' })}>Visual checkpoint</button>
      {element.value !== undefined && element.tag !== 'div' && (
        <button onClick={() => onAdd({ kind: 'value', expected: element.value! })}>Value is "{element.value}"</button>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="row">
        <button onClick={() => onAdd({ kind: 'text', op: 'contains', expected: text })}>Text contains</button>
        <button onClick={() => onAdd({ kind: 'text', op: 'equals', expected: text })}>Text equals</button>
      </div>
    </div>
  );
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
