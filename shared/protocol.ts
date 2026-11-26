// Types shared by the backend and the browser.
import { tr, type Lang } from './i18n.ts';

export type AgentStatus =
  | 'idle' // idle (coffee)
  | 'queued' // queued behind the concurrency limit
  | 'thinking' // thinking
  | 'typing' // using a tool (reading/writing files, …)
  | 'running' // running Bash
  | 'researching' // web search
  | 'remote' // working on a remote GPU server
  | 'waiting_permission' // waiting for approval
  | 'done' // just finished
  | 'error';

/** which agent harness runs a turn: Claude Code (Agent SDK) or Codex (app-server) */
export type Engine = 'claude' | 'codex';

/**
 * A fixed place outside the desk grid. 'reception' and 'lead' are desks in the bottom strip; 'corner' is a
 * standing spot (no desk) in the bottom-left corner, where the role's `desk` number is its order in the corner;
 * 'podium' is the professor's spot in the right aisle (drawn as the professor). Corner and podium characters
 * talk in speech bubbles.
 */
export type Seat = 'reception' | 'lead' | 'corner' | 'podium';

export interface EmployeeView {
  id: string;
  /** execution harness selected for this employee (a task may override it for one turn: Task.engine) */
  engine: Engine;
  /** engine of the turn in progress when a task overrides the default (shown instead of `engine` until it ends); null otherwise */
  turnEngine: Engine | null;
  name: string;
  title: string;
  desk: number;
  /** colours, plus an optional `look`: one hairstyle or hat (see LOOKS in web/src/game/sprites.ts) */
  sprite: { hair: string; shirt: string; pants: string; skin: string; look?: string };
  status: AgentStatus;
  activity: string; // one-line speech bubble
  taskId: number | null;
  sessionId: string | null;
  cwd: string;
  costUsd: number;
  /** always seated at the own desk in the game view */
  stayAtDesk?: boolean;
  /** a fixed seat instead of a slot in the desk grid */
  seat?: Seat;
  deskStyle?: 'lead';
  /** 'auto': a classifier approves tool calls and only unclear ones become approval cards; 'ask': every non-autoAllow tool asks */
  permission: PermissionSetting;
  /** a session is open right now (the next instruction skips process start) */
  live: boolean;
  /** work is parked until the usage window resets (epoch ms), and will resume by itself */
  parkedUntil?: number;
  /** machine this employee's sessions run on (HostView.id); unset = the machine the backend runs on */
  hostId?: string;
  /** 'staff' sit in the office; 'project' sessions live in the projects tab */
  kind?: 'staff' | 'project';
  /** set when this employee runs on a non-Claude provider (ProviderView.id) */
  provider?: string;
}

/** A folder on a host that sessions are opened in — one project, several independent sessions. */
export interface ProjectView {
  id: string;
  hostId: string;
  name: string;
  /** folder, relative to the host's projectRoot unless absolute */
  dir: string;
  /** its sessions, in creation order */
  sessions: EmployeeView[];
}

/** a machine the office can run Claude Code sessions on ('local' = the machine the backend runs on) */
export interface HostView {
  id: string;
  name: string;
  local: boolean;
  ok: boolean;
  claudeVersion: string | null;
  projectRoot: string;
  /** ssh/scp runs used in the last minute, and this host's budget (0 = no limit) */
  sshUsed: number;
  sshLimit: number;
  /** the shared ssh connection to this host is up right now (always false for the local machine: it has none) */
  connected: boolean;
  /** sessions open on this host now */
  sessions: number;
  /** seconds this host is still being left alone after a failed connection (0 = it may be tried) */
  retryInSec: number;
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

export type TaskHalt = 'failed' | 'stopped' | 'restart';

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
  /** scheduled start (epoch ms): the card waits in 'todo' with its assignee until then; null = not scheduled */
  startAt: number | null;
  /** run this task on this engine instead of the assignee's default (set by the lead/secretary); null = default */
  engine: Engine | null;
  /**
   * id of the task this one follows: it waits in 'todo' with its assignee until that task reaches review or done,
   * then starts with that task's result in its instructions; null = does not follow anything
   */
  afterTask: number | null;
  /** the research subject this task belongs to (see shared/topics.ts): its reports go in reports/<topic>/; null = none */
  topic: string | null;
  /**
   * why a card in 'doing' is not actually being worked on: the run failed, the manager stopped it, or the backend
   * restarted under it. Cleared when the task is started again or moved out of 'doing'; null = fine
   */
  halt: TaskHalt | null;
  /** the reason of a failed run (the last error line, cut short); null when there is none */
  error: string | null;
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

/** `recorded` is a result written down by name for something that did not run as an office job */
export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'recorded';

export interface Job {
  id: number;
  server: string;
  remoteId: string; // pid or slurm job id
  name: string;
  command: string;
  submittedBy: string | null;
  state: JobState;
  logPath: string;
  /** the research subject this run belongs to (see shared/topics.ts); null = none */
  topic: string | null;
  /** what it was run with (name → value), given at submit or with the result; null = not written down */
  params: Record<string, string | number | boolean> | null;
  /** what came out (name → number), written by `record_result`; null = none yet */
  metrics: Record<string, number> | null;
  /** a line of comment recorded with the result */
  note: string | null;
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
  /** which conversation it belongs to (Claude and Codex keep separate ones); null = untagged legacy line */
  engine?: Engine | null;
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
  /** the topic folder it is in (reports/<topic>/…), if any */
  topic: string | null;
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

/** One result of a search across reports, logs, task cards and the report feed. */
export interface SearchHit {
  kind: 'report' | 'log' | 'task' | 'feed' | 'experiment';
  ts: number;
  title: string;
  /** the text around the first match, on one line */
  snippet: string;
  /** the whole thing (capped), to read in place; reports are opened by `path` instead */
  text?: string;
  /** report file (kind 'report', or a feed item about a report) */
  path?: string;
  employeeId?: string;
  taskId?: number;
  /** kind 'log': user | assistant | tool | result | system | error */
  logKind?: string;
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

/** A block of to-dos: a "**Group**" inside a section, or (name '') the lines directly under the heading. */
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
  /** 'schedule' sections also show plain bullets (appointments); see obsidian.schedule */
  kind: 'schedule' | 'tasks';
  /** '' and line -1 = a note without headings, read whole */
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

/** One subscription usage meter (e.g. 5-hour session, weekly). */
export interface UsageRow {
  kind: string; // 'session' | 'weekly_all' | 'weekly_scoped' | ...
  label: string; // display label in the office language
  scope?: string; // model / surface name of a scoped limit (e.g. weekly_scoped), untranslated
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
  codexUsage: UsageView;
  running: number;
  maxConcurrent: number;
  /** display names of the decorative figures in the game view (professor, the manager = you) */
  figureNames: Record<FigureKey, string>;
  providers: ProviderView[];
  hosts: HostView[];
  projects: ProjectView[];
  /** language people read the office in (see shared/i18n.ts) */
  language: Lang;
  /** the running version and whether the remote has a newer one */
  update: UpdateView;
}

/** What the office knows about its own version (see server/src/update.ts). */
export interface UpdateView {
  /** short hash of the commit the backend started on; null when it is not a git checkout */
  version: string | null;
  /** commits on the upstream branch that this checkout lacks */
  behind: number;
  /** their subjects, newest first (at most 20) */
  commits: string[];
  /** when the remote was last looked at (epoch ms); 0 = never */
  checkedAt: number;
  /** did that last look work? false = unknown (offline, no upstream), not "up to date" */
  ok: boolean;
  /** the update button can restart the backend (it runs as the systemd user unit) */
  canRestart: boolean;
  /** the update script is running now */
  running: boolean;
  /** its last output lines */
  log: string[];
}

/** editable labels that are not employees: the manager's name tag, the whiteboard text, and the office's title in the top bar */
export type FigureKey = 'manager' | 'board' | 'title';
export const FIGURE_KEYS: readonly FigureKey[] = ['manager', 'board', 'title'];
/** the office's name until the manager gives it another (top bar, browser tab, desktop notifications, the login page) */
export const DEFAULT_TITLE = '8-bit Lab';
export const figureDefaultName = (key: FigureKey): string => (key === 'manager' ? tr({ ko: '매니저', en: 'Manager' }) : key === 'title' ? DEFAULT_TITLE : '');
export const FIGURE_MAX_LEN: Record<FigureKey, number> = { manager: 20, board: 60, title: 30 };

// server -> client
export type ServerMsg =
  | { t: 'snapshot'; data: Snapshot }
  | { t: 'employee'; data: EmployeeView }
  | { t: 'employeeGone'; id: string }
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
  | { t: 'searchResults'; q: string; hits: SearchHit[] }
  | { t: 'todos'; data: TodayTodos }
  | { t: 'usage'; data: UsageView }
  | { t: 'codexUsage'; data: UsageView }
  | { t: 'update'; data: UpdateView }
  | { t: 'provider'; data: ProviderView }
  | { t: 'host'; data: HostView }
  | { t: 'projects'; data: ProjectView[] }
  | { t: 'hostDirs'; hostId: string; dirs: string[] }
  | { t: 'figureName'; key: FigureKey; name: string }
  | { t: 'log'; data: LogLine }
  | { t: 'logs'; employeeId: string; lines: LogLine[] }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

// client -> server
export type ClientMsg =
  | { t: 'createTask'; title: string; detail: string; assignee?: string | null; requireApproval?: boolean; attachmentIds?: number[]; startAt?: number | null; afterTask?: number | null; topic?: string | null }
  /** whether this tab is in front (phone notifications are held back while someone is watching) */
  | { t: 'presence'; visible: boolean }
  | { t: 'assignTask'; taskId: number; employeeId: string }
  | { t: 'moveTask'; taskId: number; state: TaskState }
  | { t: 'deleteTask'; taskId: number }
  /** look at the remote for a newer version now */
  | { t: 'checkUpdate' }
  /** run the update script (pull, build, restart); takes no arguments on purpose */
  | { t: 'applyUpdate' }
  /** start a halted task again with the same assignee */
  | { t: 'retryTask'; taskId: number }
  | { t: 'instruct'; employeeId: string; text: string; attachmentIds?: number[] }
  /** "/note …" from the command bar: a line for the lab notebook, not for an employee */
  | { t: 'addNote'; text: string }
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
  | { t: 'search'; q: string }
  | { t: 'todoOp'; op: TodoOp }
  | { t: 'createTodayNote' }
  | { t: 'deleteRoutine'; id: string }
  | { t: 'refreshUsage' }
  /** pick the model for every employee on this provider (must be installed there) */
  | { t: 'setProviderModel'; providerId: string; model: string }
  | { t: 'setEmployeeEngine'; employeeId: string; engine: 'claude' | 'codex' }
  /** folders available on a host, for the new-project picker */
  | { t: 'listHostDirs'; hostId: string }
  | { t: 'createProject'; hostId: string; name: string; dir: string; label?: string }
  | { t: 'archiveProject'; id: string }
  | { t: 'addProjectSession'; projectId: string; label?: string }
  | { t: 'closeProjectSession'; id: string }
  /** give a session a desk in the office, or send it back to the projects tab */
  | { t: 'setSessionInOffice'; id: string; inOffice: boolean }
  /** check a host now (it is otherwise only checked at startup, to keep idle traffic at zero) */
  | { t: 'recheckHost'; hostId: string }
  /** close the shared ssh connection to a host (and the idle sessions on it); refused while someone is working there */
  | { t: 'disconnectHost'; hostId: string }
  /** restart work that was parked on the usage limit, without waiting for the reset */
  | { t: 'resumeWork'; employeeId: string }
  /** switch the office language (UI, statuses, and what agents report in) */
  | { t: 'setLanguage'; lang: Lang };
