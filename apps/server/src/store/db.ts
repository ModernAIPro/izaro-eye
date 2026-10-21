import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Baseline, Project, Run, StepResult, TestCase } from '@izaro/shared';

// SQLite keeps the MVP dependency-free. Each entity is stored as a JSON document
// with the columns we filter on pulled out; moving to Postgres means
// reimplementing this file only.
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'izaro.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baselines (id TEXT PRIMARY KEY, test_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baseline_images (baseline_id TEXT NOT NULL, step_id TEXT NOT NULL, image_key TEXT NOT NULL,
        PRIMARY KEY (baseline_id, step_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, test_id TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL);
    `);
  }

  private all<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.db.prepare(sql).all(...args).map((r) => JSON.parse((r as { data: string }).data) as T);
  }
  private one<T>(sql: string, ...args: (string | number)[]): T | undefined {
    const r = this.db.prepare(sql).get(...args) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  listProjects() {
    return this.all<Project>('SELECT data FROM projects ORDER BY id');
  }
  getProject(id: string) {
    return this.one<Project>('SELECT data FROM projects WHERE id = ?', id);
  }
  saveProject(p: Project) {
    this.db.prepare('INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)').run(p.id, JSON.stringify(p));
    return p;
  }
  deleteProject(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  listTests(projectId: string) {
    return this.all<TestCase>('SELECT data FROM tests WHERE project_id = ? ORDER BY id', projectId);
  }
  getTest(id: string) {
    return this.one<TestCase>('SELECT data FROM tests WHERE id = ?', id);
  }
  saveTest(t: TestCase) {
    this.db
      .prepare('INSERT OR REPLACE INTO tests (id, project_id, data) VALUES (?, ?, ?)')
      .run(t.id, t.projectId, JSON.stringify(t));
    return t;
  }
  deleteTest(id: string) {
    this.db.prepare('DELETE FROM tests WHERE id = ?').run(id);
  }

  getBaseline(id: string) {
    return this.one<Baseline>('SELECT data FROM baselines WHERE id = ?', id);
  }
  nextBaselineVersion(testId: string) {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM baselines WHERE test_id = ?').get(testId) as { v: number | null };
    return (r.v ?? 0) + 1;
  }
  saveBaseline(b: Baseline, images: Record<string, string>) {
    this.db
      .prepare('INSERT OR REPLACE INTO baselines (id, test_id, version, data) VALUES (?, ?, ?, ?)')
      .run(b.id, b.testId, b.version, JSON.stringify(b));
    const ins = this.db.prepare('INSERT OR REPLACE INTO baseline_images (baseline_id, step_id, image_key) VALUES (?, ?, ?)');
    for (const [stepId, key] of Object.entries(images)) ins.run(b.id, stepId, key);
    return b;
  }
  baselineImages(baselineId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT step_id, image_key FROM baseline_images WHERE baseline_id = ?').all(baselineId) as {
      step_id: string;
      image_key: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.step_id, r.image_key]));
  }
  setBaselineImage(baselineId: string, stepId: string, key: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO baseline_images (baseline_id, step_id, image_key) VALUES (?, ?, ?)')
      .run(baselineId, stepId, key);
  }

  listRuns(testId: string) {
    return this.all<Run>('SELECT data FROM runs WHERE test_id = ? ORDER BY started_at DESC', testId);
  }
  getRun(id: string) {
    return this.one<Run>('SELECT data FROM runs WHERE id = ?', id);
  }
  saveRun(r: Run) {
    this.db
      .prepare('INSERT OR REPLACE INTO runs (id, test_id, started_at, data) VALUES (?, ?, ?, ?)')
      .run(r.id, r.testId, r.startedAt, JSON.stringify(r));
    return r;
  }

  listResults(runId: string) {
    return this.all<StepResult>('SELECT data FROM step_results WHERE run_id = ? ORDER BY idx', runId);
  }
  getResult(id: string) {
    return this.one<StepResult>('SELECT data FROM step_results WHERE id = ?', id);
  }
  saveResult(r: StepResult) {
    this.db
      .prepare('INSERT OR REPLACE INTO step_results (id, run_id, idx, data) VALUES (?, ?, ?, ?)')
      .run(r.id, r.runId, r.index, JSON.stringify(r));
    return r;
  }

  close() {
    this.db.close();
  }
}
