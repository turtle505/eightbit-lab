import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.ts';
import type { Job, JobState, LogLine, Task, TaskState } from '../../shared/protocol.ts';

export class Store {
  db: DatabaseSync;

  constructor(path = resolve(ROOT, 'data/office.db')) {
    if (path !== ':memory:') mkdirSync(resolve(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        assignee TEXT, state TEXT NOT NULL DEFAULT 'todo', result TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        employeeId TEXT PRIMARY KEY, sessionId TEXT, costUsd REAL NOT NULL DEFAULT 0, cwd TEXT);
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, employeeId TEXT NOT NULL,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_emp ON logs(employeeId, id);
      CREATE TABLE IF NOT EXISTS routine_state (
        id TEXT PRIMARY KEY, enabled INTEGER, lastRun INTEGER);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, remoteId TEXT NOT NULL,
        name TEXT NOT NULL, command TEXT NOT NULL, submittedBy TEXT, state TEXT NOT NULL,
        logPath TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    `);
  }

  // ---- tasks
  listTasks(): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as unknown as Task[];
  }
  getTask(id: number): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Task | undefined;
  }
  createTask(title: string, detail: string, assignee: string | null): Task {
    const now = Date.now();
    const r = this.db
      .prepare('INSERT INTO tasks (title, detail, assignee, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, detail, assignee, 'todo', now, now);
    return this.getTask(Number(r.lastInsertRowid))!;
  }
  updateTask(id: number, patch: Partial<Pick<Task, 'assignee' | 'state' | 'result'>>): Task | undefined {
    const t = this.getTask(id);
    if (!t) return undefined;
    const n = { ...t, ...patch, updatedAt: Date.now() };
    this.db
      .prepare('UPDATE tasks SET assignee = ?, state = ?, result = ?, updatedAt = ? WHERE id = ?')
      .run(n.assignee, n.state as TaskState, n.result, n.updatedAt, id);
    return n;
  }
  deleteTask(id: number) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  // ---- sessions
  getSession(employeeId: string): { sessionId: string | null; costUsd: number; cwd: string | null } {
    const r = this.db.prepare('SELECT * FROM sessions WHERE employeeId = ?').get(employeeId) as any;
    return r ? { sessionId: r.sessionId, costUsd: r.costUsd, cwd: r.cwd } : { sessionId: null, costUsd: 0, cwd: null };
  }
  saveSession(employeeId: string, sessionId: string | null, costUsd: number, cwd: string) {
    this.db
      .prepare(
        `INSERT INTO sessions (employeeId, sessionId, costUsd, cwd) VALUES (?, ?, ?, ?)
         ON CONFLICT(employeeId) DO UPDATE SET sessionId = excluded.sessionId, costUsd = excluded.costUsd, cwd = excluded.cwd`,
      )
      .run(employeeId, sessionId, costUsd, cwd);
  }

  // ---- logs
  addLog(l: LogLine) {
    this.db.prepare('INSERT INTO logs (employeeId, ts, kind, text) VALUES (?, ?, ?, ?)').run(l.employeeId, l.ts, l.kind, l.text);
  }
  recentLogs(employeeId: string, limit = 300): LogLine[] {
    const rows = this.db
      .prepare('SELECT employeeId, ts, kind, text FROM logs WHERE employeeId = ? ORDER BY id DESC LIMIT ?')
      .all(employeeId, limit) as unknown as LogLine[];
    return rows.reverse();
  }

  logsSince(ts: number, limit = 400): LogLine[] {
    const rows = this.db
      .prepare('SELECT employeeId, ts, kind, text FROM logs WHERE ts >= ? ORDER BY id DESC LIMIT ?')
      .all(ts, limit) as unknown as LogLine[];
    return rows.reverse();
  }

  // ---- routines
  getRoutineState(id: string): { enabled: boolean | null; lastRun: number | null } {
    const r = this.db.prepare('SELECT enabled, lastRun FROM routine_state WHERE id = ?').get(id) as any;
    return { enabled: r?.enabled == null ? null : !!r.enabled, lastRun: r?.lastRun ?? null };
  }
  setRoutineState(id: string, patch: { enabled?: boolean; lastRun?: number }) {
    const cur = this.getRoutineState(id);
    const enabled = patch.enabled ?? cur.enabled;
    const lastRun = patch.lastRun ?? cur.lastRun;
    this.db
      .prepare(
        `INSERT INTO routine_state (id, enabled, lastRun) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, lastRun = excluded.lastRun`,
      )
      .run(id, enabled == null ? null : enabled ? 1 : 0, lastRun);
  }

  // ---- jobs
  listJobs(limit = 100): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as Job[]).reverse();
  }
  activeJobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('pending','running','unknown')").all() as unknown as Job[];
  }
  getJob(id: number): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined;
  }
  createJob(j: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job {
    const now = Date.now();
    const r = this.db
      .prepare(
        'INSERT INTO jobs (server, remoteId, name, command, submittedBy, state, logPath, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(j.server, j.remoteId, j.name, j.command, j.submittedBy, j.state, j.logPath, now, now);
    return this.getJob(Number(r.lastInsertRowid))!;
  }
  setJobState(id: number, state: JobState): Job | undefined {
    this.db.prepare('UPDATE jobs SET state = ?, updatedAt = ? WHERE id = ?').run(state, Date.now(), id);
    return this.getJob(id);
  }
}
