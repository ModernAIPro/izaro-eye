import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chromium, type Page } from 'playwright';
import type { Project, RecorderStep, Region, Run, Scenario, StepResult } from '@izaro/shared';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { LocalVision, type FindAnswer, type FindQuery } from '../src/compare/jev.js';
import type { RecorderSession } from '../src/recorder/session.js';
// @ts-expect-error plain JS example app
import { createServer } from '../../../examples/demo-aut/server.js';

const viewport = { width: 1000, height: 700 };

/**
 * Stands in for jev-img. Real jev-img reads screenshots; this fake answers
 * from boxes the test measured on the demo app, so the test is about
 * izaro-eye's behaviour, not Jev's accuracy.
 */
class FakeJev extends LocalVision {
  readonly name = 'fake-jev';
  controls = new Map<string, Region>();
  texts = new Set<string>();
  finds: string[] = [];
  async findElement(_s: Buffer, q: FindQuery): Promise<FindAnswer> {
    this.finds.push(q.label);
    const box = this.controls.get(q.label);
    return box ? { present: 0.95, box } : { present: 0.05 };
  }
  async seesText(_s: Buffer, text: string) {
    return this.texts.has(text) ? 0.95 : 0.05;
  }
  async elementAt(_s: Buffer, p: { x: number; y: number }) {
    for (const box of this.controls.values()) {
      if (p.x >= box.left * viewport.width && p.x <= box.right * viewport.width && p.y >= box.top * viewport.height && p.y <= box.bottom * viewport.height) return box;
    }
    return null;
  }
}

const SELECTORS: Record<string, string> = {
  Username: '#username',
  Password: '#password',
  'Sign in': '[data-testid="login-submit"]',
  Item: '#item',
  'Place order': 'button:has-text("Place order")',
};

let aut: Server;
let autUrl: string;
let app: FastifyInstance;
const jev = new FakeJev();

const setVariant = (variant: string) => fetch(`${autUrl}/__variant`, { method: 'POST', body: JSON.stringify({ variant }) });

/** Measures the demo app's controls (test-only use of the DOM) for the fake. */
async function measure() {
  const browser = await chromium.launch({ executablePath: config.chromiumPath });
  const page = await browser.newPage({ viewport });
  const grab = async (labels: string[]) => {
    for (const label of labels) {
      const b = (await page.locator(SELECTORS[label]).boundingBox())!;
      jev.controls.set(label, { left: b.x / viewport.width, right: (b.x + b.width) / viewport.width, top: b.y / viewport.height, bottom: (b.y + b.height) / viewport.height });
    }
  };
  await page.goto(`${autUrl}/login`);
  await grab(['Username', 'Password', 'Sign in']);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL(/dashboard/);
  await grab(['Item', 'Place order']);
  await browser.close();
}

async function waitForRun(id: string): Promise<{ run: Run; results: StepResult[] }> {
  for (;;) {
    const body = (await app.inject({ method: 'GET', url: `/api/runs/${id}` })).json();
    if (!['queued', 'running'].includes(body.run.status)) return body;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function run(scenario: Scenario) {
  const r = (await app.inject({ method: 'POST', url: `/api/scenarios/${scenario.id}/runs` })).json();
  return waitForRun(r.id);
}

function centre(label: string) {
  const b = jev.controls.get(label)!;
  return { x: ((b.left + b.right) / 2) * viewport.width, y: ((b.top + b.bottom) / 2) * viewport.height };
}

async function click(rec: RecorderSession, label: string) {
  const p = centre(label);
  await rec.handle({ type: 'mouse', event: 'down', ...p });
  await rec.handle({ type: 'mouse', event: 'up', ...p });
}

async function type(rec: RecorderSession, text: string) {
  for (const k of text) {
    await rec.handle({ type: 'key', event: 'down', key: k });
    await rec.handle({ type: 'key', event: 'up', key: k });
  }
}

/** What a user does in the recorder: names each "?" element in click order. */
function nameElements(steps: RecorderStep[], names: string[]): RecorderStep[] {
  const queue = [...names];
  return steps.map((s) => (s.text.includes('"?"') ? { ...s, text: s.text.replace('"?"', `"${queue.shift()}"`) } : s));
}

beforeAll(async () => {
  process.env.AUT_PASSWORD = 'admin';
  aut = createServer();
  await new Promise<void>((r) => aut.listen(0, r));
  autUrl = `http://127.0.0.1:${(aut.address() as AddressInfo).port}`;
  await measure();
  app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'izaro-')), vision: jev, webDist: '/nonexistent' });
});

afterAll(async () => {
  await setVariant('normal');
  await app?.close();
  aut?.close();
});

describe('screen library and scenarios', () => {
  let project: Project;
  let signIn: Scenario;
  let order: Scenario;

  it('records sign-in as a scenario and builds the screen library', async () => {
    project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Demo', baseUrl: autUrl, viewport } })).json();
    const created = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/recordings`, payload: {} })).json();
    const rec = app.izaro.recorders.get(created.id)!;

    await click(rec, 'Username');
    await type(rec, 'admin');
    await click(rec, 'Password');
    await rec.handle({ type: 'secret', name: 'AUT_PASSWORD' });
    await click(rec, 'Sign in');

    expect(rec.steps.map((s) => s.text)).toEqual([
      'Expect the "Login" screen',
      'Enter "admin" in "?"',
      'Enter "{{secret:AUT_PASSWORD}}" in "?"',
      'Click "?"',
      'Expect the "Dashboard" screen',
    ]);
    expect(rec.steps[3].cropKey).toBeTruthy();

    // Saving with unnamed elements is refused.
    const refused = await app.inject({ method: 'POST', url: `/api/recordings/${created.id}/save`, payload: { name: 'Sign in' } });
    expect(refused.statusCode).toBe(400);

    const steps = nameElements(rec.steps, ['Username', 'Password', 'Sign in']);
    signIn = (await app.inject({ method: 'POST', url: `/api/recordings/${created.id}/save`, payload: { name: 'Sign in', steps } })).json();
    expect(signIn.steps[2].text).toBe('Enter "{{secret:AUT_PASSWORD}}" in "Password"');

    const screens = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/screens` })).json();
    expect(screens.map((s: { name: string }) => s.name)).toEqual(['Login', 'Dashboard']);
    expect(screens[0].elements.map((e: { label: string }) => e.label)).toEqual(['Username', 'Password', 'Sign in']);
    expect(screens[0].next).toHaveLength(1);
  });

  it('records after a chosen scenario, and reruns visually', async () => {
    project = (await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: { setupScenarioId: signIn.id } })).json();
    // The setup scenario is for runs; recording starts from the address unless told otherwise.
    const plain = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/recordings`, payload: {} })).json();
    expect(app.izaro.recorders.get(plain.id)!.steps.map((s) => s.text)).toEqual(['Expect the "Login" screen']);
    await app.inject({ method: 'DELETE', url: `/api/recordings/${plain.id}` });

    const created = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/recordings`, payload: { startAfter: signIn.id } })).json();
    const rec = app.izaro.recorders.get(created.id)!;
    expect(rec.steps.map((s) => s.text)).toEqual(['Run "Sign in"', 'Expect the "Dashboard" screen']);

    await click(rec, 'Item');
    await type(rec, 'Widget');
    await click(rec, 'Place order');
    await rec.handle({ type: 'expectText', text: 'Order placed: 1 x Widget' });
    const steps = nameElements(rec.steps, ['Item', 'Place order']);
    order = (await app.inject({ method: 'POST', url: `/api/recordings/${created.id}/save`, payload: { name: 'Place an order', steps } })).json();
    expect(order.steps.map((s) => s.text)).toContain('Enter "Widget" in "Item"');

    // Unchanged app: every element matches its library image, so jev-img is never asked where things are.
    jev.texts.add('Order placed: 1 x Widget');
    jev.finds.length = 0;
    const same = await run(order);
    expect(same.run.status, `${same.run.error} ${JSON.stringify(same.results, null, 1)}`).toBe("passed");
    expect(jev.finds).toEqual([]);
    expect(same.results.filter((r) => r.found).every((r) => r.found!.method === 'exact-match')).toBe(true);
    expect(same.results[0].from).toBe('Sign in');
  });

  it('finds moved elements with jev-img and flags the changed screen', async () => {
    await setVariant('broken');
    const before = new Map(jev.controls);
    try {
      await measureBroken();
      const r = await run(order);
      const moved = r.results.find((x) => x.text === 'Click "Place order"')!;
      expect(moved.found?.method).toBe('jev-img');
      expect(moved.status).toBe('passed');
      const expectScreen = r.results.find((x) => x.text === 'Expect the "Dashboard" screen' && !x.from)!;
      expect(['failed', 'review']).toContain(expectScreen.status);
      expect(expectScreen.diffImageKey).toBeTruthy();
      expect(r.run.status).not.toBe('passed');

      // The run log has the jev-img question, the browser's navigation and the runner's steps.
      const logs = (await app.inject({ method: 'GET', url: `/api/runs/${r.run.id}/logs` })).json() as { source: string; message: string }[];
      expect(logs.some((l) => l.source === 'typesafe' && l.message.startsWith('find "Place order"'))).toBe(true);
      expect(logs.some((l) => l.source === 'browser' && l.message.includes('/dashboard'))).toBe(true);
      expect(logs.some((l) => l.source === 'runner' && l.message.startsWith('Step 1:'))).toBe(true);
      if (r.run.hasVideo) expect((await app.inject({ method: 'GET', url: `/api/runs/${r.run.id}/video` })).statusCode).toBe(200);
    } finally {
      jev.controls = before;
      await setVariant('normal');
    }
  });

  it('runs a scenario written in plain sentences', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/scenarios`,
      payload: { name: 'Bad', steps: [{ text: 'buy something nice' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems[0]).toMatch(/^Step 1:/);

    const written: Scenario = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/scenarios`,
        payload: {
          name: 'Order a gadget',
          steps: ['Enter "Gadget" in "Item"', 'Click "Place order"', 'Expect to see "Order placed: 1 x Gadget"', 'Expect to see "Order cancelled"'].map((text) => ({ text })),
        },
      })
    ).json();
    jev.texts.add('Order placed: 1 x Gadget');
    const r = await run(written);
    expect(r.results.slice(-4).map((x) => [x.text, x.status])).toEqual([
      ['Enter "Gadget" in "Item"', 'passed'],
      ['Click "Place order"', 'passed'],
      ['Expect to see "Order placed: 1 x Gadget"', 'passed'],
      ['Expect to see "Order cancelled"', 'failed'],
    ]);
    expect(r.results.slice(0, -4).every((x) => x.from === 'Sign in' && x.status === 'passed')).toBe(true);
    expect(r.results[0].from).toBe('Sign in'); // project setup runs first
  });

  it('runs a library step with the values a scenario passes it', async () => {
    const step = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/steps`,
      payload: { pattern: 'Order "{item}"', kind: 'action', intent: 'Place an order for one item', body: ['Enter "{item}" in "Item"', 'Click "Place order"'].map((text) => ({ text })) },
    });
    expect(step.statusCode).toBe(201);
    const written: Scenario = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/scenarios`,
        payload: { name: 'Order a widget', steps: ['Order "Widget"', 'Expect to see "Order placed: 1 x Widget"'].map((text) => ({ text })) },
      })
    ).json();
    jev.texts.add('Order placed: 1 x Widget');
    const r = await run(written);
    expect(r.results.slice(-3).map((x) => [x.text, x.from, x.status])).toEqual([
      ['Enter "Widget" in "Item"', 'Order "Widget"', 'passed'],
      ['Click "Place order"', 'Order "Widget"', 'passed'],
      ['Expect to see "Order placed: 1 x Widget"', undefined, 'passed'],
    ]);
  });
});

async function measureBroken() {
  const browser = await chromium.launch({ executablePath: config.chromiumPath });
  const page: Page = await browser.newPage({ viewport });
  await page.goto(`${autUrl}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL(/dashboard/);
  for (const label of ['Item', 'Place order']) {
    const b = (await page.locator(SELECTORS[label]).boundingBox())!;
    jev.controls.set(label, { left: b.x / viewport.width, right: (b.x + b.width) / viewport.width, top: b.y / viewport.height, bottom: (b.y + b.height) / viewport.height });
  }
  await browser.close();
}
