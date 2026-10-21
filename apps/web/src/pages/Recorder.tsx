import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseStep, UNLABELLED, type RecorderClientMessage, type RecorderServerMessage, type RecorderStep, type Viewport } from '@izaro/shared';
import { api, imageUrl, wsUrl } from '../api';

const BUTTONS = ['left', 'middle', 'right'] as const;

export function Recorder() {
  const { id: projectId } = useParams();
  const navigate = useNavigate();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ws = useRef<WebSocket>(null);
  const lastMove = useRef(0);
  const [session, setSession] = useState<{ id: string; viewport: Viewport }>();
  const [steps, setSteps] = useState<RecorderStep[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [expectText, setExpectText] = useState('');
  const [secret, setSecret] = useState('AUT_PASSWORD');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

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
    else if (m.type === 'busy') setBusy(m.busy);
    else if (m.type === 'error') setError(m.message);
  };

  const send = (m: RecorderClientMessage) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));

  const point = (e: MouseEvent | WheelEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  const onMouse = (event: 'down' | 'up' | 'move') => (e: MouseEvent) => {
    if (event === 'move') {
      if (Date.now() - lastMove.current < 50) return;
      lastMove.current = Date.now();
    }
    if (event === 'down') canvas.current?.focus();
    send({ type: 'mouse', event, ...point(e), button: BUTTONS[e.button] ?? 'left' });
  };

  const onKey = (event: 'down' | 'up') => (e: KeyboardEvent) => {
    if (e.key === 'Dead' || e.key === 'Unidentified') return;
    e.preventDefault();
    send({ type: 'key', event, key: e.key });
  };

  /** Renaming one "?" also names every other step that used the same element. */
  const editStep = (i: number, text: string) => {
    const before = parseStep(steps[i].text);
    const after = parseStep(text);
    const el = steps[i].hint?.elementId;
    const renamed =
      before.ok && after.ok && 'target' in before.action && 'target' in after.action && before.action.target === UNLABELLED && el
        ? (after.action as { target: string }).target
        : undefined;
    const next = steps.map((s, j) => {
      if (j === i) return { ...s, text };
      if (renamed && s.hint?.elementId === el) return { ...s, text: s.text.replace(`"${UNLABELLED}"`, `"${renamed}"`) };
      return s;
    });
    setSteps(next);
    send({ type: 'setSteps', steps: next });
  };

  const removeStep = (i: number) => {
    const next = steps.filter((_, j) => j !== i);
    setSteps(next);
    send({ type: 'setSteps', steps: next });
  };

  const save = async () => {
    if (!session || !name) return;
    try {
      const s = await api<{ id: string }>(`/recordings/${session.id}/save`, { method: 'POST', json: { name, steps } });
      ws.current?.close();
      navigate(`/scenarios/${s.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unnamed = steps.filter((s) => s.text.includes(`"${UNLABELLED}"`)).length;

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
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Address" />
          </form>
          {busy && <span className="muted">capturing element…</span>}
        </div>
        {starting && <p className="muted">Starting browser (and running the setup scenario, if any)…</p>}
        {error && <p className="error">{error}</p>}
        {session && (
          <canvas
            ref={canvas}
            className="screen"
            width={session.viewport.width}
            height={session.viewport.height}
            tabIndex={0}
            onMouseDown={onMouse('down')}
            onMouseUp={onMouse('up')}
            onMouseMove={onMouse('move')}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
            onKeyDown={onKey('down')}
            onKeyUp={onKey('up')}
          />
        )}
      </div>

      <aside className="recorder-side">
        <div className="panel">
          <h3>Scenario ({steps.length} steps)</h3>
          <p className="hint">
            Name each element marked <code>"?"</code> the way a user would describe it, e.g. <code>"Sign in"</code>.
          </p>
          <ol className="steps editable">
            {steps.map((s, i) => {
              const p = parseStep(s.text);
              return (
                <li key={i} className={!p.ok || s.text.includes(`"${UNLABELLED}"`) ? 'needs-name' : ''}>
                  {s.cropKey && <img className="crop" src={imageUrl(s.cropKey)} alt="" />}
                  <input value={s.text} onChange={(e) => editStep(i, e.target.value)} />
                  <button className="link" title="Remove step" onClick={() => removeStep(i)}>
                    ✕
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="panel">
          <h3>Add</h3>
          <div className="row">
            <input value={expectText} onChange={(e) => setExpectText(e.target.value)} placeholder="Text that must be on screen" />
            <button
              disabled={!expectText}
              onClick={() => {
                send({ type: 'expectText', text: expectText });
                setExpectText('');
              }}
            >
              Expect to see
            </button>
          </div>
          <div className="row">
            <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Secret name" />
            <button className="secondary" onClick={() => send({ type: 'secret', name: secret })}>
              Insert secret
            </button>
          </div>
          <p className="hint">Click a field first. The secret is typed from the server's environment and saved as a placeholder.</p>
        </div>
        <div className="panel">
          <h3>Save scenario</h3>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name, e.g. Sign in" />
          {unnamed > 0 && <p className="hint">{unnamed} step(s) still need an element name.</p>}
          <button onClick={save} disabled={!name || steps.length === 0 || unnamed > 0}>
            Save scenario
          </button>
        </div>
      </aside>
    </div>
  );
}
