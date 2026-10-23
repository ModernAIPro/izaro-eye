import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  matchLibraryStep,
  parseStep,
  patternProblems,
  renameStepUse,
  stepParams,
  UNLABELLED,
  type LibraryStep,
  type LibraryStepKind,
  type LibraryStepView,
  type LogEntry,
  type Project,
  type RecorderClientMessage,
  type RecorderServerMessage,
  type ReviewDecision,
  type RunEvent,
  type Scenario,
  type ScenarioStep,
  type Screen,
} from '@izaro/shared';
import { crop } from './browser.js';
import { config } from './config.js';
import { defaultVision, JevVision, type Vision } from './compare/jev.js';
import { newId, now } from './ids.js';
import { summarizeInsights } from './ai-summary.js';
import { computeInsights } from './insights.js';
import { Library } from './library.js';
import { RecorderRegistry } from './recorder/session.js';
import { RunQueue, runEvents, videoPath } from './runner/executor.js';
import { Store } from './store/db.js';
import { ImageStore } from './store/images.js';

export interface AppOptions {
  dataDir?: string;
  vision?: Vision;
  webDist?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    izaro: { store: Store; images: ImageStore; library: Library; queue: RunQueue; recorders: RecorderRegistry; vision: Vision };
  }
}

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const TYPESAFE_KEY = 'typesafe_api_key';
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });

/** Checks every step against the sentence patterns and the project's step library; returns problems by line. */
function validateSteps(steps: ScenarioStep[], library: LibraryStep[] = [], allowParams = false): string[] {
  const problems: string[] = [];
  steps.forEach((s, i) => {
    // `{name}` belongs in a library step's body; a scenario passes real values.
    const param = !allowParams && stepParams(s.text)[0];
    if (param) return problems.push(`Step ${i + 1}: replace {${param}} with a value`);
    const p = parseStep(s.text);
    if (!p.ok) {
      if (!matchLibraryStep(s.text, library)) problems.push(`Step ${i + 1}: ${p.error}`);
    } else if ('target' in p.action && p.action.target === UNLABELLED) problems.push(`Step ${i + 1}: name the element (replace "${UNLABELLED}")`);
  });
  return problems;
}

const STEP_KINDS: LibraryStepKind[] = ['action', 'flow', 'check'];

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const dataDir = opts.dataDir ?? config.dataDir;
  const store = new Store(dataDir);
  const images = new ImageStore(path.join(dataDir, 'images'));
  const vision = opts.vision ?? defaultVision();
  const library = new Library(store, images, vision);
  const videoDir = path.join(dataDir, 'videos');
  // A project can bring its own TypeSafe key; otherwise everything uses the server's (TYPESAFE_API_KEY).
  const projectClients = new Map<string, Vision>();
  const projectVision = (p: Project): Vision | undefined => {
    const key = store.getSecret(p.id, TYPESAFE_KEY);
    if (!key) return undefined;
    let v = projectClients.get(key);
    if (!v) projectClients.set(key, (v = new JevVision({ ...config.typesafe, apiKey: key })));
    return v;
  };
  const deps = { store, images, vision, library, videoDir, projectVision };
  const queue = new RunQueue(deps);
  const recorders = new RecorderRegistry(deps);

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.decorate('izaro', { store, images, library, queue, recorders, vision });
  await app.register(websocket);
  app.addHook('onClose', async () => {
    await recorders.closeAll();
    store.close();
  });

  const mustProject = (id: string) => store.getProject(id) ?? (() => { throw notFound('Project'); })();
  const mustScenario = (id: string) => store.getScenario(id) ?? (() => { throw notFound('Scenario'); })();
  const mustScreen = (id: string) => store.getScreen(id) ?? (() => { throw notFound('Screen'); })();

  /** Saves labels typed into recorded steps back onto the library elements. */
  const learnLabels = (steps: ScenarioStep[]) => {
    for (const s of steps) {
      const p = parseStep(s.text);
      if (p.ok && 'target' in p.action && s.hint?.elementId && p.action.target !== UNLABELLED) {
        library.setElementLabel(s.hint.screenId, s.hint.elementId, p.action.target);
      }
    }
  };

  app.get('/api/health', async () => ({ ok: true, vision: vision.name }));

  // ---- Projects ----
  /** What the UI sees of a project: never the key itself, only whether one is set and its last 4 characters. */
  const view = (p: Project): Project => {
    const key = store.getSecret(p.id, TYPESAFE_KEY);
    return key ? { ...p, typesafeKey: { last4: key.slice(-4) } } : p;
  };
  app.get('/api/projects', async () => store.listProjects().map(view));
  app.post<{ Body: Omit<Project, 'id' | 'createdAt'> }>('/api/projects', async (req, reply) => {
    const b = req.body;
    if (!b?.name || !b.baseUrl) throw badRequest('name and baseUrl are required');
    const project: Project = {
      id: newId('proj'),
      name: b.name,
      baseUrl: b.baseUrl,
      viewport: b.viewport ?? { width: 1280, height: 800 },
      createdAt: now(),
    };
    return reply.code(201).send(store.saveProject(project));
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => view(mustProject(req.params.id)));
  app.put<{ Params: { id: string }; Body: { name?: string; baseUrl?: string; viewport?: Project['viewport']; setupScenarioId?: string | null } }>(
    '/api/projects/:id',
    async (req) => {
      const p = mustProject(req.params.id);
      const b = req.body ?? {};
      const next: Project = { ...p };
      if (b.name !== undefined) {
        if (!b.name?.trim()) throw badRequest('name cannot be empty');
        next.name = b.name.trim();
      }
      if (b.baseUrl?.trim()) next.baseUrl = b.baseUrl.trim();
      if (b.viewport) next.viewport = b.viewport;
      // null or '' clears it (JSON has no undefined).
      if (b.setupScenarioId) next.setupScenarioId = mustScenario(b.setupScenarioId).id;
      else if (b.setupScenarioId === null || b.setupScenarioId === '') delete next.setupScenarioId;
      delete next.typesafeKey;
      return view(store.saveProject(next));
    },
  );
  // The key is write-only: it is stored server-side and never returned or logged.
  app.put<{ Params: { id: string }; Body: { key?: string | null } }>('/api/projects/:id/typesafe-key', async (req) => {
    const p = mustProject(req.params.id);
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (key && (key.length < 8 || key.length > 512 || /\s/.test(key))) throw badRequest('That does not look like a TypeSafe API key');
    store.setSecret(p.id, TYPESAFE_KEY, key || undefined);
    return view(p);
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = mustProject(req.params.id);
    await recorders.closeProject(p.id);
    const runIds = store.deleteProject(p.id);
    await Promise.all(runIds.map((id) => fs.promises.rm(videoPath(videoDir, id), { force: true })));
    return reply.code(204).send();
  });

  // ---- Screen library ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/screens', async (req) => store.listScreens(req.params.id));
  app.get<{ Params: { id: string } }>('/api/screens/:id', async (req) => mustScreen(req.params.id));
  app.put<{ Params: { id: string }; Body: { name?: string; elements?: { id: string; label: string }[] } }>('/api/screens/:id', async (req) => {
    const s = mustScreen(req.params.id);
    const labels = new Map((req.body.elements ?? []).map((e) => [e.id, e.label]));
    const next: Screen = {
      ...s,
      name: req.body.name?.trim() || s.name,
      elements: s.elements.map((e) => ({ ...e, label: labels.get(e.id)?.trim() || e.label })),
      updatedAt: now(),
    };
    return store.saveScreen(next);
  });
  app.delete<{ Params: { id: string } }>('/api/screens/:id', async (req, reply) => {
    store.deleteScreen(req.params.id);
    return reply.code(204).send();
  });

  // ---- Scenarios ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/scenarios', async (req) => store.listScenarios(req.params.id));
  app.post<{ Params: { id: string }; Body: { name: string; steps: ScenarioStep[] } }>('/api/projects/:id/scenarios', async (req, reply) => {
    mustProject(req.params.id);
    const { name, steps } = req.body ?? {};
    if (!name?.trim()) throw badRequest('name is required');
    const problems = validateSteps(steps ?? [], store.listSteps(req.params.id));
    if (problems.length) return reply.code(400).send({ message: problems.join('\n'), problems });
    const s: Scenario = { id: newId('scn'), projectId: req.params.id, name: name.trim(), steps, createdAt: now(), updatedAt: now() };
    return reply.code(201).send(store.saveScenario(s));
  });
  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (req) => mustScenario(req.params.id));
  app.put<{ Params: { id: string }; Body: { name?: string; steps?: ScenarioStep[] } }>('/api/scenarios/:id', async (req, reply) => {
    const s = mustScenario(req.params.id);
    const steps = req.body.steps ?? s.steps;
    const problems = validateSteps(steps, store.listSteps(s.projectId));
    if (problems.length) return reply.code(400).send({ message: problems.join('\n'), problems });
    learnLabels(steps);
    return store.saveScenario({ ...s, name: req.body.name?.trim() || s.name, steps, updatedAt: now() });
  });
  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    store.deleteScenario(req.params.id);
    return reply.code(204).send();
  });

  // ---- Step library ----
  const mustStep = (id: string) => store.getStep(id) ?? (() => { throw notFound('Step'); })();
  const usesStep = (text: string, step: LibraryStep, library: LibraryStep[]) => !parseStep(text).ok && matchLibraryStep(text, library)?.step.id === step.id;
  const stepView = (step: LibraryStep, library = store.listSteps(step.projectId)): LibraryStepView => ({
    ...step,
    usedBy: {
      scenarios: store
        .listScenarios(step.projectId)
        .filter((sc) => sc.steps.some((st) => usesStep(st.text, step, library)))
        .map(({ id, name }) => ({ id, name })),
      steps: library.filter((o) => o.id !== step.id && o.body.some((b) => usesStep(b.text, step, library))).map(({ id, pattern }) => ({ id, pattern })),
    },
  });
  type StepBody = Partial<Pick<LibraryStep, 'pattern' | 'kind' | 'intent' | 'startScreenId' | 'endScreenId' | 'body' | 'tags'>>;
  /** Builds the step from a request and checks it; `others` are the project's other library steps. */
  const checkStep = (base: LibraryStep, b: StepBody, others: LibraryStep[]): LibraryStep => {
    const next: LibraryStep = { ...base };
    if (b.pattern !== undefined) next.pattern = b.pattern.trim().replace(/\s+/g, ' ');
    if (b.kind !== undefined) next.kind = b.kind;
    if (b.intent !== undefined) next.intent = b.intent.trim();
    if (b.body !== undefined) next.body = (b.body ?? []).filter((x) => x.text?.trim()).map(({ text, hint }) => ({ text: text.trim(), hint }));
    if (b.tags !== undefined) next.tags = [...new Set((b.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    for (const k of ['startScreenId', 'endScreenId'] as const) {
      if (b[k] === undefined) continue;
      if (b[k]) next[k] = mustScreen(b[k]).id;
      else delete next[k];
    }
    const problems = patternProblems(next.pattern);
    if (!STEP_KINDS.includes(next.kind)) problems.push(`kind must be one of ${STEP_KINDS.join(', ')}`);
    const key = (p: string) => p.toLowerCase().replace(/\{[^}]*\}/g, '{}');
    if (others.some((o) => key(o.pattern) === key(next.pattern))) problems.push('Another library step already has that sentence');
    if (!next.body.length) problems.push('Add at least one step to the body');
    problems.push(...validateSteps(next.body, others, true));
    const params = new Set(stepParams(next.pattern));
    for (const [i, line] of next.body.entries()) {
      for (const n of stepParams(line.text)) if (!params.has(n)) problems.push(`Step ${i + 1}: {${n}} isn't in the sentence`);
    }
    // A step must not end up using itself, directly or through other steps.
    const all = [...others, next];
    const reaches = (st: LibraryStep, seen: Set<string>): boolean =>
      st.body.some((b) => {
        const m = parseStep(b.text).ok ? undefined : matchLibraryStep(b.text, all);
        if (!m) return false;
        if (m.step.id === next.id) return true;
        if (seen.has(m.step.id)) return false;
        seen.add(m.step.id);
        return reaches(m.step, seen);
      });
    if (reaches(next, new Set())) problems.push('The body uses this step itself, directly or through another step');
    if (problems.length) throw Object.assign(new Error(problems.join('\n')), { statusCode: 400, problems });
    return next;
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/steps', async (req) => {
    const library = store.listSteps(req.params.id);
    return library.map((s) => stepView(s, library));
  });
  app.post<{ Params: { id: string }; Body: StepBody }>('/api/projects/:id/steps', async (req, reply) => {
    const p = mustProject(req.params.id);
    const others = store.listSteps(p.id);
    const blank: LibraryStep = { id: newId('stp'), projectId: p.id, pattern: '', kind: 'action', intent: '', body: [], tags: [], createdAt: now(), updatedAt: now() };
    const step = checkStep(blank, req.body ?? {}, others);
    learnLabels(step.body);
    return reply.code(201).send(stepView(store.saveStep(step)));
  });
  app.get<{ Params: { id: string } }>('/api/steps/:id', async (req) => stepView(mustStep(req.params.id)));
  /** A changed sentence is carried into every scenario and step that uses it, as long as its {values} stay the same. */
  app.put<{ Params: { id: string }; Body: StepBody }>('/api/steps/:id', async (req) => {
    const old = mustStep(req.params.id);
    const library = store.listSteps(old.projectId);
    const next = checkStep(old, req.body ?? {}, library.filter((o) => o.id !== old.id));
    const renamed = next.pattern !== old.pattern;
    const used = stepView(old, library).usedBy;
    if (renamed && (used.scenarios.length || used.steps.length) && stepParams(next.pattern).join() !== stepParams(old.pattern).join()) {
      throw badRequest(`Keep the same {values} in the same order while the step is in use (${[...used.scenarios.map((s) => s.name), ...used.steps.map((s) => s.pattern)].join(', ')})`);
    }
    const saved = store.saveStep({ ...next, updatedAt: now() });
    learnLabels(saved.body);
    if (renamed) {
      const rewrite = (lines: ScenarioStep[]) =>
        lines.map((l) => (usesStep(l.text, old, library) ? { ...l, text: renameStepUse(l.text, old.pattern, next.pattern) ?? l.text } : l));
      for (const { id } of used.scenarios) {
        const sc = store.getScenario(id)!;
        store.saveScenario({ ...sc, steps: rewrite(sc.steps), updatedAt: now() });
      }
      for (const { id } of used.steps) {
        const st = store.getStep(id)!;
        store.saveStep({ ...st, body: rewrite(st.body), updatedAt: now() });
      }
    }
    return stepView(saved);
  });
  app.delete<{ Params: { id: string } }>('/api/steps/:id', async (req, reply) => {
    const { usedBy } = stepView(mustStep(req.params.id));
    const users = [...usedBy.scenarios.map((s) => `"${s.name}"`), ...usedBy.steps.map((s) => s.pattern)];
    if (users.length) return reply.code(409).send({ message: `Still used by ${users.join(', ')}` });
    store.deleteStep(req.params.id);
    return reply.code(204).send();
  });

  // ---- Insights ----
  const insightsFor = (projectId: string) => {
    const scenarios = store.listScenarios(projectId);
    const runs = new Map(scenarios.map((s) => [s.id, store.listRuns(s.id)]));
    const results = new Map(
      scenarios.map((s) => {
        const last = runs.get(s.id)!.find((r) => r.status !== 'queued' && r.status !== 'running');
        return [s.id, last ? store.listResults(last.id) : []];
      }),
    );
    return computeInsights({ scenarios, runs, results, aiAvailable: !!config.claude.apiKey });
  };
  app.get<{ Params: { id: string } }>('/api/projects/:id/insights', async (req) => insightsFor(mustProject(req.params.id).id));
  app.post<{ Params: { id: string } }>('/api/projects/:id/insights/summary', async (req) => {
    const p = mustProject(req.params.id);
    const insights = insightsFor(p.id);
    if (!insights.aiAvailable) throw notFound('AI summary (optional; off without ANTHROPIC_API_KEY)');
    try {
      return { summary: await summarizeInsights(p.name, insights) };
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'AI summary failed');
      throw Object.assign(new Error(`The AI summary failed: ${(e as Error).message}`), { statusCode: 502 });
    }
  });

  // ---- Runs ----
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/runs', async (req, reply) => reply.code(202).send(queue.enqueue(mustScenario(req.params.id))));
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/runs', async (req) => store.listRuns(req.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound('Run');
    return { run, results: store.listResults(run.id) };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const send = (e: RunEvent) => socket.send(JSON.stringify(e));
    const onUpdate = (runId: string) => {
      const run = store.getRun(id);
      if (runId === id && run) send({ type: 'state', run, results: store.listResults(id) });
    };
    const onLog = (runId: string, entry: LogEntry) => runId === id && send({ type: 'log', entry });
    const onFrame = (runId: string, f: { data: string; width: number; height: number }) => runId === id && send({ type: 'frame', ...f });
    runEvents.on('update', onUpdate);
    runEvents.on('log', onLog);
    runEvents.on('frame', onFrame);
    socket.on('close', () => {
      runEvents.off('update', onUpdate);
      runEvents.off('log', onLog);
      runEvents.off('frame', onFrame);
    });
    onUpdate(id);
    send({ type: 'logs', entries: store.listLogs(id) });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/logs', async (req) => store.listLogs(req.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id/video', async (req, reply) => {
    if (!/^run_[0-9a-f]+$/.test(req.params.id)) throw notFound('Video');
    const file = videoPath(videoDir, req.params.id);
    if (!fs.existsSync(file)) throw notFound('Video');
    return reply.header('content-type', 'video/webm').send(fs.createReadStream(file));
  });

  /**
   * Accepting a result teaches the library: an expected screen takes the new
   * screenshot, and an element jev-img had to search for takes the image it found.
   */
  app.post<{ Params: { id: string }; Body: { decision: ReviewDecision } }>('/api/results/:id/review', async (req) => {
    const r = store.getResult(req.params.id);
    if (!r) throw notFound('Result');
    const decision = req.body?.decision;
    if (decision !== 'accepted' && decision !== 'bug') throw badRequest('decision must be accepted or bug');
    if (decision === 'accepted' && r.imageKey) {
      if (r.screenId) {
        const s = store.getScreen(r.screenId);
        if (s) store.saveScreen({ ...s, imageKey: r.imageKey, updatedAt: now() });
      }
      if (r.found?.method === 'jev-img' && r.elementId) {
        const s = store.listScreens(store.getScenario(store.getRun(r.runId)!.scenarioId)!.projectId).find((x) => x.elements.some((e) => e.id === r.elementId));
        const before = r.found;
        if (s) {
          // The result image is taken after acting; good enough for a library crop of a static control.
          const cropKey = await images.put(await crop(await images.get(r.imageKey), before.rect));
          store.saveScreen({ ...s, elements: s.elements.map((e) => (e.id === r.elementId ? { ...e, rect: before.rect, cropKey } : e)), updatedAt: now() });
        }
      }
    }
    const saved = store.saveResult({ ...r, decision, status: decision === 'accepted' ? 'passed' : 'failed' });
    runEvents.emit('update', r.runId);
    return saved;
  });

  app.get<{ Params: { '*': string } }>('/api/images/*', async (req, reply) => {
    try {
      return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=31536000, immutable').send(await images.get(req.params['*']));
    } catch {
      throw notFound('Image');
    }
  });

  // ---- Recorder ----
  app.post<{ Params: { id: string }; Body: { startUrl?: string; startAfter?: string } }>('/api/projects/:id/recordings', async (req, reply) => {
    const p = mustProject(req.params.id);
    const after = req.body?.startAfter ? mustScenario(req.body.startAfter) : undefined;
    if (after && after.projectId !== p.id) throw notFound('Scenario');
    const s = await recorders.create(p, req.body?.startUrl || undefined, after?.id);
    return reply.code(201).send({ id: s.id, viewport: p.viewport, steps: s.steps, notice: s.notice });
  });
  app.get<{ Params: { id: string } }>('/api/recordings/:id/ws', { websocket: true }, (socket, req) => {
    const s = recorders.get(req.params.id);
    if (!s) {
      socket.send(JSON.stringify({ type: 'error', message: 'Recording not found' } satisfies RecorderServerMessage));
      socket.close();
      return;
    }
    const forward = (m: RecorderServerMessage) => socket.send(JSON.stringify(m));
    s.on('message', forward);
    socket.on('close', () => s.off('message', forward));
    socket.on('message', (raw: Buffer) => {
      let msg: RecorderClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      s.handle(msg).catch((e) => forward({ type: 'error', message: (e as Error).message }));
    });
    forward({ type: 'steps', steps: s.steps });
  });
  app.post<{ Params: { id: string }; Body: { name: string; steps?: ScenarioStep[] } }>('/api/recordings/:id/save', async (req, reply) => {
    const s = recorders.get(req.params.id);
    if (!s) throw notFound('Recording');
    if (!req.body?.name?.trim()) throw badRequest('name is required');
    const steps = (req.body.steps ?? s.steps).map(({ text, hint }) => ({ text, hint }));
    const problems = validateSteps(steps, store.listSteps(s.project.id));
    if (problems.length) return reply.code(400).send({ message: problems.join('\n'), problems });
    learnLabels(steps);
    const scenario: Scenario = { id: newId('scn'), projectId: s.project.id, name: req.body.name.trim(), steps, createdAt: now(), updatedAt: now() };
    store.saveScenario(scenario);
    await recorders.close(s.id);
    return reply.code(201).send(scenario);
  });
  app.delete<{ Params: { id: string } }>('/api/recordings/:id', async (req, reply) => {
    await recorders.close(req.params.id);
    return reply.code(204).send();
  });

  // Serve the built web UI when present.
  const webDist = opts.webDist ?? path.resolve(import.meta.dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ message: 'Not found' }) : reply.sendFile('index.html')));
  }

  return app;
}
