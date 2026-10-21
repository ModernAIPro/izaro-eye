import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Project, RecorderServerMessage, Run, StepResult } from '@izaro/shared';
import { buildApp } from '../src/app.js';
import { HeuristicClassifier } from '../src/compare/jev.js';
// @ts-expect-error plain JS example app
import { createServer } from '../../../examples/demo-aut/server.js';

let aut: Server;
let autUrl: string;
let app: FastifyInstance;

const setVariant = (variant: string) => fetch(`${autUrl}/__variant`, { method: 'POST', body: JSON.stringify({ variant }) });

async function waitForRun(id: string): Promise<{ run: Run; results: StepResult[] }> {
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}` });
    const body = res.json();
    if (!['queued', 'running'].includes(body.run.status)) return body;
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  process.env.AUT_USERNAME = 'admin';
  process.env.AUT_PASSWORD = 'admin';
  aut = createServer();
  await new Promise<void>((r) => aut.listen(0, r));
  autUrl = `http://127.0.0.1:${(aut.address() as AddressInfo).port}`;
  app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'izaro-')), classifier: new HeuristicClassifier(), webDist: '/nonexistent' });
});

afterAll(async () => {
  await app?.close();
  aut?.close();
});

describe('record, baseline, rerun', () => {
  it('detects a layout regression on rerun', async () => {
    const project: Project = (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Demo',
          baseUrl: autUrl,
          viewport: { width: 1000, height: 700 },
          auth: {
            loginUrl: '/login',
            usernameSelector: '#username',
            passwordSelector: '#password',
            submitSelector: '[data-testid="login-submit"]',
            username: '{{env:AUT_USERNAME}}',
            password: '{{env:AUT_PASSWORD}}',
            successSelector: '[data-testid="welcome"]',
          },
        },
      })
    ).json();

    // Drive the recorder the way the UI does: forwarded mouse and key events.
    const created = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/recordings`, payload: { startUrl: '/dashboard' } })).json();
    const rec = app.izaro.recorders.get(created.id)!;
    const inspected: RecorderServerMessage[] = [];
    rec.on('message', (m: RecorderServerMessage) => m.type === 'inspected' && inspected.push(m));
    const page = (rec as unknown as { page: import('playwright').Page }).page;
    const centre = async (sel: string) => {
      const b = (await page.locator(sel).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const click = async (sel: string) => {
      const p = await centre(sel);
      await rec.handle({ type: 'mouse', event: 'down', ...p });
      await rec.handle({ type: 'mouse', event: 'up', ...p });
    };
    await click('#item');
    for (const k of 'Widget') {
      await rec.handle({ type: 'key', event: 'down', key: k });
      await rec.handle({ type: 'key', event: 'up', key: k });
    }
    await click('#qty');
    await rec.handle({ type: 'key', event: 'down', key: 'ArrowDown' });
    await rec.handle({ type: 'key', event: 'up', key: 'ArrowDown' });
    await rec.handle({ type: 'key', event: 'down', key: 'Enter' });
    await rec.handle({ type: 'key', event: 'up', key: 'Enter' });
    await click('button:has-text("Place order")');
    await page.waitForSelector('[data-testid="status"]');
    await rec.handle({ type: 'inspect', ...(await centre('[data-testid="status"]')) });
    await expect.poll(() => inspected.length).toBe(1);
    const el = inspected[0].type === 'inspected' ? inspected[0].element : null;
    expect(el?.selectors[0]).toBe('[data-testid="status"]');
    await rec.handle({ type: 'assert', selectors: el!.selectors, assertion: { kind: 'text', op: 'contains', expected: '2 x Widget' } });

    const actions = rec.steps.map((s) => s.action).filter((a) => a !== 'press');
    expect(actions).toEqual(['navigate', 'fill', 'select', 'click', 'assert']);
    expect(rec.steps.find((s) => s.action === 'fill')?.value).toBe('Widget');

    // Saving creates the test case and queues the baseline run.
    const saved = (await app.inject({ method: 'POST', url: `/api/recordings/${created.id}/save`, payload: { name: 'Place order' } })).json();
    const baseline = await waitForRun(saved.run.id);
    expect(baseline.run.status, JSON.stringify(baseline.results)).toBe('passed');
    expect(baseline.results.filter((r) => r.imageKey).length).toBeGreaterThanOrEqual(4);

    // Unchanged app: every screenshot matches.
    const same = (await app.inject({ method: 'POST', url: `/api/tests/${saved.test.id}/runs`, payload: {} })).json();
    const sameResult = await waitForRun(same.id);
    expect(sameResult.run.status, JSON.stringify(sameResult.results)).toBe('passed');
    expect(sameResult.results.every((r) => !r.classification || r.classification.label === 'identical')).toBe(true);

    // Broken layout: rerun is flagged.
    await setVariant('broken');
    const check = (await app.inject({ method: 'POST', url: `/api/tests/${saved.test.id}/runs`, payload: {} })).json();
    const result = await waitForRun(check.id);
    await setVariant('normal');
    expect(['failed', 'review']).toContain(result.run.status);
    const flagged = result.results.filter((r) => r.classification && r.classification.label !== 'identical');
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].diffImageKey).toBeTruthy();

    // Accepting a flagged step updates the baseline for that step.
    const reviewed = (await app.inject({ method: 'POST', url: `/api/results/${flagged[0].id}/review`, payload: { decision: 'accepted' } })).json();
    expect(reviewed.status).toBe('passed');

    const spec = await app.inject({ method: 'GET', url: `/api/tests/${saved.test.id}/spec` });
    expect(spec.body).toContain('process.env.AUT_PASSWORD!');
    expect(spec.body).toContain('toContainText("2 x Widget")');
  });
});
