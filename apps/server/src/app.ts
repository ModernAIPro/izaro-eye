import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { Project, RecorderClientMessage, RecorderServerMessage, ReviewDecision, Step, TestCase } from '@izaro/shared';
import { toPlaywrightSpec } from './codegen.js';
import { config } from './config.js';
import { defaultClassifier, type ImageClassifier } from './compare/jev.js';
import { newId, now } from './ids.js';
import { RecorderRegistry } from './recorder/session.js';
import { RunQueue, runEvents } from './runner/replay.js';
import { Store } from './store/db.js';
import { ImageStore } from './store/images.js';

export interface AppOptions {
  dataDir?: string;
  classifier?: ImageClassifier;
  webDist?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    izaro: { store: Store; images: ImageStore; queue: RunQueue; recorders: RecorderRegistry };
  }
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const dataDir = opts.dataDir ?? config.dataDir;
  const store = new Store(dataDir);
  const images = new ImageStore(path.join(dataDir, 'images'));
  const classifier = opts.classifier ?? defaultClassifier();
  const queue = new RunQueue({ store, images, classifier });
  const recorders = new RecorderRegistry();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.decorate('izaro', { store, images, queue, recorders });
  await app.register(websocket);
  app.addHook('onClose', async () => {
    await recorders.closeAll();
    store.close();
  });

  const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });
  const mustProject = (id: string) => store.getProject(id) ?? (() => { throw notFound('Project'); })();
  const mustTest = (id: string) => store.getTest(id) ?? (() => { throw notFound('Test'); })();

  app.get('/api/health', async () => ({ ok: true, classifier: classifier.name }));

  // ---- Projects ----
  app.get('/api/projects', async () => store.listProjects());
  app.post<{ Body: Omit<Project, 'id' | 'createdAt'> }>('/api/projects', async (req, reply) => {
    const b = req.body;
    if (!b?.name || !b.baseUrl) return reply.code(400).send({ message: 'name and baseUrl are required' });
    const project: Project = {
      id: newId('proj'),
      name: b.name,
      baseUrl: b.baseUrl,
      viewport: b.viewport ?? { width: 1280, height: 800 },
      auth: b.auth,
      createdAt: now(),
    };
    return reply.code(201).send(store.saveProject(project));
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => mustProject(req.params.id));
  app.put<{ Params: { id: string }; Body: Partial<Project> }>('/api/projects/:id', async (req) => {
    const p = mustProject(req.params.id);
    return store.saveProject({ ...p, ...req.body, id: p.id, createdAt: p.createdAt });
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    store.deleteProject(req.params.id);
    return reply.code(204).send();
  });

  // ---- Tests ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/tests', async (req) => store.listTests(req.params.id));
  app.get<{ Params: { id: string } }>('/api/tests/:id', async (req) => mustTest(req.params.id));
  app.put<{ Params: { id: string }; Body: { name?: string; steps?: Step[] } }>('/api/tests/:id', async (req) => {
    const t = mustTest(req.params.id);
    return store.saveTest({ ...t, name: req.body.name ?? t.name, steps: req.body.steps ?? t.steps, updatedAt: now() });
  });
  app.delete<{ Params: { id: string } }>('/api/tests/:id', async (req, reply) => {
    store.deleteTest(req.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/tests/:id/spec', async (req, reply) => {
    const t = mustTest(req.params.id);
    const spec = toPlaywrightSpec(mustProject(t.projectId), t);
    const file = t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'test';
    return reply.header('content-type', 'text/plain').header('content-disposition', `attachment; filename="${file}.spec.ts"`).send(spec);
  });

  // ---- Runs ----
  app.post<{ Params: { id: string }; Body: { mode?: 'baseline' | 'check' } }>('/api/tests/:id/runs', async (req, reply) => {
    const t = mustTest(req.params.id);
    const mode = req.body?.mode ?? (t.baselineId ? 'check' : 'baseline');
    try {
      return reply.code(202).send(queue.enqueue(t, mode));
    } catch (e) {
      return reply.code(409).send({ message: (e as Error).message });
    }
  });
  app.get<{ Params: { id: string } }>('/api/tests/:id/runs', async (req) => store.listRuns(req.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run) throw notFound('Run');
    return { run, results: store.listResults(run.id) };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const send = (runId: string) => {
      if (runId !== id) return;
      const run = store.getRun(id);
      socket.send(JSON.stringify({ run, results: store.listResults(id) }));
    };
    runEvents.on('update', send);
    socket.on('close', () => runEvents.off('update', send));
    send(id);
  });

  // Review: accept the rerun image as the new baseline for that step, or mark it a bug.
  app.post<{ Params: { id: string }; Body: { decision: ReviewDecision } }>('/api/results/:id/review', async (req, reply) => {
    const r = store.getResult(req.params.id);
    if (!r) throw notFound('Result');
    const decision = req.body?.decision;
    if (decision !== 'accepted' && decision !== 'bug') return reply.code(400).send({ message: 'decision must be accepted or bug' });
    if (decision === 'accepted') {
      const run = store.getRun(r.runId)!;
      const test = mustTest(run.testId);
      if (!test.baselineId || !r.imageKey) return reply.code(409).send({ message: 'Nothing to accept' });
      store.setBaselineImage(test.baselineId, r.stepId, r.imageKey);
    }
    return store.saveResult({ ...r, decision, status: decision === 'accepted' ? 'passed' : 'failed' });
  });

  app.get<{ Params: { '*': string } }>('/api/images/*', async (req, reply) => {
    try {
      return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=31536000, immutable').send(await images.get(req.params['*']));
    } catch {
      throw notFound('Image');
    }
  });

  // ---- Recorder ----
  app.post<{ Params: { id: string }; Body: { startUrl?: string } }>('/api/projects/:id/recordings', async (req, reply) => {
    const p = mustProject(req.params.id);
    const s = await recorders.create(p, req.body?.startUrl || p.baseUrl);
    return reply.code(201).send({ id: s.id, viewport: p.viewport, steps: s.steps });
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
  app.post<{ Params: { id: string }; Body: { name: string; createBaseline?: boolean } }>('/api/recordings/:id/save', async (req, reply) => {
    const s = recorders.get(req.params.id);
    if (!s) throw notFound('Recording');
    if (!req.body?.name) return reply.code(400).send({ message: 'name is required' });
    const test: TestCase = {
      id: newId('test'),
      projectId: s.project.id,
      name: req.body.name,
      steps: s.steps,
      createdAt: now(),
      updatedAt: now(),
    };
    store.saveTest(test);
    await recorders.close(s.id);
    const run = req.body.createBaseline === false ? undefined : queue.enqueue(test, 'baseline');
    return reply.code(201).send({ test, run });
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
