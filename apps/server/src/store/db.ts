import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LibraryStep, LogEntry, Project, Run, Scenario, Screen, StepResult } from '@izaro/shared';

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
      CREATE TABLE IF NOT EXISTS run_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_logs_run ON run_logs (run_id, seq);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_secrets (project_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, name));
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
  /** Deletes the project and everything in it; returns the deleted run ids (their videos live on disk). */
  deleteProject(id: string): string[] {
    const runIds = (
      this.db.prepare('SELECT r.id FROM runs r JOIN scenarios s ON s.id = r.scenario_id WHERE s.project_id = ?').all(id) as { id: string }[]
    ).map((r) => r.id);
    this.db.exec('BEGIN');
    try {
      for (const runId of runIds) {
        this.db.prepare('DELETE FROM step_results WHERE run_id = ?').run(runId);
        this.db.prepare('DELETE FROM run_logs WHERE run_id = ?').run(runId);
        this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      }
      for (const table of ['scenarios', 'steps', 'screens', 'project_secrets']) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return runIds;
  }

  /** Per-project secrets (e.g. the TypeSafe API key). Kept out of the project document so they are never sent to the UI. */
  getSecret(projectId: string, name: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM project_secrets WHERE project_id = ? AND name = ?').get(projectId, name) as { value: string } | undefined;
    return r?.value;
  }
  setSecret(projectId: string, name: string, value: string | undefined) {
    if (value) this.db.prepare('INSERT OR REPLACE INTO project_secrets (project_id, name, value) VALUES (?, ?, ?)').run(projectId, name, value);
    else this.db.prepare('DELETE FROM project_secrets WHERE project_id = ? AND name = ?').run(projectId, name);
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

  listSteps(projectId: string) {
    return this.all<LibraryStep>('SELECT data FROM steps WHERE project_id = ? ORDER BY id', projectId);
  }
  getStep(id: string) {
    return this.one<LibraryStep>('SELECT data FROM steps WHERE id = ?', id);
  }
  saveStep(s: LibraryStep) {
    this.db.prepare('INSERT OR REPLACE INTO steps (id, project_id, data) VALUES (?, ?, ?)').run(s.id, s.projectId, JSON.stringify(s));
    return s;
  }
  deleteStep(id: string) {
    this.db.prepare('DELETE FROM steps WHERE id = ?').run(id);
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

  appendLog(runId: string, entry: LogEntry) {
    this.db.prepare('INSERT INTO run_logs (run_id, data) VALUES (?, ?)').run(runId, JSON.stringify(entry));
  }
  listLogs(runId: string) {
    return this.all<LogEntry>('SELECT data FROM run_logs WHERE run_id = ? ORDER BY seq', runId);
  }

  close() {
    this.db.close();
  }
}
