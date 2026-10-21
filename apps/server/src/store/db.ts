import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project, Run, Scenario, Screen, StepResult } from '@izaro/shared';

// SQLite keeps the MVP dependency-free. Each entity is stored as a JSON document
// with the columns we filter on pulled out; moving to Postgres means
// reimplementing this file only.
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'izaro-v2.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS screens (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenarios (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
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

  listScreens(projectId: string) {
    return this.all<Screen>('SELECT data FROM screens WHERE project_id = ? ORDER BY created_at', projectId);
  }
  getScreen(id: string) {
    return this.one<Screen>('SELECT data FROM screens WHERE id = ?', id);
  }
  saveScreen(s: Screen) {
    this.db
      .prepare('INSERT OR REPLACE INTO screens (id, project_id, created_at, data) VALUES (?, ?, ?, ?)')
      .run(s.id, s.projectId, s.createdAt, JSON.stringify(s));
    return s;
  }
  deleteScreen(id: string) {
    this.db.prepare('DELETE FROM screens WHERE id = ?').run(id);
  }

  listScenarios(projectId: string) {
    return this.all<Scenario>('SELECT data FROM scenarios WHERE project_id = ? ORDER BY id', projectId);
  }
  getScenario(id: string) {
    return this.one<Scenario>('SELECT data FROM scenarios WHERE id = ?', id);
  }
  saveScenario(s: Scenario) {
    this.db.prepare('INSERT OR REPLACE INTO scenarios (id, project_id, data) VALUES (?, ?, ?)').run(s.id, s.projectId, JSON.stringify(s));
    return s;
  }
  deleteScenario(id: string) {
    this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
  }

  listRuns(scenarioId: string) {
    return this.all<Run>('SELECT data FROM runs WHERE scenario_id = ? ORDER BY started_at DESC', scenarioId);
  }
  getRun(id: string) {
    return this.one<Run>('SELECT data FROM runs WHERE id = ?', id);
  }
  saveRun(r: Run) {
    this.db
      .prepare('INSERT OR REPLACE INTO runs (id, scenario_id, started_at, data) VALUES (?, ?, ?, ?)')
      .run(r.id, r.scenarioId, r.startedAt, JSON.stringify(r));
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
