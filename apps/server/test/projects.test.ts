import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project, Scenario } from '@izaro/shared';
import { buildApp } from '../src/app.js';
import { LocalVision } from '../src/compare/jev.js';

describe('project settings', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'izaro-projects-'));
    app = await buildApp({ dataDir, vision: new LocalVision() });
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const create = async () =>
    (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', baseUrl: 'http://localhost:1' } })).json() as Project;

  it('keeps a project TypeSafe key write-only and uses it for that project only', async () => {
    const p = await create();
    const other = await create();
    const secret = 'apikey_test_1234567890abcd';
    const set = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/typesafe-key`, payload: { key: secret } });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain(secret);
    expect(set.json().typesafeKey).toEqual({ last4: 'abcd' });

    const listed = (await app.inject({ method: 'GET', url: '/api/projects' })).body;
    expect(listed).not.toContain(secret);

    // A project-wide PUT can't smuggle a key into the stored project document.
    const put = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { name: 'Q', typesafeKey: { last4: 'zzzz' } } });
    expect(put.json()).toMatchObject({ name: 'Q', typesafeKey: { last4: 'abcd' } });

    const deps = (app.izaro as unknown as { queue: { deps: { projectVision: (p: Project) => { name: string } | undefined } } }).queue.deps;
    expect(deps.projectVision(p)?.name).toMatch(/jev/);
    expect(deps.projectVision(other)).toBeUndefined();

    expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/typesafe-key`, payload: { key: 'has space' } })).statusCode).toBe(400);
    const cleared = (await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/typesafe-key`, payload: { key: null } })).json();
    expect(cleared.typesafeKey).toBeUndefined();
  });

  it('renames a project and refuses a blank name', async () => {
    const p = await create();
    const renamed = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { name: '  Checkout flow  ' } });
    expect(renamed.json()).toMatchObject({ name: 'Checkout flow', baseUrl: p.baseUrl });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json().name).toBe('Checkout flow');

    expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { name: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json().name).toBe('Checkout flow');
  });

  it('deletes a project with its scenarios', async () => {
    const p = await create();
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/scenarios`, payload: { name: 'S', steps: [{ text: 'Scroll down' }] } })).json() as Scenario;
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/typesafe-key`, payload: { key: 'apikey_another_key_9999' } });
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/scenarios/${s.id}` })).statusCode).toBe(404);
    expect(app.izaro.store.getSecret(p.id, 'typesafe_api_key')).toBeUndefined();
  });
});
