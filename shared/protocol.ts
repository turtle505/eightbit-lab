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
}

export type TaskState = 'todo' | 'doing' | 'review' | 'done';

export interface Task {
  id: number;
  title: string;
  detail: string;
  assignee: string | null;
  state: TaskState;
  result: string | null;
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
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
}

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
  /** latest log lines across all employees (activity feed) */
  recentLogs: LogLine[];
  usage: UsageView;
  running: number;
  maxConcurrent: number;
}

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
  | { t: 'usage'; data: UsageView }
  | { t: 'log'; data: LogLine }
  | { t: 'logs'; employeeId: string; lines: LogLine[] }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

// client -> server
export type ClientMsg =
  | { t: 'createTask'; title: string; detail: string; assignee?: string | null }
  | { t: 'assignTask'; taskId: number; employeeId: string }
  | { t: 'moveTask'; taskId: number; state: TaskState }
  | { t: 'deleteTask'; taskId: number }
  | { t: 'instruct'; employeeId: string; text: string }
  | { t: 'stop'; employeeId: string }
  | { t: 'resetSession'; employeeId: string }
  | { t: 'approve'; id: string; allow: boolean; message?: string }
  | { t: 'getLogs'; employeeId: string }
  | { t: 'cancelJob'; jobId: number }
  | { t: 'refreshServers' }
  | { t: 'runRoutine'; id: string }
  | { t: 'toggleRoutine'; id: string; enabled: boolean }
  | { t: 'refreshUsage' };
