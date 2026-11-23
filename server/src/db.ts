import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.ts';
import { type AttachmentRow, toView } from './attachments.ts';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { FeedItem, Job, JobState, LogLine, PermissionSetting, Task, TaskState } from '../../shared/protocol.ts';

const rowToTask = (r: any, attachments: Task['attachments'] = []): Task => ({ ...r, requireApproval: !!r.requireApproval, attachments });

export interface RoutineRow {
  id: string;
  name: string;
  schedule: string;
  employee: string;
  prompt: string;
  /** office plugin skill run by this routine (office:<skill>), or null for a plain prompt */
  skill: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const toRoutine = (r: any): RoutineRow => ({
  id: r.id,
  name: r.name,
  schedule: r.schedule,
  employee: r.employee,
  prompt: r.prompt,
  skill: r.skill ?? null,
  enabled: !!r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toFeed = (r: any): FeedItem => ({
  id: r.id,
  ts: r.ts,
  kind: r.kind,
  employeeId: r.employeeId ?? null,
  title: r.title,
  body: r.body,
  path: r.path ?? null,
  ok: !!r.ok,
});

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
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, employee TEXT NOT NULL,
        prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);
      CREATE TABLE IF NOT EXISTS feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, employeeId TEXT,
        title TEXT NOT NULL, body TEXT NOT NULL, path TEXT, ok INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS feed_path ON feed(path, ts);
      CREATE TABLE IF NOT EXISTS employee_names (
        employeeId TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_approvals (
        name TEXT PRIMARY KEY, allow TEXT NOT NULL, hash TEXT NOT NULL, approvedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL, textPath TEXT,
        size INTEGER NOT NULL, mime TEXT NOT NULL, createdAt INTEGER NOT NULL, usedAt INTEGER);
      CREATE TABLE IF NOT EXISTS task_attachments (
        taskId INTEGER NOT NULL, attachmentId INTEGER NOT NULL, PRIMARY KEY (taskId, attachmentId));
      CREATE TABLE IF NOT EXISTS employee_perm (
        employeeId TEXT PRIMARY KEY, mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_models (
        providerId TEXT PRIMARY KEY, model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, remoteId TEXT NOT NULL,
        name TEXT NOT NULL, command TEXT NOT NULL, submittedBy TEXT, state TEXT NOT NULL,
        logPath TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    `);
    // migrations for DBs created by older versions
    const cols = (this.db.prepare('PRAGMA table_info(routines)').all() as any[]).map((c) => c.name);
    if (!cols.includes('skill')) this.db.exec('ALTER TABLE routines ADD COLUMN skill TEXT');
    const tcols = (this.db.prepare('PRAGMA table_info(tasks)').all() as any[]).map((c) => c.name);
    if (!tcols.includes('createdBy')) this.db.exec('ALTER TABLE tasks ADD COLUMN createdBy TEXT');
    const scols = (this.db.prepare('PRAGMA table_info(sessions)').all() as any[]).map((c) => c.name);
    if (!scols.includes('hostId')) this.db.exec('ALTER TABLE sessions ADD COLUMN hostId TEXT');
    if (!tcols.includes('requireApproval')) this.db.exec('ALTER TABLE tasks ADD COLUMN requireApproval INTEGER NOT NULL DEFAULT 0');
  }

  // ---- tasks
  listTasks(): Task[] {
    const byTask = new Map<number, Task['attachments']>();
    for (const r of this.db
      .prepare('SELECT ta.taskId, a.* FROM task_attachments ta JOIN attachments a ON a.id = ta.attachmentId ORDER BY a.id')
      .all() as any[]) {
      const arr = byTask.get(r.taskId) ?? [];
      arr.push(toView(r));
      byTask.set(r.taskId, arr);
    }
    return (this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as any[]).map((r) => rowToTask(r, byTask.get(r.id)));
  }
  getTask(id: number): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? rowToTask(r, this.attachmentsForTask(id).map(toView)) : undefined;
  }
  createTask(title: string, detail: string, assignee: string | null, createdBy: string | null = null, requireApproval = false): Task {
    const now = Date.now();
    const r = this.db
      .prepare('INSERT INTO tasks (title, detail, assignee, state, createdBy, requireApproval, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, detail, assignee, 'todo', createdBy, requireApproval ? 1 : 0, now, now);
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
    this.db.prepare('DELETE FROM task_attachments WHERE taskId = ?').run(id); // files stay (they may be linked elsewhere)
  }

  // ---- employee display names set from the UI (override config/roles.yaml)
  getEmployeeName(employeeId: string): string | null {
    const r = this.db.prepare('SELECT name FROM employee_names WHERE employeeId = ?').get(employeeId) as any;
    return r ? r.name : null;
  }
  setEmployeeName(employeeId: string, name: string | null) {
    if (name == null) this.db.prepare('DELETE FROM employee_names WHERE employeeId = ?').run(employeeId);
    else
      this.db
        .prepare('INSERT INTO employee_names (employeeId, name) VALUES (?, ?) ON CONFLICT(employeeId) DO UPDATE SET name = excluded.name')
        .run(employeeId, name);
  }

  // ---- attachments (files live under workspaces/attachments, see attachments.ts)
  addAttachment(a: Omit<AttachmentRow, 'id' | 'usedAt'>): number {
    const r = this.db
      .prepare('INSERT INTO attachments (name, path, textPath, size, mime, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.name, a.path, a.textPath, a.size, a.mime, a.createdAt);
    return Number(r.lastInsertRowid);
  }
  updateAttachmentPaths(id: number, path: string, textPath: string | null) {
    const rel = (p: string | null) => (p && isAbsolute(p) && !relative(this.root, p).startsWith('..') ? relative(this.root, p) : p);
    this.db.prepare('UPDATE attachments SET path = ?, textPath = ? WHERE id = ?').run(rel(path), rel(textPath), id);
  }
  /**
   * Attachment paths are stored relative to workspaceRoot so the DB can move between machines;
   * everything above the Store sees absolute paths.
   */
  private root = ROOT;
  private abs = (r: any): AttachmentRow => ({
    ...r,
    path: isAbsolute(r.path) ? r.path : resolvePath(this.root, r.path),
    textPath: r.textPath ? (isAbsolute(r.textPath) ? r.textPath : resolvePath(this.root, r.textPath)) : null,
  });

  /** Called once at startup: remember the root and rewrite any absolute rows under it as relative. */
  rerootAttachments(workspaceRoot: string) {
    this.root = workspaceRoot;
    const up = this.db.prepare('UPDATE attachments SET path = ?, textPath = ? WHERE id = ?');
    for (const r of this.db.prepare('SELECT * FROM attachments').all() as any[]) {
      const rel = (p: string | null) => (p && isAbsolute(p) && !relative(workspaceRoot, p).startsWith('..') ? relative(workspaceRoot, p) : p);
      const [p, t] = [rel(r.path), rel(r.textPath)];
      if (p !== r.path || t !== r.textPath) up.run(p, t, r.id);
    }
  }

  /** existing rows for these ids, in the given order (unknown ids dropped) */
  getAttachments(ids: number[]): AttachmentRow[] {
    const get = this.db.prepare('SELECT * FROM attachments WHERE id = ?');
    return [...new Set(ids)].map((id) => get.get(id)).filter(Boolean).map((r) => this.abs(r));
  }
  attachmentsForTask(taskId: number): AttachmentRow[] {
    return (this.db
      .prepare('SELECT a.* FROM task_attachments ta JOIN attachments a ON a.id = ta.attachmentId WHERE ta.taskId = ? ORDER BY a.id')
      .all(taskId) as any[]).map((r) => this.abs(r));
  }
  /** link attachments to a task (a file may belong to several tasks); returns the linked rows */
  bindAttachments(taskId: number, ids: number[]): AttachmentRow[] {
    const rows = this.getAttachments(ids);
    const ins = this.db.prepare('INSERT OR IGNORE INTO task_attachments (taskId, attachmentId) VALUES (?, ?)');
    for (const r of rows) ins.run(taskId, r.id);
    this.markAttachmentsUsed(rows.map((r) => r.id));
    return rows;
  }
  markAttachmentsUsed(ids: number[], now = Date.now()) {
    const up = this.db.prepare('UPDATE attachments SET usedAt = COALESCE(usedAt, ?) WHERE id = ?');
    for (const id of ids) up.run(now, id);
  }
  /** uploaded before `before`, never linked to a task nor sent with an instruction */
  pendingAttachments(before: number): AttachmentRow[] {
    return (this.db
      .prepare('SELECT * FROM attachments WHERE usedAt IS NULL AND createdAt < ? AND id NOT IN (SELECT attachmentId FROM task_attachments)')
      .all(before) as any[]).map((r) => this.abs(r));
  }
  deleteAttachment(id: number) {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  // ---- permission mode picked in the UI per employee (overrides roles.yaml / office.yaml)
  getEmployeePerm(employeeId: string): PermissionSetting | null {
    const r = this.db.prepare('SELECT mode FROM employee_perm WHERE employeeId = ?').get(employeeId) as any;
    return r?.mode === 'auto' || r?.mode === 'ask' ? r.mode : null;
  }
  setEmployeePerm(employeeId: string, mode: PermissionSetting) {
    this.db
      .prepare('INSERT INTO employee_perm (employeeId, mode) VALUES (?, ?) ON CONFLICT(employeeId) DO UPDATE SET mode = excluded.mode')
      .run(employeeId, mode);
  }

  // ---- model picked in the UI per provider (overrides office.providers[].model)
  getProviderModel(providerId: string): string | null {
    const r = this.db.prepare('SELECT model FROM provider_models WHERE providerId = ?').get(providerId) as any;
    return r ? r.model : null;
  }
  setProviderModel(providerId: string, model: string) {
    this.db
      .prepare('INSERT INTO provider_models (providerId, model) VALUES (?, ?) ON CONFLICT(providerId) DO UPDATE SET model = excluded.model')
      .run(providerId, model);
  }

  // ---- sessions
  getSession(employeeId: string): { sessionId: string | null; costUsd: number; cwd: string | null; hostId: string | null } {
    const r = this.db.prepare('SELECT * FROM sessions WHERE employeeId = ?').get(employeeId) as any;
    return r ? { sessionId: r.sessionId, costUsd: r.costUsd, cwd: r.cwd, hostId: r.hostId ?? null } : { sessionId: null, costUsd: 0, cwd: null, hostId: null };
  }
  /** `hostId` records which machine's transcript store holds this session id — it cannot be resumed elsewhere. */
  saveSession(employeeId: string, sessionId: string | null, costUsd: number, cwd: string, hostId: string | null = null) {
    this.db
      .prepare(
        `INSERT INTO sessions (employeeId, sessionId, costUsd, cwd, hostId) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(employeeId) DO UPDATE SET sessionId = excluded.sessionId, costUsd = excluded.costUsd, cwd = excluded.cwd, hostId = excluded.hostId`,
      )
      .run(employeeId, sessionId, costUsd, cwd, hostId);
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

  /** Live (not deleted) routine definitions. */
  listRoutines(): RoutineRow[] {
    return (this.db.prepare('SELECT * FROM routines WHERE deletedAt IS NULL ORDER BY rowid').all() as any[]).map(toRoutine);
  }
  getRoutine(id: string): RoutineRow | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE id = ? AND deletedAt IS NULL').get(id) as any;
    return r ? toRoutine(r) : undefined;
  }
  /** Insert a routine from config unless that id was ever stored (deleted ones stay deleted). Returns true if inserted. */
  seedRoutine(r: Omit<RoutineRow, 'createdAt' | 'updatedAt'>): boolean {
    const now = Date.now();
    const res = this.db
      .prepare('INSERT OR IGNORE INTO routines (id, name, schedule, employee, prompt, skill, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.name, r.schedule, r.employee, r.prompt, r.skill ?? null, r.enabled ? 1 : 0, now, now);
    return Number(res.changes) > 0;
  }
  upsertRoutine(r: Omit<RoutineRow, 'createdAt' | 'updatedAt'>): RoutineRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO routines (id, name, schedule, employee, prompt, skill, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, schedule = excluded.schedule, employee = excluded.employee,
           prompt = excluded.prompt, skill = excluded.skill, enabled = excluded.enabled, updatedAt = excluded.updatedAt, deletedAt = NULL`,
      )
      .run(r.id, r.name, r.schedule, r.employee, r.prompt, r.skill ?? null, r.enabled ? 1 : 0, now, now);
    return this.getRoutine(r.id)!;
  }
  setRoutineEnabled(id: string, enabled: boolean) {
    this.db.prepare('UPDATE routines SET enabled = ?, updatedAt = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
  }
  softDeleteRoutine(id: string) {
    this.db.prepare('UPDATE routines SET deletedAt = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- report feed
  addFeed(f: Omit<FeedItem, 'id'>): FeedItem {
    const r = this.db
      .prepare('INSERT INTO feed (ts, kind, employeeId, title, body, path, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.ts, f.kind, f.employeeId, f.title, f.body, f.path, f.ok ? 1 : 0);
    return { ...f, id: Number(r.lastInsertRowid) };
  }
  updateFeed(id: number, patch: Partial<Pick<FeedItem, 'ts' | 'title' | 'body'>>): FeedItem | undefined {
    const cur = this.getFeed(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE feed SET ts = ?, title = ?, body = ? WHERE id = ?').run(n.ts, n.title, n.body, id);
    return n;
  }
  getFeed(id: number): FeedItem | undefined {
    const r = this.db.prepare('SELECT * FROM feed WHERE id = ?').get(id) as any;
    return r ? toFeed(r) : undefined;
  }
  /** newest `limit` items, oldest first */
  recentFeed(limit = 100): FeedItem[] {
    return (this.db.prepare('SELECT * FROM feed ORDER BY id DESC LIMIT ?').all(limit) as any[]).map(toFeed).reverse();
  }
  lastFeedForPath(path: string, sinceTs: number): FeedItem | undefined {
    const r = this.db.prepare("SELECT * FROM feed WHERE kind = 'report' AND path = ? AND ts >= ? ORDER BY id DESC LIMIT 1").get(path, sinceTs) as any;
    return r ? toFeed(r) : undefined;
  }

  // ---- skill approvals (tools a routine's skill may use unattended, pinned to the file hash)
  getSkillApproval(name: string): { allow: string[]; hash: string; approvedAt: number } | undefined {
    const r = this.db.prepare('SELECT * FROM skill_approvals WHERE name = ?').get(name) as any;
    return r ? { allow: JSON.parse(r.allow), hash: r.hash, approvedAt: r.approvedAt } : undefined;
  }
  setSkillApproval(name: string, allow: string[], hash: string) {
    this.db
      .prepare(
        `INSERT INTO skill_approvals (name, allow, hash, approvedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET allow = excluded.allow, hash = excluded.hash, approvedAt = excluded.approvedAt`,
      )
      .run(name, JSON.stringify(allow), hash, Date.now());
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
