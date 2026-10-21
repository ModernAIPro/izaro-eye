import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { matchLibraryStep, patternProblems, type LibraryStep, type LibraryStepView, type Project, type Scenario } from '@izaro/shared';
import { buildApp } from '../src/app.js';
import { LocalVision } from '../src/compare/jev.js';
import { flatten } from '../src/runner/executor.js';

const lib = (pattern: string, body: string[] = ['Scroll down']): LibraryStep => ({
  id: pattern,
  projectId: 'p',
  pattern,
  kind: 'action',
  intent: '',
  body: body.map((text) => ({ text })),
  tags: [],
  createdAt: '',
  updatedAt: '',
});

describe('step library matching', () => {
  it('matches quoted values, smart quotes and spacing, and prefers the more specific pattern', () => {
    const steps = [lib('Search for "{term}"'), lib('Search for "{term}" in "{section}"'), lib('Log in as {role}')];
    expect(matchLibraryStep('search  for “shoes”.', steps)).toMatchObject({ step: { pattern: 'Search for "{term}"' }, args: { term: 'shoes' } });
    expect(matchLibraryStep('Search for "red" in "Plans"', steps)?.args).toEqual({ term: 'red', section: 'Plans' });
    expect(matchLibraryStep('Log in as store manager', steps)?.args).toEqual({ role: 'store manager' });
    expect(matchLibraryStep('Click "Search"', steps)).toBeUndefined();
  });

  it('rejects patterns that would shadow a base step', () => {
    expect(patternProblems('Click "{label}"')).toHaveLength(1);
    expect(patternProblems('Search for "{term}"')).toEqual([]);
    expect(patternProblems('"{a}" "{a}"').length).toBeGreaterThan(0);
  });
});

describe('step library API and runs', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let project: Project;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'izaro-steps-'));
    app = await buildApp({ dataDir, vision: new LocalVision() });
    project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', baseUrl: 'http://localhost:1' } })).json();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

  it('creates steps, accepts them in scenarios, expands them in runs and renames their uses', async () => {
    const bad = await post(`/api/projects/${project.id}/steps`, { pattern: 'Search for "{term}"', body: [{ text: 'Enter "{query}" in "Search"' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/\{query\}/);

    const search = (
      await post(`/api/projects/${project.id}/steps`, {
        pattern: 'Search for "{term}"',
        kind: 'action',
        intent: 'Find items by name',
        body: [{ text: 'Enter "{term}" in "Search"', hint: { screenId: 'scr_1', elementId: 'el_1' } }, { text: 'Press "Enter"' }],
        tags: ['Search', ' search '],
      })
    ).json() as LibraryStepView;
    expect(search.tags).toEqual(['search']);
    const check = (
      await post(`/api/projects/${project.id}/steps`, {
        pattern: 'Check results for "{term}"',
        kind: 'flow',
        body: [{ text: 'Search for "{term}"' }, { text: 'Expect to see "{term}"' }],
      })
    ).json() as LibraryStepView;
    expect((await post(`/api/projects/${project.id}/steps`, { pattern: 'search for "{x}"', body: [{ text: 'Scroll down' }] })).statusCode).toBe(400);

    const sc = (await post(`/api/projects/${project.id}/scenarios`, { name: 'Find shoes', steps: [{ text: 'Go to "/"' }, { text: 'Check results for "shoes"' }] })).json() as Scenario;
    expect(sc.id).toBeTruthy();
    expect((await post(`/api/projects/${project.id}/scenarios`, { name: 'X', steps: [{ text: 'Look for "shoes"' }] })).statusCode).toBe(400);
    const unfilled = await post(`/api/projects/${project.id}/scenarios`, { name: 'Y', steps: [{ text: 'Search for "{term}"' }] });
    expect(unfilled.json().message).toMatch(/replace \{term\} with a value/);

    const flat = flatten(app.izaro.store, app.izaro.store.getProject(project.id)!, sc);
    expect(flat.map((f) => [f.step.text, f.from])).toEqual([
      ['Go to "/"', undefined],
      ['Enter "shoes" in "Search"', 'Check results for "shoes" › Search for "shoes"'],
      ['Press "Enter"', 'Check results for "shoes" › Search for "shoes"'],
      ['Expect to see "shoes"', 'Check results for "shoes"'],
    ]);
    expect(flat[1].step.hint).toEqual({ screenId: 'scr_1', elementId: 'el_1' });

    const viewed = (await app.inject({ method: 'GET', url: `/api/steps/${search.id}` })).json() as LibraryStepView;
    expect(viewed.usedBy.steps).toEqual([{ id: check.id, pattern: check.pattern }]);
    expect((await app.inject({ method: 'DELETE', url: `/api/steps/${search.id}` })).statusCode).toBe(409);

    // Renaming carries through to every use, keeping the values.
    const renamed = await app.inject({ method: 'PUT', url: `/api/steps/${check.id}`, payload: { pattern: 'Verify search results for "{term}"' } });
    expect(renamed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/scenarios/${sc.id}` })).json().steps[1].text).toBe('Verify search results for "shoes"');
    expect((await app.inject({ method: 'PUT', url: `/api/steps/${check.id}`, payload: { pattern: 'Verify "{a}" and "{term}"' } })).statusCode).toBe(400);

    // A step can't use itself, even through another step.
    const loop = await app.inject({ method: 'PUT', url: `/api/steps/${search.id}`, payload: { body: [{ text: 'Verify search results for "{term}"' }] } });
    expect(loop.statusCode).toBe(400);
    expect(loop.json().message).toMatch(/uses this step itself/);
  });
});
