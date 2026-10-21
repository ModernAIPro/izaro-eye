import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  parseStep,
  UNLABELLED,
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

/** Checks every step against the sentence patterns; returns problems by line. */
function validateSteps(steps: ScenarioStep[]): string[] {
  const problems: string[] = [];
  steps.forEach((s, i) => {
    const p = parseStep(s.text);
    if (!p.ok) problems.push(`Step ${i + 1}: ${p.error}`);
    else if ('target' in p.action && p.action.target === UNLABELLED) problems.push(`Step ${i + 1}: name the element (replace "${UNLABELLED}")`);
  });
  return problems;
}

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
      if (b.name?.trim()) next.name = b.name.trim();
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
    const problems = validateSteps(steps ?? []);
    if (problems.length) return reply.code(400).send({ message: problems.join('\n'), problems });
    const s: Scenario = { id: newId('scn'), projectId: req.params.id, name: name.trim(), steps, createdAt: now(), updatedAt: now() };
    return reply.code(201).send(store.saveScenario(s));
  });
  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (req) => mustScenario(req.params.id));
  app.put<{ Params: { id: string }; Body: { name?: string; steps?: ScenarioStep[] } }>('/api/scenarios/:id', async (req, reply) => {
    const s = mustScenario(req.params.id);
    const steps = req.body.steps ?? s.steps;
    const problems = validateSteps(steps);
    if (problems.length) return reply.code(400).send({ message: problems.join('\n'), problems });
    learnLabels(steps);
    return store.saveScenario({ ...s, name: req.body.name?.trim() || s.name, steps, updatedAt: now() });
  });
  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    store.deleteScenario(req.params.id);
    return reply.code(204).send();
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
    const problems = validateSteps(steps);
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
