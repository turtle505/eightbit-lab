// Types shared by the backend and the browser.

export type AgentStatus =
  | 'idle' // 대기 (커피)
  | 'queued' // 동시 실행 제한으로 대기열
  | 'thinking' // 생각 중
  | 'typing' // 파일 읽기/쓰기 등 도구 사용
  | 'running' // Bash 실행
  | 'researching' // 웹 검색
  | 'remote' // 원격 GPU 서버 작업 중
  | 'waiting_permission' // 승인 대기
  | 'done' // 방금 작업 완료
  | 'error';

export interface EmployeeView {
  id: string;
  name: string;
  title: string;
  desk: number;
  sprite: { hair: string; shirt: string; pants: string; skin: string };
  status: AgentStatus;
  activity: string; // 말풍선 한 줄
  taskId: number | null;
  sessionId: string | null;
  cwd: string;
  costUsd: number;
  /** always seated at the own desk in the game view */
  stayAtDesk?: boolean;
  deskStyle?: 'lead';
  /** 'auto': a classifier approves tool calls and only unclear ones become approval cards; 'ask': every non-autoAllow tool asks */
  permission: PermissionSetting;
  /** a session is open right now (the next instruction skips process start) */
  live: boolean;
  /** machine this employee's sessions run on (HostView.id); unset = the machine the backend runs on */
  hostId?: string;
  /** set when this employee runs on a non-Claude provider (ProviderView.id) */
  provider?: string;
}

/** a machine the office can run Claude Code sessions on ('local' = the machine the backend runs on) */
export interface HostView {
  id: string;
  name: string;
  local: boolean;
  ok: boolean;
  claudeVersion: string | null;
  projectRoot: string;
  error: string | null;
}

/** a non-Claude model backend (currently an Ollama server reached over an SSH tunnel) */
export interface ProviderView {
  id: string;
  name: string;
  kind: 'ollama';
  /** tunnel up and the server answered the last health check */
  ok: boolean;
  version: string | null;
  /** installed models (Ollama /api/tags) */
  models: string[];
  /** model employees on this provider currently use */
  model: string;
  error: string | null;
}

export type TaskState = 'todo' | 'doing' | 'review' | 'done';

/** a file the manager attached to a task or an instruction (served at /api/attachments/<id>) */
export interface AttachmentView {
  id: number;
  name: string;
  size: number;
  mime: string;
  /** a plain-text conversion (docx/rtf/…) sits next to the original */
  hasText: boolean;
}
export type PermissionSetting = 'auto' | 'ask';

export interface Task {
  id: number;
  title: string;
  detail: string;
  assignee: string | null;
  state: TaskState;
  result: string | null;
  /** employee id that delegated this task (null = created by the manager in the UI) */
  createdBy: string | null;
  /** run this task in 'ask' mode even if the assignee is on auto (risky / hard-to-undo work) */
  requireApproval: boolean;
  attachments: AttachmentView[];
  createdAt: number;
  updatedAt: number;
}

export interface Approval {
  id: string;
  employeeId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: number;
}

export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface Job {
  id: number;
  server: string;
  remoteId: string; // pid or slurm job id
  name: string;
  command: string;
  submittedBy: string | null;
  state: JobState;
  logPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  util: number; // %
  memUsed: number; // MiB
  memTotal: number; // MiB
}

export interface ServerView {
  name: string;
  type: 'ssh' | 'slurm';
  online: boolean;
  gpus: GpuInfo[];
  note: string; // e.g. slurm queue summary or error
  checkedAt: number;
}

export interface LogLine {
  employeeId: string;
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'system' | 'error';
  text: string;
}

export interface RoutineView {
  id: string;
  name: string;
  schedule: string; // cron (local time)
  employee: string;
  prompt: string;
  /** office skill this routine runs (invoked as office:<skill>), null = plain prompt */
  skill: string | null;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
}

/** A skill in the office plugin (workspaces/office-skills), usable by routines. */
export interface SkillView {
  name: string;
  description: string;
  /** tool rules auto-allowed while a routine runs this skill */
  allow: string[];
  /** false when the file changed since the manager approved it → no auto-allow until re-approved */
  approved: boolean;
}

/** A markdown report file found under a report folder (e.g. workspaces/secretary/reports). */
export interface ReportFile {
  /** "<root label>/<relative path>", e.g. "secretary/reports/daily/2026-11-23-mail.md" — also the id */
  path: string;
  root: string;
  employeeId: string | null;
  title: string;
  size: number;
  mtime: number;
}

/** One card in the 📨 report feed: a report file that appeared/changed, or a finished run's final answer. */
export interface FeedItem {
  id: number;
  ts: number;
  kind: 'report' | 'result';
  employeeId: string | null;
  title: string;
  /** markdown */
  body: string;
  /** report file path (kind 'report') */
  path: string | null;
  ok: boolean;
}

/** A checkbox line in today's Obsidian daily note. `line`+`raw` identify it for edits (stale edits are refused). */
export interface TodoItem {
  line: number;
  raw: string;
  checked: boolean;
  /** text without the "↻N" carry-over marker (markdown / wikilinks kept) */
  text: string;
  /** how many days it has been carried over (↻N), 0 if new */
  carry: number;
  children: TodoItem[];
  /** non-checkbox sub-bullets / continuation lines (descriptions), indentation-relative depth */
  notes: Array<{ depth: number; text: string }>;
}

/** A "**[[Project]]**" block (name '' = lines directly under the section heading). */
export interface TodoProject {
  name: string;
  /** Obsidian note the header links to, if any */
  link: string | null;
  line: number;
  raw: string;
  /** plain memo lines in the block */
  memo: string[];
  items: TodoItem[];
}

export interface TodoSection {
  kind: 'schedule' | 'project' | 'study';
  title: string;
  line: number;
  projects: TodoProject[];
}

export interface TodayTodos {
  /** false when no Obsidian vault is configured (panel hidden) */
  enabled: boolean;
  date: string; // YYYY-MM-DD (local)
  relPath: string;
  exists: boolean;
  mtime: number;
  vaultName: string;
  canCreate: boolean;
  sections: TodoSection[];
  error: string;
}

export type TodoOp =
  | { op: 'toggle'; line: number; raw: string }
  | { op: 'edit'; line: number; raw: string; text: string }
  | { op: 'delete'; line: number; raw: string }
  | { op: 'add'; headerLine: number; headerRaw: string; text: string; parentLine?: number; parentRaw?: string };

/** One subscription usage meter (e.g. 5-hour session, weekly), as reported by claude.ai. */
export interface UsageRow {
  kind: string; // 'session' | 'weekly_all' | 'weekly_scoped' | ...
  label: string; // Korean display label
  percent: number; // 0-100
  resetsAt: number | null; // epoch ms
  severity: string; // 'normal' | 'warning' | 'critical'
}

export interface UsageView {
  available: boolean;
  plan: string | null;
  rows: UsageRow[];
  fetchedAt: number | null;
  note: string; // why unavailable / last error
}

export interface Snapshot {
  employees: EmployeeView[];
  tasks: Task[];
  approvals: Approval[];
  jobs: Job[];
  servers: ServerView[];
  routines: RoutineView[];
  skills: SkillView[];
  reports: ReportFile[];
  /** recent report-feed cards, oldest first */
  feed: FeedItem[];
  todos: TodayTodos;
  /** latest log lines across all employees (activity feed) */
  recentLogs: LogLine[];
  usage: UsageView;
  running: number;
  maxConcurrent: number;
  /** display names of the decorative figures in the game view (professor, the manager = you) */
  figureNames: Record<FigureKey, string>;
  providers: ProviderView[];
  hosts: HostView[];
}

/** editable labels in the game view that are not employees: professor / manager name tags and the whiteboard text */
export type FigureKey = 'professor' | 'manager' | 'board';
export const FIGURE_DEFAULT_NAMES: Record<FigureKey, string> = { professor: '교수님', manager: '매니저', board: '' };
export const FIGURE_MAX_LEN: Record<FigureKey, number> = { professor: 20, manager: 20, board: 60 };

// server -> client
export type ServerMsg =
  | { t: 'snapshot'; data: Snapshot }
  | { t: 'employee'; data: EmployeeView }
  | { t: 'task'; data: Task }
  | { t: 'taskDeleted'; id: number }
  | { t: 'approval'; data: Approval }
  | { t: 'approvalResolved'; id: string }
  | { t: 'job'; data: Job }
  | { t: 'server'; data: ServerView }
  | { t: 'routine'; data: RoutineView }
  | { t: 'routineDeleted'; id: string }
  | { t: 'skills'; data: SkillView[] }
  | { t: 'reports'; data: ReportFile[] }
  | { t: 'feed'; data: FeedItem }
  | { t: 'reportContent'; path: string; content: string; mtime: number }
  | { t: 'todos'; data: TodayTodos }
  | { t: 'usage'; data: UsageView }
  | { t: 'provider'; data: ProviderView }
  | { t: 'host'; data: HostView }
  | { t: 'figureName'; key: FigureKey; name: string }
  | { t: 'log'; data: LogLine }
  | { t: 'logs'; employeeId: string; lines: LogLine[] }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

// client -> server
export type ClientMsg =
  | { t: 'createTask'; title: string; detail: string; assignee?: string | null; requireApproval?: boolean; attachmentIds?: number[] }
  | { t: 'assignTask'; taskId: number; employeeId: string }
  | { t: 'moveTask'; taskId: number; state: TaskState }
  | { t: 'deleteTask'; taskId: number }
  | { t: 'instruct'; employeeId: string; text: string; attachmentIds?: number[] }
  | { t: 'stop'; employeeId: string }
  | { t: 'resetSession'; employeeId: string }
  | { t: 'setPermission'; employeeId: string; mode: PermissionSetting }
  /** change the display nickname; empty → back to the name in roles.yaml */
  | { t: 'renameEmployee'; employeeId: string; nick: string }
  /** rename a decorative figure; empty → its default name */
  | { t: 'renameFigure'; key: FigureKey; name: string }
  | { t: 'approve'; id: string; allow: boolean; message?: string }
  | { t: 'getLogs'; employeeId: string }
  | { t: 'cancelJob'; jobId: number }
  | { t: 'refreshServers' }
  | { t: 'runRoutine'; id: string }
  | { t: 'toggleRoutine'; id: string; enabled: boolean }
  /** create (no id) or update (id) a routine */
  | { t: 'saveRoutine'; id?: string; name: string; schedule: string; employee: string; prompt: string; skill?: string | null; enabled?: boolean }
  | { t: 'approveSkill'; name: string }
  | { t: 'getReport'; path: string }
  | { t: 'todoOp'; op: TodoOp }
  | { t: 'createTodayNote' }
  | { t: 'deleteRoutine'; id: string }
  | { t: 'refreshUsage' }
  /** pick the model for every employee on this provider (must be installed there) */
  | { t: 'setProviderModel'; providerId: string; model: string };
