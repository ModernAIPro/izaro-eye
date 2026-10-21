import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';
import {
  matchLibraryStep,
  parseStep,
  patternProblems,
  stepParams,
  UNLABELLED,
  type LibraryStep,
  type LibraryStepKind,
  type LibraryStepView,
  type ScenarioStep,
  type Screen,
} from '@izaro/shared';
import { api } from '../api';
import { PROJECTS_CHANGED } from '../workspace/ProjectTree';

/** What "Make reusable step" in the scenario editor hands over. */
export interface NewStepState {
  body: ScenarioStep[];
  fromScenario?: { id: string; name: string };
}

export const STEP_KINDS: { kind: LibraryStepKind; label: string; hint: string }[] = [
  { kind: 'action', label: 'Action', hint: 'A few steps on one screen, e.g. searching' },
  { kind: 'flow', label: 'Flow', hint: 'Goes from one screen to another, e.g. checking out' },
  { kind: 'check', label: 'Check', hint: 'Only looks, never changes anything, e.g. the cart shows a total' },
];

/** Problems with body lines, by line, checked the way the server checks them. */
export function bodyProblems(lines: string[], pattern: string, others: LibraryStep[]): string[] {
  const params = new Set(stepParams(pattern));
  const problems: string[] = [];
  lines.forEach((l, i) => {
    const p = parseStep(l);
    if (!p.ok && !matchLibraryStep(l, others)) problems.push(`Line ${i + 1}: ${p.error}`);
    else if (p.ok && 'target' in p.action && p.action.target === UNLABELLED) problems.push(`Line ${i + 1}: name the element (replace "${UNLABELLED}")`);
    for (const n of stepParams(l)) if (!params.has(n)) problems.push(`Line ${i + 1}: {${n}} isn't in the sentence`);
  });
  return problems;
}

/** Edit one library step: its sentence, what it is for, where it starts and ends, and the steps it runs. */
export function StepEditor() {
  const { id } = useParams();
  const isNew = !!useMatch('/projects/:id/steps/new');
  const navigate = useNavigate();
  const handed = useLocation().state as NewStepState | null;
  const [step, setStep] = useState<LibraryStepView>();
  const [projectId, setProjectId] = useState(isNew ? id : undefined);
  const [others, setOthers] = useState<LibraryStep[]>([]);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<LibraryStepKind>('action');
  const [intent, setIntent] = useState('');
  const [startScreenId, setStart] = useState('');
  const [endScreenId, setEnd] = useState('');
  const [tags, setTags] = useState('');
  const [text, setText] = useState(handed?.body.map((b) => b.text).join('\n') ?? '');
  const [saved, setSaved] = useState(!isNew);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const fill = (s: LibraryStepView) => {
    setStep(s);
    setProjectId(s.projectId);
    setPattern(s.pattern);
    setKind(s.kind);
    setIntent(s.intent);
    setStart(s.startScreenId ?? '');
    setEnd(s.endScreenId ?? '');
    setTags(s.tags.join(', '));
    setText(s.body.map((b) => b.text).join('\n'));
    setSaved(true);
  };
  useEffect(() => {
    if (!isNew) api<LibraryStepView>(`/steps/${id}`).then(fill).catch((e) => setError(e.message));
  }, [id, isNew]);
  useEffect(() => {
    if (!projectId) return;
    api<LibraryStep[]>(`/projects/${projectId}/steps`).then((all) => setOthers(all.filter((o) => o.id !== step?.id)));
    api<Screen[]>(`/projects/${projectId}/screens`).then(setScreens);
  }, [projectId, step?.id]);

  // Starting from recorded steps, guess the screens they start and end on.
  useEffect(() => {
    if (!isNew || !handed || !screens.length) return;
    const hinted = handed.body.map((b) => b.hint?.screenId).filter((x): x is string => !!x && screens.some((s) => s.id === x));
    if (hinted.length) {
      setStart(hinted[0]);
      setEnd(hinted[hinted.length - 1]);
    }
  }, [isNew, handed, screens]);

  const lines = useMemo(() => text.split('\n').filter((l) => l.trim()), [text]);
  const problems = [...(pattern.trim() ? patternProblems(pattern) : []), ...bodyProblems(lines, pattern, others)];
  const used = step ? step.usedBy.scenarios.length + step.usedBy.steps.length : 0;
  const canSave = !!pattern.trim() && lines.length > 0 && problems.length === 0 && !saved;

  /** Keeps the library link (element image) of lines whose text is unchanged. */
  const toBody = (): ScenarioStep[] => {
    const pool = [...(step?.body ?? handed?.body ?? [])];
    return lines.map((l) => {
      const k = pool.findIndex((s) => s.text.trim() === l.trim());
      return { text: l.trim(), hint: k >= 0 ? pool.splice(k, 1)[0].hint : undefined };
    });
  };

  const save = async () => {
    setError('');
    const json = {
      pattern,
      kind,
      intent,
      startScreenId: startScreenId || null,
      endScreenId: endScreenId || null,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      body: toBody(),
    };
    try {
      const s = isNew
        ? await api<LibraryStepView>(`/projects/${projectId}/steps`, { method: 'POST', json })
        : await api<LibraryStepView>(`/steps/${id}`, { method: 'PUT', json });
      fill(s);
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      if (isNew) navigate(`/steps/${s.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await api(`/steps/${id}`, { method: 'DELETE' });
      window.dispatchEvent(new Event(PROJECTS_CHANGED));
      navigate(`/projects/${projectId}/steps`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setSaved(false);
  };

  if (!isNew && !step) return <p>{error || 'Loading…'}</p>;
  return (
    <section className="panel step-editor">
      <div className="panel-head">
        <h2>{isNew ? 'New library step' : 'Library step'}</h2>
        {projectId && <Link to={`/projects/${projectId}/steps`}>← step library</Link>}
      </div>
      {handed?.fromScenario && isNew && (
        <p className="hint">
          Made from {handed.body.length} line{handed.body.length === 1 ? '' : 's'} of <Link to={`/scenarios/${handed.fromScenario.id}`}>{handed.fromScenario.name}</Link>. Replace values
          that change from use to use with a <code>{'{name}'}</code>, and put the same <code>{'{name}'}</code> in the sentence.
        </p>
      )}

      <label className="field">
        <span>Sentence</span>
        <input
          className="step-pattern"
          value={pattern}
          placeholder={'Search for "{term}"'}
          aria-label="Sentence"
          spellCheck={false}
          onChange={(e) => change(setPattern)(e.target.value)}
        />
        <span className="hint">
          How scenarios call it. Values in braces, e.g. <code>{'"{term}"'}</code>, are filled from the scenario line: <code>Search for "shoes"</code>.
        </span>
      </label>

      <div className="field-row">
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => change(setKind)(e.target.value as LibraryStepKind)} aria-label="Kind">
            {STEP_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <span className="hint">{STEP_KINDS.find((k) => k.kind === kind)?.hint}</span>
        </label>
        <label className="field grow">
          <span>Intent</span>
          <input value={intent} placeholder="Find products by name" aria-label="Intent" onChange={(e) => change(setIntent)(e.target.value)} />
          <span className="hint">What it is for, in business words. Agents read this to pick the right step.</span>
        </label>
      </div>

      <div className="field-row">
        <label className="field grow">
          <span>Starts on</span>
          <select value={startScreenId} onChange={(e) => change(setStart)(e.target.value)} aria-label="Starts on">
            <option value="">any screen</option>
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Ends on</span>
          <select value={endScreenId} onChange={(e) => change(setEnd)(e.target.value)} aria-label="Ends on">
            <option value="">same screen</option>
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Tags</span>
          <input value={tags} placeholder="search, smoke" aria-label="Tags" onChange={(e) => change(setTags)(e.target.value)} />
        </label>
      </div>

      <label className="field">
        <span>Steps</span>
        <textarea
          className="scenario-text step-body"
          value={text}
          spellCheck={false}
          aria-label="Steps"
          placeholder={'Click "Search"\nEnter "{term}" in "Search"\nPress "Enter"\nExpect the "Results" screen'}
          onChange={(e) => change(setText)(e.target.value)}
        />
      </label>
      {problems.map((p) => (
        <p key={p} className="error">
          {p}
        </p>
      ))}
      {error && <pre className="error">{error}</pre>}
      <div className="row">
        <button onClick={save} disabled={!canSave}>
          Save
        </button>
        {!saved && <span className="muted small">Unsaved changes</span>}
        {!isNew && used > 0 && !saved && pattern !== step?.pattern && (
          <span className="muted small">
            Saving changes the sentence in the {used} place{used === 1 ? '' : 's'} that use{used === 1 ? 's' : ''} it.
          </span>
        )}
      </div>

      {step && (
        <section className="used-by">
          <h3>Used by</h3>
          {used === 0 ? (
            <p className="muted small">Nothing uses this step yet. Write its sentence in a scenario to use it.</p>
          ) : (
            <ul>
              {step.usedBy.scenarios.map((s) => (
                <li key={s.id}>
                  <Link to={`/scenarios/${s.id}`}>{s.name}</Link> <span className="muted small">scenario</span>
                </li>
              ))}
              {step.usedBy.steps.map((s) => (
                <li key={s.id}>
                  <Link to={`/steps/${s.id}`}>{s.pattern}</Link> <span className="muted small">library step</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step && (
        <section className="setting danger">
          {used > 0 ? (
            <p className="muted small">To delete this step, first remove it from the scenarios and steps above.</p>
          ) : !confirmDelete ? (
            <button className="danger" onClick={() => setConfirmDelete(true)}>
              Delete step…
            </button>
          ) : (
            <div className="confirm">
              <p>
                Delete <strong>{step.pattern}</strong> from the step library?
              </p>
              <div className="row">
                <button className="danger" onClick={remove}>
                  Delete step
                </button>
                <button className="secondary" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

/** The step library tab on the project page. */
export function StepLibrary({ projectId, steps }: { projectId: string; steps: LibraryStepView[] }) {
  const [filter, setFilter] = useState('');
  const shown = steps.filter((s) => `${s.pattern} ${s.intent} ${s.tags.join(' ')} ${s.kind}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="step-library">
      <div className="row">
        <Link className="button secondary" to={`/projects/${projectId}/steps/new`}>
          New step
        </Link>
        {steps.length > 0 && <input placeholder="Filter by words, intent or tag" aria-label="Filter steps" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {steps.length === 0 ? (
        <p className="muted">
          Library steps are reusable sentences in your own words, like <code>Search for "shoes"</code>, made of base steps. Write one here, or select lines in a scenario and
          choose <em>Make reusable step</em>.
        </p>
      ) : (
        <table className="table">
          <tbody>
            {shown.map((s) => {
              const used = s.usedBy.scenarios.length + s.usedBy.steps.length;
              return (
                <tr key={s.id}>
                  <td>
                    <Link to={`/steps/${s.id}`}>
                      <code>{s.pattern}</code>
                    </Link>
                    {s.intent && <div className="muted small">{s.intent}</div>}
                  </td>
                  <td>
                    <span className="badge">{s.kind}</span>
                    {s.tags.map((t) => (
                      <span key={t} className="badge muted">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td className="muted small">{s.body.length} steps</td>
                  <td className="muted small">{used ? `used by ${used}` : 'unused'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
