import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStatus, EmployeeView, Engine, LogLine, PermissionSetting, TaskHalt } from '../../../shared/protocol.ts';
import { clipError } from '../schedule.ts';
import { bus } from '../bus.ts';
import { getLang, hhmm, LANG_NAME_EN, tr, type Lang } from '../../../shared/i18n.ts';
import type { ServerRegistry } from '../compute/registry.ts';
import type { OfficeConfig, RoleConfig } from '../config.ts';
import type { Store } from '../db.ts';
import { labToolsServer, RECORD_TOOL } from '../mcp/labTools.ts';
import { type OfficeApi, officeToolsServer } from '../mcp/officeTools.ts';
import type { PermissionBroker } from '../permissions/broker.ts';
import type { ProviderHub } from '../providers.ts';
import { sshThrottle, type HostRegistry } from '../hosts.ts';
import { SshThrottle } from '../sshRate.ts';
import { describeToolCall, statusForTool } from './status.ts';
import { ensureWorkspace } from './workspace.ts';
import { CodexTurn } from './codex.ts';
import { CodexTools } from './codexTools.ts';
import { stageCodexAttachments } from './codexAttachments.ts';
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.ts';

interface Work {
  text: string;
  taskId: number | null;
  /** extra auto-allow rules for this run only (an approved skill's office-allow) */
  extraAllow: string[];
  /** short title for the report feed, e.g. "⏰ Morning briefing" */
  label: string;
  /** force 'ask' for this run (task marked 🔒 by the manager or the delegating lead) */
  requireApproval: boolean;
  attachmentPaths: string[];
  /** run this one turn on this engine instead of the employee's default (a task the lead routed) */
  engine?: Engine;
}

/** Push-driven async iterable: the stream of user messages a live session reads from. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

/**
 * One Claude Code session kept open across instructions, so the second instruction doesn't pay for
 * process start, session load and MCP/plugin connect again — and so the manager can push a message
 * into a turn that is already running.
 */
interface LiveSession {
  q: Query;
  input: MessageQueue;
  abort: AbortController;
  cwd: string;
  /** permission mode the session is currently in, so we only call setPermissionMode on a change */
  perm: PermissionSetting;
  /** provider the session was opened for (its model is baked into env at start) */
  providerModel: string | null;
  /** office language when opened: the report-language line is part of the system prompt */
  lang: Lang;
  /** last result.total_cost_usd — it is cumulative per session, so we bill the delta */
  lastCost: number | null;
  /** the consume loop, so close() can await it */
  done: Promise<void>;
}

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  session_id: '',
});

/** Emitted on the bus as 'runFinished' when a run ends (not when stopped by the manager). */
export interface RunFinished {
  employeeId: string;
  label: string;
  text: string;
  ok: boolean;
  taskId: number | null;
  /** the last error line of a failed run, if one was logged */
  error?: string;
}

class Employee {
  view: EmployeeView;
  inbox: Work[] = [];
  live: LiveSession | null = null;
  codexTurn: CodexTurn | null = null;
  codexStopped = false;
  /** resolves the in-flight turn (set by run(), called from the consume loop on `result`) */
  endTurn: (() => void) | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  current: Work | null = null;
  lastText = '';
  /** last error line logged during the current run: the reason shown on a failed task card */
  lastError = '';
  /** the last reply of the current run was an API error (the CLI still ends such a turn with `success`) */
  apiFailed = false;
  /** the manager stopped the current run (so its task is marked stopped, not failed) */
  stopRequested = false;
  /** mode requested for the current run (to report a fallback from auto) */
  wantedPermission: PermissionSetting = 'ask';
  /** the stored session id is not on this machine (resume failed) — retry once without it */
  resumeMissing = false;
  /** host whose transcript store holds view.sessionId */
  sessionHost: string | null = null;
  /** epoch ms the subscription limit lifts, when the last turn died on it */
  rateLimitedUntil: number | null = null;
  /** work parked until the limit lifts, so an overnight run picks itself back up (`view.parkedUntil` mirrors it) */
  parked: { work: Work; timer: NodeJS.Timeout } | null = null;

  constructor(readonly role: RoleConfig, sessionId: string | null, costUsd: number, permission: PermissionSetting) {
    this.view = {
      id: role.id,
      engine: 'claude',
      turnEngine: null,
      name: role.name,
      title: role.title,
      desk: role.desk,
      sprite: role.sprite,
      status: 'idle',
      activity: tr({ ko: '☕ 대기 중', en: '☕ Idle' }),
      taskId: null,
      sessionId,
      cwd: '',
      costUsd,
      stayAtDesk: role.stayAtDesk ?? false,
      seat: role.seat,
      deskStyle: role.deskStyle,
      permission,
      live: false,
      hostId: role.host,
      kind: role.kind ?? 'staff',
      provider: role.provider,
    };
  }
}

/** appended to every role prompt: prompts are English, reports follow the office language */
export const reportLanguageLine = (lang: Lang) =>
  `Write everything addressed to the manager (replies, reports, task results, report files) in ${LANG_NAME_EN[lang]}.`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** when the limit report carries no reset time */
const LIMIT_FALLBACK_MS = 30 * 60_000;

/** Kang, On and the professor only talk: they sit in the corner or on the podium and run no experiments. */
const isChatSeat = (role: Pick<RoleConfig, 'seat'>): boolean => role.seat === 'corner' || role.seat === 'podium';

/** What a role may call without asking: its own list, plus the tools that only write to the office's own records. */
export const roleAllow = (role: Pick<RoleConfig, 'autoAllow'>): string[] => [...role.autoAllow, RECORD_TOOL];

/** Exact tool name, or a server-level rule like "mcp__office" that covers every "mcp__office__*" tool. */
export function isAutoAllowed(rules: Iterable<string>, toolName: string): boolean {
  for (const r of rules) if (r === toolName || toolName.startsWith(r + '__')) return true;
  return false;
}

// anything that could chain, substitute or redirect a second command
const SHELL_META = /[;&|`<>\n\r]|\$\(/;

/**
 * Like isAutoAllowed, plus `Bash(<prefix>*)`: a Bash command that starts with <prefix>
 * and contains no shell metacharacters (so "<prefix> ; rm -rf ~" is not covered).
 */
export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = rule.match(/^Bash\((.+)\*\)$/s);
  if (m) {
    if (toolName !== 'Bash') return false;
    const cmd = String(input?.command ?? '').trim();
    return cmd.startsWith(m[1]) && !SHELL_META.test(cmd);
  }
  if (rule.includes('(')) return false; // other parenthesised forms are not supported
  return isAutoAllowed([rule], toolName);
}

/** Tools that reach a lab server: remote job control, or a shell command that opens an ssh/scp session. */
const LAB_TOOLS = new Set(['mcp__lab__submit_job', 'mcp__lab__cancel_job', 'mcp__lab__fetch_results']);
// a command word (start, after a separator, or inside $( ), with or without a path), slightly over-broad on purpose
const REMOTE_CMD = /(?:^|[\s;&|(]|\$\()\s*(?:[\w./-]*\/)?(?:ssh|scp|rsync|sftp|sshfs)\b/;

/**
 * Does this call reach a lab server *somewhere else*? Those always get a manager approval card,
 * even in auto mode: an agent reading papers off the web should never be one classifier call away
 * from running arbitrary commands on a shared machine.
 *
 * A job aimed at a server whose `ssh_host` is `local` is not that — it runs on the machine the
 * backend already sits on, over no network, and is no more dangerous than the Bash the agent can
 * already run there. `isRemoteServer` tells us which is which (unknown server → treat as remote).
 */
export function needsLabApproval(
  toolName: string,
  input: Record<string, unknown>,
  isRemoteServer: (name: string) => boolean = () => true,
): boolean {
  if (LAB_TOOLS.has(toolName)) {
    const server = typeof input?.server === 'string' ? input.server : '';
    return !server || isRemoteServer(server);
  }
  if (toolName !== 'Bash') return false;
  return REMOTE_CMD.test(String(input?.command ?? '')); // ssh/scp are remote by definition
}

/**
 * Which machine's transcript store holds a session. A session started without a `host` lives on the
 * machine the backend runs on, so it must be tagged with that machine — otherwise moving the backend
 * (mac → desktop) would look like "same host" and the resume would fail with "No conversation found".
 */
export const sessionHostId = (roleHost: string | undefined, backend = hostname()) => roleHost ?? `backend:${backend}`;
const codexThreadKey = (role: RoleConfig) => `codex-thread:${role.id}:${sessionHostId(role.host)}`;

/**
 * Decide what the per-minute budget says about a shell command the agent wants to run.
 * The slot is taken when the call is *attempted*, not when it succeeds — a denied approval still
 * costs one. Over-counting is the safe direction here: the point is to never flood a server.
 */
export function sshBudgetVerdict(command: string, throttle = sshThrottle, now = Date.now()): { host: string; waitSec: number } | null {
  const host = SshThrottle.targetOf(command);
  if (!host) return null; // can't tell where it goes — don't block it
  if (throttle.allow(host, now)) return null;
  return { host, waitSec: Math.ceil(throttle.waitMs(host, now) / 1000) };
}

/** A 🔒 task always asks; otherwise the employee's own setting. Only ever tightens. */
export function effectivePermission(employee: PermissionSetting, requireApproval: boolean): PermissionSetting {
  return requireApproval ? 'ask' : employee;
}

/** Codex asks only after its own sandbox check; auto mode handles routine requests here. */
export function codexAutoApproval(method: string, input: Record<string, unknown>, mode: PermissionSetting, autoAllow: string[], extraAllow: string[]): boolean {
  if (mode !== 'auto') return false;
  if (method === 'item/fileChange/requestApproval') {
    return !input.grantRoot && (isAutoAllowed(autoAllow, 'Edit') || isAutoAllowed(autoAllow, 'Write') || extraAllow.some((r) => matchesRule(r, 'Edit', input)));
  }
  if (method !== 'item/commandExecution/requestApproval') return false;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command || needsLabApproval('Bash', { command })) return false;
  // Explicit filesystem grants and commands that alter machine or Git state still need a card.
  if (input.additionalPermissions || /\b(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot)\b|\bgit\s+(?:reset|clean|push|force-push)\b/.test(command)) return false;
  return true;
}

/**
 * Index of the next waiting employee that may start, or -1. Claude employees share the subscription limit
 * (maxConcurrent, FIFO); employees on a provider bypass it and get one slot per provider (one GPU each).
 */
export function nextRunnable(waiting: { provider?: string }[], running: number, maxConcurrent: number, busyProviders: ReadonlySet<string>): number {
  return waiting.findIndex((w) => (w.provider ? !busyProviders.has(w.provider) : running < maxConcurrent));
}

/** Runs each employee as a Claude Agent SDK session, with a global concurrency limit. */
export class AgentManager {
  private emps = new Map<string, Employee>();
  private waiting: Employee[] = []; // FIFO of employees waiting for a slot
  private running = 0; // Claude (subscription) runs only
  private busyProviders = new Set<string>();
  /** set by index.ts; needed for employees with officeTools */
  officeApi: OfficeApi | null = null;
  /** local plugins loaded into every session (the office skills plugin); set by index.ts */
  pluginDirs: string[] = [];
  /** swapped out in tests */
  queryFn: typeof query = query;
  /** extra readable folders for every session (the attachments store); set by index.ts */
  extraDirs: string[] = [];
  /** non-Claude backends; set by index.ts */
  providers: ProviderHub | null = null;
  /** machines sessions can run on; set by index.ts */
  hosts: HostRegistry | null = null;

  constructor(
    private office: OfficeConfig,
    roles: RoleConfig[],
    private store: Store,
    private broker: PermissionBroker,
    private registry: ServerRegistry,
  ) {
    for (const r of roles) {
      const s = store.getSession(r.id);
      const e = new Employee(r, s.sessionId, s.costUsd, store.getEmployeePerm(r.id) ?? r.permissionMode ?? office.permissionMode);
      e.view.engine = store.getSetting(`engine:${r.id}`) === 'codex' ? 'codex' : 'claude';
      if (e.view.engine === 'codex') e.view.sessionId = store.getSetting(codexThreadKey(r));
      e.sessionHost = s.hostId;
      e.view.name = store.getEmployeeName(r.id) ?? r.name;
      this.emps.set(r.id, e);
    }
  }

  views(): EmployeeView[] {
    return [...this.emps.values()].map((e) => e.view);
  }

  /**
   * Add an employee at runtime (a project session). The role is synthesised, not read from
   * roles.yaml, but everything downstream — live sessions, approvals, logs, feed — keys off the id.
   */
  addWorker(role: RoleConfig): EmployeeView {
    const existing = this.emps.get(role.id);
    if (existing) return existing.view;
    const s = this.store.getSession(role.id);
    const e = new Employee(role, s.sessionId, s.costUsd, this.store.getEmployeePerm(role.id) ?? role.permissionMode ?? this.office.permissionMode);
    e.view.engine = this.store.getSetting(`engine:${role.id}`) === 'codex' ? 'codex' : 'claude';
    if (e.view.engine === 'codex') e.view.sessionId = this.store.getSetting(codexThreadKey(role));
    e.sessionHost = s.hostId;
    e.view.name = this.store.getEmployeeName(role.id) ?? role.name;
    this.emps.set(role.id, e);
    this.sendView(e);
    return e.view;
  }

  /** Change how a runtime employee is presented (desk, name, look) without touching its session. */
  updateWorker(id: string, patch: Partial<Pick<RoleConfig, 'desk' | 'name' | 'sprite' | 'title'>>) {
    const e = this.emps.get(id);
    if (!e) return;
    Object.assign(e.role, patch);
    if (patch.desk !== undefined) e.view.desk = patch.desk;
    if (patch.sprite) e.view.sprite = patch.sprite;
    if (patch.title) e.view.title = patch.title;
    if (patch.name && !this.store.getEmployeeName(id)) e.view.name = patch.name;
    this.sendView(e);
  }

  /** Remove a runtime employee: stop the turn, close the session, drop it from the office. */
  removeWorker(id: string) {
    const e = this.emps.get(id);
    if (!e) return;
    this.stop(id);
    this.closeSession(e);
    this.emps.delete(id);
    this.waiting = this.waiting.filter((w) => w !== e);
    bus.send({ t: 'employeeGone', id });
  }
  runningCount() {
    return this.running;
  }
  has(id: string) {
    return this.emps.has(id);
  }

  private emp(id: string): Employee {
    const e = this.emps.get(id);
    if (!e) throw new Error(`unknown employee ${id}`);
    return e;
  }

  /** waiting with the session open means sitting at the desk; closed means off to the lounge */
  private idleActivity(e: Employee) {
    return e.live ? tr({ ko: '💺 자리에서 대기 중', en: '💺 Waiting at the desk' }) : tr({ ko: '☕ 대기 중', en: '☕ Idle' });
  }

  /** Rewrite idle bubbles in the new language (other statuses are replaced by the next event anyway). */
  relabelIdle() {
    for (const e of this.emps.values()) if (!e.current && e.view.status === 'idle') e.view.activity = this.idleActivity(e);
  }

  /** Who is mid-turn and how many wait for a slot: a restart now would cut them off (`npm run update` asks). */
  busy() {
    const working = [...this.emps.values()].filter((e) => e.current).map((e) => ({ id: e.role.id, name: e.view.name }));
    return { working, queued: this.waiting.length };
  }

  /** push the current view to the browsers (status unchanged) */
  private sendView(e: Employee) {
    e.view.live = !!e.live || !!e.codexTurn;
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  private set(e: Employee, status: AgentStatus, activity?: string) {
    e.view.live = !!e.live || !!e.codexTurn;
    e.view.status = status;
    if (activity !== undefined) e.view.activity = activity;
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  /** Transcripts live on the machine that ran them, so a session id does not travel between hosts. */
  private static readonly NO_SESSION = /No conversation found with session ID/i;
  /** the CLI reports the limit as plain text too, e.g. "You've hit your 5-hour limit · resets 4:10am" */
  private static readonly RATE_LIMIT = /rate_limit|hit your .*limit|usage limit/i;

  /** `engine` defaults to the engine running now (a task's override, else the employee's own) */
  private log(e: Employee, kind: LogLine['kind'], text: string, engine?: Engine) {
    if (kind === 'error' && AgentManager.NO_SESSION.test(text)) e.resumeMissing = true;
    if (kind === 'error' && AgentManager.RATE_LIMIT.test(text)) e.rateLimitedUntil ??= Date.now() + LIMIT_FALLBACK_MS;
    if (kind === 'error') e.lastError = text;
    const line: LogLine = { employeeId: e.role.id, ts: Date.now(), kind, text, engine: engine ?? e.view.turnEngine ?? e.view.engine };
    this.store.addLog(line);
    bus.send({ t: 'log', data: line });
  }

  /** Give an employee an instruction. Queued if they're busy or the office is at capacity. */
  instruct(
    employeeId: string,
    text: string,
    taskId: number | null = null,
    opts: { extraAllow?: string[]; label?: string; requireApproval?: boolean; attachmentPaths?: string[]; engine?: Engine | null } = {},
  ) {
    const e = this.emp(employeeId);
    const label = opts.label ?? `💬 ${clip(text.split('\n').find((l) => l.trim())?.trim() ?? '', 40)}`;
    // the turn hasn't started, so say which conversation this instruction goes to
    const engine = opts.engine && !e.role.provider ? opts.engine : e.view.engine;
    this.log(e, 'user', taskId ? `${tr({ ko: `[작업 #${taskId}]`, en: `[Task #${taskId}]` })} ${text}` : text, engine);
    this.enqueue(e, { text, taskId, extraAllow: opts.extraAllow ?? [], label, requireApproval: !!opts.requireApproval, attachmentPaths: opts.attachmentPaths ?? [], engine: opts.engine ?? undefined });
  }

  /** Add work to an employee's inbox (`front` = before anything already waiting) and let the queue run. */
  private enqueue(e: Employee, work: Work, front = false) {
    if (front) e.inbox.unshift(work);
    else e.inbox.push(work);
    if (!e.current && !this.waiting.includes(e)) {
      this.waiting.push(e);
      this.set(e, 'queued', tr({ ko: '⏳ 자리 나길 기다리는 중', en: '⏳ Waiting for a free slot' }));
    }
    this.pump();
  }

  /** The topic of the task this employee is on right now, if any. */
  private topicNow(e: Employee): string | null {
    const id = e.current?.taskId;
    return id != null ? (this.store.getTask(id)?.topic ?? null) : null;
  }

  /** Mark a task card that is in 'doing' with nobody working on it, and tell the browsers. */
  private haltTask(taskId: number, halt: TaskHalt, error: string | null = null) {
    const t = this.store.getTask(taskId);
    if (!t || t.state !== 'doing') return;
    const n = this.store.updateTask(taskId, { halt, error });
    if (n) bus.send({ t: 'task', data: n });
  }

  /**
   * After a run, whichever way it ended: a task that is still 'doing' did not finish. Say why on the card
   * (failed with the last error line, or stopped by the manager) so it can be started again. Work parked on
   * the usage limit resumes by itself, and a card already queued again is left alone.
   */
  private settleTask(e: Employee, work: Work) {
    if (work.taskId == null || e.parked?.work === work || e.inbox.some((w) => w.taskId === work.taskId)) return;
    const t = this.store.getTask(work.taskId);
    if (!t || t.state !== 'doing' || t.assignee !== e.role.id) return;
    if (e.stopRequested) this.haltTask(t.id, 'stopped');
    else this.haltTask(t.id, 'failed', clipError(e.lastError) || null);
  }

  private pump() {
    for (;;) {
      const i = nextRunnable(this.waiting.map((w) => ({ provider: w.role.provider })), this.running, this.office.maxConcurrent, this.busyProviders);
      if (i < 0) break;
      const [e] = this.waiting.splice(i, 1);
      const work = e.inbox.shift();
      if (!work) continue;
      const provider = e.role.provider;
      if (provider) this.busyProviders.add(provider);
      else this.running++;
      void this.run(e, work).catch((err) => {
        this.log(e, 'error', String((err as Error).message ?? err));
        this.set(e, 'error', tr({ ko: '⚠️ 실행 실패', en: '⚠️ Run failed' }));
      }).finally(() => {
        if (provider) this.busyProviders.delete(provider);
        else this.running--;
        this.settleTask(e, work);
        e.current = null;
        if (e.inbox.length) this.waiting.push(e);
        this.pump();
      });
    }
  }

  /** Stop the current turn but keep the session open, so the next instruction is still warm. */
  stop(employeeId: string) {
    const e = this.emp(employeeId);
    // task cards that were queued or parked never ran to an end of their own: mark them, or they look in progress forever
    const dropped = e.inbox;
    e.inbox = [];
    const parked = this.unpark(e);
    for (const w of parked ? [...dropped, parked] : dropped) if (w.taskId != null && w !== e.current) this.haltTask(w.taskId, 'stopped');
    if (e.current) e.stopRequested = true;
    if (parked) this.log(e, 'system', tr({ ko: '⏹ 예약된 재개를 취소했습니다', en: '⏹ Cancelled the scheduled resume' }));
    this.waiting = this.waiting.filter((w) => w !== e);
    this.broker.cancelFor(employeeId);
    if (e.codexTurn) {
      e.codexStopped = true;
      e.codexTurn.stop();
      this.log(e, 'system', tr({ ko: '⏹ 중지됨', en: '⏹ Stopped' }));
      this.set(e, 'idle', tr({ ko: '☕ 대기 중', en: '☕ Idle' }));
      return;
    }
    const live = e.live;
    if (!live || !e.current) {
      if (!e.current) this.set(e, 'idle', this.idleActivity(e));
      return;
    }
    this.log(e, 'system', tr({ ko: '⏹ 중지됨', en: '⏹ Stopped' }));
    const ended = e.endTurn;
    void live.q
      .interrupt()
      .catch(() => {
        // the CLI didn't take the interrupt: drop the session rather than leave a wedged turn
        live.abort.abort();
        this.closeSession(e);
      })
      .finally(() => setTimeout(() => ended?.(), 3_000)); // if no `result` follows, release the turn anyway
  }

  /** Rename from the UI: replaces the quoted nickname in the configured name (Researcher "Alan" → Researcher "Bo"). */
  rename(employeeId: string, nick: string) {
    const e = this.emp(employeeId);
    const n = nick.replace(/["“”]/g, '').trim().slice(0, 20);
    const name = !n ? e.role.name : /"[^"]*"/.test(e.role.name) ? e.role.name.replace(/"[^"]*"/, `"${n}"`) : n;
    this.store.setEmployeeName(e.role.id, n ? name : null);
    e.view.name = name;
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  /** UI toggle; applies from the next run (a running session keeps its mode) */
  setPermission(employeeId: string, mode: PermissionSetting) {
    const e = this.emp(employeeId);
    if (mode !== 'auto' && mode !== 'ask') throw new Error(tr({ ko: `잘못된 권한 모드: ${mode}`, en: `Invalid permission mode: ${mode}` }));
    this.store.setEmployeePerm(e.role.id, mode);
    e.view.permission = mode;
    this.log(
      e,
      'system',
      mode === 'auto'
        ? tr({ ko: '🤖 자동 모드로 전환 (다음 지시부터)', en: '🤖 Switched to auto mode (from the next instruction)' })
        : tr({ ko: '✋ 승인 모드로 전환 (다음 지시부터)', en: '✋ Switched to approval mode (from the next instruction)' }),
    );
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  setEngine(employeeId: string, engine: 'claude' | 'codex') {
    const e = this.emp(employeeId);
    if (e.current || e.inbox.length || this.waiting.includes(e)) throw new Error(tr({ ko: '작업이 끝난 뒤 실행기를 전환하세요.', en: 'Switch engines after the current work finishes.' }));
    if (e.role.provider && engine === 'codex') throw new Error(tr({ ko: 'Ollama 직원은 Codex로 전환할 수 없습니다.', en: 'An Ollama employee cannot switch to Codex.' }));
    if (e.view.engine === engine) return;
    this.closeSession(e);
    e.view.engine = engine;
    e.view.sessionId = engine === 'codex' ? this.store.getSetting(codexThreadKey(e.role)) : this.store.getSession(employeeId).sessionId;
    this.store.setSetting(`engine:${employeeId}`, engine);
    this.sendView(e);
  }

  resetSession(employeeId: string) {
    const e = this.emp(employeeId);
    this.stop(employeeId);
    this.closeSession(e);
    e.view.sessionId = null;
    if (e.view.engine === 'codex') this.store.setSetting(codexThreadKey(e.role), '');
    else this.store.saveSession(e.role.id, null, e.view.costUsd, e.view.cwd);
    this.log(e, 'system', tr({ ko: '새 대화 세션으로 초기화됨', en: 'Reset to a new conversation session' }));
    this.set(e, 'idle', tr({ ko: '☕ 새 마음으로 대기 중', en: '☕ Idle, with a fresh start' }));
  }

  /** Open (or reuse) the employee's long-lived session. Throws with a manager-readable message. */
  private openSession(e: Employee): LiveSession {
    if (e.live) return e.live;

    // A remote host's filesystem is not ours: the folder is checked there (see checkHost), not created here.
    const host = e.role.host ? this.hosts?.get(e.role.host) : undefined;
    if (e.role.host && !host) throw new Error(
        tr({
          ko: `설정에 없는 host: ${e.role.host} (office.local.yaml 의 hosts 확인)`,
          en: `Host not in config: ${e.role.host} (check hosts in office.local.yaml)`,
        }),
      );
    if (host && !host.view.ok) throw new Error(
        tr({
          ko: `${host.view.name}에 연결할 수 없음: ${host.view.error ?? '알 수 없음'}`,
          en: `Cannot reach ${host.view.name}: ${host.view.error ?? 'unknown'}`,
        }),
      );
    const cwd = host && !host.isLocal ? (e.role.cwd ?? '.') : ensureWorkspace(this.office, e.role); // throws → caller reports
    e.view.cwd = cwd;

    const lang = getLang();
    const autoAllow = new Set(roleAllow(e.role));
    const mcpServers: Record<string, any> = {};
    // no GPU servers configured → no lab tools, so agents aren't offered jobs on machines that don't exist
    // with no GPU servers this is only record_result (the experiment table), which a chat character has no use for
    if (this.registry.list().length || !isChatSeat(e.role)) mcpServers.lab = labToolsServer(e.role.id, cwd, this.registry, this.store, () => this.topicNow(e));
    if (e.role.officeTools && this.officeApi) mcpServers.office = officeToolsServer(e.role.id, this.officeApi);

    let model = e.role.model || this.office.model || undefined;
    let env: Record<string, string> | undefined;
    let providerModel: string | null = null;
    if (e.role.provider) {
      const link = this.providers?.get(e.role.provider);
      const rt = link ? link.runtime() : {
            error: tr({
              ko: `설정에 없는 provider: ${e.role.provider} (office.local.yaml 의 providers 확인)`,
              en: `Provider not in config: ${e.role.provider} (check providers in office.local.yaml)`,
            }),
          };
      if ('error' in rt) throw new Error(`🖥 ${rt.error}`);
      ({ model, env } = rt);
      providerModel = rt.model;
    }

    // the current work changes every turn, so the callbacks read e.current instead of closing over one Work
    const extraAllowNow = () => e.current?.extraAllow ?? [];
    // A session id only means something on the machine that recorded it.
    const hostId = sessionHostId(e.role.host);
    if (e.view.sessionId && (e.sessionHost ?? null) !== hostId) {
      this.log(e, 'system', tr({
          ko: `이전 대화는 다른 머신(${e.sessionHost ?? '알 수 없음'})의 기록이라 여기서는 새 세션으로 시작합니다`,
          en: `The previous conversation was recorded on another machine (${e.sessionHost ?? 'unknown'}), so this starts a new session here`,
        }));
      e.view.sessionId = null;
      this.store.saveSession(e.role.id, null, e.view.costUsd, e.view.cwd, hostId);
    }

    const perm = effectivePermission(e.view.permission, e.current?.requireApproval ?? false);
    const abort = new AbortController();
    const input = new MessageQueue();

    const q = this.queryFn({
      prompt: input,
      options: {
        cwd,
        // attachments live on the backend's disk, so a remote session cannot read them
        additionalDirectories: host && !host.isLocal ? [] : this.extraDirs,
        spawnClaudeCodeProcess: host?.spawner(),
        model,
        env,
        abortController: abort,
        resume: e.view.sessionId ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: `${e.role.systemPrompt}\n\n${reportLanguageLine(lang)}` },
        // No `allowedTools`: a bare name there auto-approves before canUseTool and before the hook,
        // which both hides the call from our guard and makes the SDK warn. The hook below is the
        // single gate instead — it allows the whitelist itself.
        permissionMode: perm === 'auto' ? 'auto' : 'default',
        hooks: {
          // Runs before the auto-mode classifier: force a card for anything touching a lab server,
          // unless the manager put that exact tool/command in autoAllow or an approved skill's office-allow.
          PreToolUse: [
            {
              onFailure: 'block',
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
                  const name = hookInput.tool_name;
                  const inp = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  const decide = (permissionDecision: 'allow' | 'ask' | 'deny', permissionDecisionReason: string) => ({
                    continue: true,
                    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason },
                  });
                  const whitelisted = isAutoAllowed(autoAllow, name) || extraAllowNow().some((r) => matchesRule(r, name, inp));
                  if (needsLabApproval(name, inp, (s) => this.registry.isRemote(s))) {
                    // Count it against the server's budget even when the manager would be asked:
                    // a flood of approved ssh calls is exactly what gets us banned.
                    if (name === 'Bash') {
                      const over = sshBudgetVerdict(String(inp.command ?? ''));
                      if (over) {
                        this.hosts?.refreshUsage();
                        return decide(
                          'deny',
                          tr({
                            ko: `${over.host} 접속이 분당 한도를 넘어 막았습니다. ${over.waitSec}초 뒤에 다시 시도하거나, 여러 명령을 한 번의 접속으로 묶으세요.`,
                            en: `Blocked: connections to ${over.host} are over the per-minute limit. Retry in ${over.waitSec}s, or combine several commands into one connection.`,
                          }),
                        );
                      }
                      this.hosts?.refreshUsage();
                    }
                    // anything reaching a lab server asks, unless the manager named that exact tool/command
                    if (!whitelisted) return decide('ask', tr({ ko: '랩 서버에 접근하는 작업이라 매니저 승인이 필요합니다.', en: 'This reaches a lab server, so it needs the manager\'s approval.' }));
                  }
                  if (whitelisted) return decide('allow', tr({ ko: '매니저가 허용한 도구입니다.', en: 'The manager has allowed this tool.' }));
                  return { continue: true }; // auto-mode classifier, then canUseTool
                },
              ],
            },
          ],
        },
        mcpServers,
        // provider employees skip the office skills plugin to save the (small) local context
        plugins: (e.role.provider ? [] : this.pluginDirs).map((path) => ({ type: 'local' as const, path })),
        canUseTool: async (toolName, input, { signal }) => {
          if (isAutoAllowed(autoAllow, toolName)) return { behavior: 'allow', updatedInput: input };
          if (extraAllowNow().some((r) => matchesRule(r, toolName, input))) {
            this.log(e, 'system', tr({
                ko: `🔓 스킬 권한으로 자동 허용: ${describeToolCall(toolName, input as any)}`,
                en: `🔓 Auto-allowed by skill permission: ${describeToolCall(toolName, input as any)}`,
              }));
            return { behavior: 'allow', updatedInput: input };
          }
          const prev = { status: e.view.status, activity: e.view.activity };
          const call = describeToolCall(toolName, input as any);
          this.set(e, 'waiting_permission', tr({ ko: `✋ 승인 필요: ${call.slice(0, 50)}`, en: `✋ Needs approval: ${call.slice(0, 50)}` }));
          this.log(e, 'system', tr({ ko: `승인 요청: ${call}`, en: `Approval requested: ${call}` }));
          const res = await this.broker.request(e.role.id, toolName, input, signal);
          this.log(e, 'system', res.behavior === 'allow' ? tr({ ko: '✅ 승인됨', en: '✅ Approved' }) : tr({ ko: '❌ 거부됨', en: '❌ Denied' }));
          this.set(e, prev.status, prev.activity);
          return res;
        },
      },
    });

    const live: LiveSession = { q, input, abort, cwd, perm, providerModel, lang, lastCost: e.view.sessionId ? null : 0, done: Promise.resolve() };
    e.live = live;
    live.done = this.consume(e, live);
    this.sendView(e);
    return live;
  }

  /** Drain the session's messages until it ends; each `result` closes one turn. */
  private async consume(e: Employee, live: LiveSession): Promise<void> {
    try {
      for await (const m of live.q) this.handle(e, m);
    } catch (err) {
      if (!live.abort.signal.aborted) {
        this.log(e, 'error', String((err as Error).message ?? err));
        this.set(e, 'error', tr({ ko: '⚠️ 오류 발생 (로그 확인)', en: '⚠️ Error (see the log)' }));
      }
    } finally {
      if (e.live === live) {
        e.live = null;
        this.sendView(e);
      }
      e.endTurn?.(); // the session died mid-turn; let run() finish up
    }
  }

  /** Close the session (the conversation is kept: the next instruction resumes it). */
  private closeSession(e: Employee, why?: string) {
    const live = e.live;
    if (!live) return;
    e.live = null;
    if (e.idleTimer) clearTimeout(e.idleTimer);
    e.idleTimer = null;
    live.input.close();
    live.q.close();
    if (why) this.log(e, 'system', why);
    if (!e.current && e.view.status === 'idle') this.set(e, 'idle', this.idleActivity(e));
    else this.sendView(e);
  }

  /** Close sessions that were opened against this provider, so a model change takes effect. */
  reopenProviderSessions(providerId: string) {
    for (const e of this.emps.values()) {
      if (e.role.provider !== providerId || !e.live) continue;
      const wanted = this.providers?.get(providerId)?.view.model ?? null;
      if (e.live.providerModel === wanted) continue;
      if (e.current) continue; // mid-turn: the idle timer or the next open will pick the new model up
      this.closeSession(
        e,
        tr({
          ko: `🖥 모델이 ${wanted}(으)로 바뀌어 세션을 다시 엽니다 (다음 지시부터)`,
          en: `🖥 Model changed to ${wanted}; reopening the session (from the next instruction)`,
        }),
      );
    }
  }

  /**
   * Hold a piece of work until `at`, then put it back at the front of the inbox. Used when the
   * subscription window is spent — the employee says when it will resume rather than looking stuck.
   */
  private park(e: Employee, work: Work, at: number) {
    this.unpark(e);
    const when = hhmm(at);
    const timer = setTimeout(() => {
      const w = this.unpark(e);
      if (w) this.requeue(
          e,
          w,
          tr({ ko: '⏰ 사용량이 초기화되어 하던 일을 이어서 합니다', en: '⏰ Usage has reset; picking the work back up' }),
          '[Auto-resume] This work stopped on the usage limit.',
        );
    }, at - Date.now());
    e.parked = { work, timer };
    e.view.parkedUntil = at;
    this.log(e, 'system', tr({ ko: `⏸ 사용량 한도로 중단 — ${when}에 자동으로 이어서 합니다`, en: `⏸ Stopped on the usage limit — resumes automatically at ${when}` }));
    this.set(e, 'error', tr({ ko: `⏸ 사용량 한도 · ${when} 재개 예정`, en: `⏸ Usage limit · resumes at ${when}` }));
    this.closeSession(e);
  }

  /** Drop the parked slot and its timer; returns the work that was parked, if any. */
  private unpark(e: Employee): Work | undefined {
    const p = e.parked;
    if (!p) return undefined;
    clearTimeout(p.timer);
    e.parked = null;
    e.view.parkedUntil = undefined;
    return p.work;
  }

  /** Put interrupted work back at the front of the queue, telling the agent not to redo what it did. */
  private requeue(e: Employee, work: Work, logText: string, note: string) {
    this.log(e, 'system', logText);
    this.enqueue(e, { ...work, text: `${work.text}\n\n${note} Don't redo what you already finished; pick up where you left off and complete it.` }, true);
  }

  /** Put a parked employee back to work right now, without waiting for the reset. */
  resumeNow(employeeId: string): boolean {
    const e = this.emp(employeeId);
    const work = this.unpark(e);
    if (!work) return false;
    this.requeue(
      e,
      work,
      tr({ ko: '▶️ 매니저가 중단된 작업을 다시 시작했습니다', en: '▶️ The manager restarted the interrupted work' }),
      '[Resumed] This work was interrupted.',
    );
    return true;
  }

  private armIdleTimer(e: Employee) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const ms = this.office.sessionIdleMinutes * 60_000;
    if (ms <= 0) return;
    e.idleTimer = setTimeout(() => {
      if (!e.current && e.live) this.closeSession(
          e,
          tr({
            ko: `💤 ${this.office.sessionIdleMinutes}분 동안 일이 없어 세션을 닫았습니다 (다음 지시 때 이어서 엶)`,
            en: `💤 Closed the session after ${this.office.sessionIdleMinutes} min without work (reopens with the next instruction)`,
          }),
        );
    }, ms);
  }

  /** Send one instruction into the employee's session and wait for that turn to finish. */
  private async runCodex(e: Employee, work: Work): Promise<void> {
    const host = e.role.host ? this.hosts?.get(e.role.host) : undefined;
    if (e.role.host && (!host || !host.view.ok)) {
      this.log(e, 'error', tr({ ko: 'Codex 실행 host에 연결할 수 없습니다.', en: 'The Codex host is unavailable.' }));
      this.set(e, 'error');
      return;
    }
    const cwd = host && !host.isLocal
      ? host.expand(e.role.cwd?.startsWith('/') || e.role.cwd?.startsWith('~') ? e.role.cwd : `${host.cfg.projectRoot}/${e.role.cwd || '.'}`)
      : ensureWorkspace(this.office, e.role);
    e.view.cwd = cwd;
    let turn: CodexTurn | null = null;
    const tools = new CodexTools();
    e.codexStopped = false;
    const codexPermission = effectivePermission(e.view.permission, work.requireApproval);
    const skillName = work.text.match(/office:([a-z0-9-]+)/)?.[1];
    const skillPath = skillName ? resolve(ROOT, 'workspaces/office-skills/skills', skillName, 'SKILL.md') : '';
    const skillText = skillPath && existsSync(skillPath) ? `\n\nOffice skill office:${skillName}:\n${readFileSync(skillPath, 'utf8')}` : '';
    let prompt = `${e.role.systemPrompt}\n\n${reportLanguageLine(getLang())}\nThe office MCP names mcp__office__X and mcp__lab__X appear here as office.X and lab.X. Use those tools with the same approval rules.\n\nCurrent instruction:\n${work.text}${skillText}`;
    try {
      if (host && !host.isLocal) prompt = await stageCodexAttachments(host.cfg, prompt, work.attachmentPaths);
      if (this.registry.list().length || !isChatSeat(e.role)) await tools.add('lab', labToolsServer(e.role.id, cwd, this.registry, this.store, () => this.topicNow(e)).instance);
      if (e.role.officeTools && this.officeApi) await tools.add('office', officeToolsServer(e.role.id, this.officeApi).instance);
      const callTool = async (namespace: string, tool: string, args: Record<string, unknown>) => {
        const name = `mcp__${namespace}__${tool}`;
        const readOnly = new Set(['mcp__lab__list_servers', 'mcp__lab__gpu_status', 'mcp__lab__job_status', 'mcp__lab__tail_log', 'mcp__office__office_status', 'mcp__office__list_tasks', 'mcp__office__office_activity', 'mcp__office__list_routines', 'mcp__office__list_skills']);
        const allowed = isAutoAllowed(roleAllow(e.role), name) || work.extraAllow.some((rule) => matchesRule(rule, name, args));
        if (!allowed && (!readOnly.has(name) || codexPermission === 'ask')) {
          const decision = await this.broker.request(e.role.id, name, args, new AbortController().signal);
          if (decision.behavior !== 'allow') throw new Error(decision.message || 'Manager denied the tool call');
        }
        return tools.call(namespace, tool, args);
      };
      const autoApprove = (method: string, input: Record<string, unknown>) => codexAutoApproval(method, input, codexPermission, roleAllow(e.role), work.extraAllow);
      turn = new CodexTurn(e.role.id, this.broker, tools, callTool, autoApprove, host?.cfg);
      e.codexTurn = turn;
      this.sendView(e);
      const result = await turn.start(cwd, prompt, e.view.sessionId, (method, params) => {
        const item = params.item;
        if (method === 'approval/requested') {
          this.set(e, 'waiting_permission', tr({ ko: '✋ 승인 대기', en: '✋ Awaiting approval' }));
        } else if (method === 'approval/resolved') {
          this.set(e, 'thinking', tr({ ko: '💭 작업 계속 중', en: '💭 Continuing work' }));
        } else if (method === 'item/started' && item?.type === 'commandExecution') {
          this.log(e, 'tool', item.command ?? 'Command');
          this.set(e, 'running', `⚙️ ${clip(item.command ?? 'Command', 55)}`);
        } else if (method === 'item/started' && item?.type === 'fileChange') {
          this.log(e, 'tool', 'File change');
          this.set(e, 'typing', tr({ ko: '✏️ 파일 수정 중', en: '✏️ Editing files' }));
        } else if (method === 'item/completed' && item?.type === 'agentMessage' && item.text) {
          e.lastText = item.text;
          this.log(e, 'assistant', item.text);
          this.set(e, 'thinking', `💬 ${clip(item.text.replace(/\s+/g, ' '), 55)}`);
        }
      }, codexPermission === 'ask');
      if (e.codexStopped || result.status === 'interrupted') {
        this.set(e, 'idle', tr({ ko: '☕ 대기 중', en: '☕ Idle' }));
        return;
      }
      e.lastText = result.text || e.lastText;
      const ok = result.status === 'completed';
      if (ok) {
        e.view.sessionId = result.threadId;
        this.store.setSetting(codexThreadKey(e.role), result.threadId);
      }
      const failure = result.error || result.status;
      this.log(e, ok ? 'result' : 'error', ok ? tr({ ko: 'Codex 작업 완료', en: 'Codex turn completed' }) : `Codex: ${failure}`);
      this.set(e, ok ? 'done' : 'error', ok ? tr({ ko: '✅ 완료', en: '✅ Done' }) : `⚠️ ${clip(failure, 55)}`);
      bus.emit('runFinished', { employeeId: e.role.id, label: work.label, text: e.lastText, ok, taskId: work.taskId, error: ok ? undefined : clipError(e.lastError) || undefined } satisfies RunFinished);
      if (work.taskId != null) {
        const task = this.store.updateTask(work.taskId, ok ? { state: 'review', result: e.lastText || null } : { result: e.lastText || null });
        if (task) bus.send({ t: 'task', data: task });
      }
    } catch (err) {
      turn?.stop();
      if (!e.codexStopped) {
        this.log(e, 'error', String((err as Error).message ?? err));
        this.set(e, 'error', tr({ ko: '⚠️ Codex 실행 실패', en: '⚠️ Codex failed' }));
      }
    } finally {
      e.codexTurn = null;
      await tools.close();
      this.sendView(e);
    }
  }

  /** Send one instruction into the employee's session and wait for that turn to finish. */
  private async run(e: Employee, work: Work): Promise<void> {
    e.current = work;
    e.view.taskId = work.taskId;
    e.lastText = '';
    e.lastError = '';
    e.apiFailed = false;
    e.stopRequested = false;
    this.set(e, 'thinking', tr({ ko: '💭 업무 파악 중', en: '💭 Getting up to speed' }));
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const engine = this.turnEngine(e, work);
    if (engine !== e.view.engine) return this.runOverride(e, work, engine);
    if (engine === 'codex') return this.runCodex(e, work);
    return this.runClaude(e, work);
  }

  /** The engine for this turn: the task's override, except that an Ollama (provider) employee can't run Codex. */
  private turnEngine(e: Employee, work: Work): Engine {
    if (!work.engine || work.engine === e.view.engine) return e.view.engine;
    if (e.role.provider) {
      this.log(e, 'system', tr({ ko: '이 직원은 로컬 모델이라 지정된 실행기 대신 기본으로 실행합니다', en: 'This employee runs on a local model, so the requested engine is ignored' }));
      return e.view.engine;
    }
    return work.engine;
  }

  /**
   * One turn on the other engine. Each engine keeps its own conversation (Claude: `sessions`, Codex: the
   * thread setting), and both run paths read and write `e.view.sessionId`, so swap in that engine's id for
   * the turn and put the default's back afterwards — the employee's own engine and conversation are untouched.
   */
  private async runOverride(e: Employee, work: Work, engine: Engine): Promise<void> {
    this.log(e, 'system', engine === 'codex' ? tr({ ko: '🔀 Codex로 실행 (이 작업만)', en: '🔀 Running on Codex (this task only)' }) : tr({ ko: '🔀 Claude로 실행 (이 작업만)', en: '🔀 Running on Claude (this task only)' }));
    const saved = { sessionId: e.view.sessionId, host: e.sessionHost };
    e.view.turnEngine = engine; // the panel shows the engine actually working, not the default
    this.sendView(e);
    if (engine === 'codex') e.view.sessionId = this.store.getSetting(codexThreadKey(e.role)) || null;
    else {
      const s = this.store.getSession(e.role.id);
      e.view.sessionId = s.sessionId;
      e.sessionHost = s.hostId;
    }
    try {
      await (engine === 'codex' ? this.runCodex(e, work) : this.runClaude(e, work));
    } finally {
      e.view.sessionId = saved.sessionId;
      e.sessionHost = saved.host;
      e.view.turnEngine = null;
      this.sendView(e);
    }
  }

  /** Claude path of run(): push the instruction into the live session and wait for that turn to finish. */
  private async runClaude(e: Employee, work: Work): Promise<void> {
    // a remote session costs one ssh connection; queue behind the per-host budget rather than
    // hammering a server that bans noisy clients
    const remote = e.role.host ? this.hosts?.get(e.role.host) : undefined;
    if (remote && !remote.isLocal) {
      // the badge may be stale (we stopped polling); make sure before failing the manager
      if (!remote.view.ok) await this.hosts?.ensureChecked(remote.cfg.id);
      if (sshThrottle.waitMs(remote.cfg.ssh) > 0) this.set(e, 'queued', tr({ ko: `⏳ ${remote.view.name} 접속 차례 기다리는 중`, en: `⏳ Waiting for a turn to connect to ${remote.view.name}` }));
      // wait without consuming — spawnRemote takes the slot, so it is counted exactly once
      if (!(await sshThrottle.waitForSlot(remote.cfg.ssh, 70_000))) {
        this.log(e, 'error', tr({
            ko: `ssh 횟수 제한 (${remote.cfg.ssh}: 분당 ${sshThrottle.limitFor(remote.cfg.ssh)}회)으로 세션을 열지 못했습니다`,
            en: `Could not open the session: ssh rate limit (${remote.cfg.ssh}: ${sshThrottle.limitFor(remote.cfg.ssh)} per minute)`,
          }));
        this.set(e, 'error', tr({ ko: '⚠️ ssh 횟수 제한', en: '⚠️ ssh rate limit' }));
        return;
      }
    }

    // the report language is baked into the system prompt, so a language switch reopens the session (same conversation)
    if (e.live && e.live.lang !== getLang()) {
      const stale = e.live;
      this.closeSession(e);
      await stale.done;
    }

    let live: LiveSession;
    try {
      live = this.openSession(e);
    } catch (err) {
      this.log(e, 'error', (err as Error).message);
      this.set(e, 'error', tr({ ko: '⚠️ 세션을 열지 못했습니다', en: '⚠️ Could not open the session' }));
      return;
    }

    const perm = effectivePermission(e.view.permission, work.requireApproval);
    e.wantedPermission = perm;
    if (perm !== live.perm) {
      try {
        await live.q.setPermissionMode(perm === 'auto' ? 'auto' : 'default');
        live.perm = perm;
        this.log(e, 'system', perm === 'auto' ? tr({ ko: '🤖 자동 모드', en: '🤖 Auto mode' }) : tr({ ko: '✋ 승인 모드 (이 작업만)', en: '✋ Approval mode (this task only)' }));
      } catch (err) {
        this.log(e, 'error', tr({ ko: `권한 모드 전환 실패: ${(err as Error).message}`, en: `Failed to switch permission mode: ${(err as Error).message}` }));
      }
    }

    await new Promise<void>((resolve) => {
      e.endTurn = () => {
        e.endTurn = null;
        resolve();
      };
      live.input.push(userMessage(work.text));
    });

    // stopped by the manager: not a result and not a failure (its task card is marked in settleTask)
    if (live.abort.signal.aborted || e.stopRequested) {
      this.set(e, 'idle', this.idleActivity(e));
      return;
    }

    // The stored session id belongs to another machine's transcript store (or was deleted):
    // drop it and run this same instruction once more on a fresh session.
    if (e.resumeMissing && e.view.sessionId) {
      e.resumeMissing = false;
      this.closeSession(e);
      e.view.sessionId = null;
      this.store.saveSession(e.role.id, null, e.view.costUsd, e.view.cwd);
      this.log(
        e,
        'system',
        tr({ ko: '이전 대화를 이 머신에서 찾을 수 없어 새 세션으로 다시 시작합니다', en: 'The previous conversation is not on this machine; starting a new session' }),
      );
      e.current = null;
      return await this.run(e, work);
    }
    e.resumeMissing = false;

    // The subscription ran out mid-turn: park the work and pick it up when the window resets,
    // so an overnight run resumes itself instead of being found stalled in the morning.
    // resetsAt comes in seconds and can round into the past; never park for less than a moment.
    const limitedUntil = e.rateLimitedUntil;
    e.rateLimitedUntil = null;
    if (limitedUntil) return this.park(e, work, Math.max(limitedUntil, Date.now() + 2_000));

    const ok = e.view.status !== 'error';
    if (ok) {
      const gist = clip(e.lastText.replace(/\s+/g, ' '), 50);
      this.set(e, 'done', tr({ ko: `✅ 완료: ${gist}`, en: `✅ Done: ${gist}` }));
    }
    bus.emit('runFinished', { employeeId: e.role.id, label: work.label, text: e.lastText, ok, taskId: work.taskId ?? null, error: ok ? undefined : clipError(e.lastError) || undefined } satisfies RunFinished);
    if (work.taskId != null) {
      // a failed attempt stays on the board as 'doing' so it can be picked up again
      const t = this.store.updateTask(work.taskId, ok ? { state: 'review', result: e.lastText || null } : { result: e.lastText || null });
      if (t) bus.send({ t: 'task', data: t });
    }
    this.armIdleTimer(e);
    // fall back to idle after a while so the desk doesn't look busy forever
    setTimeout(() => {
      if (!e.current && (e.view.status === 'done' || e.view.status === 'error')) this.set(e, 'idle', this.idleActivity(e));
    }, 60_000);
  }

  private handle(e: Employee, m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const mode: string | undefined = m.permissionMode;
          const modeLabel =
            mode === 'auto' ? tr({ ko: '🤖 자동 모드', en: '🤖 Auto mode' }) : mode === 'default' ? tr({ ko: '✋ 승인 모드', en: '✋ Approval mode' }) : (mode ?? '?');
          if (e.view.sessionId !== m.session_id) {
            this.log(e, 'system', tr({ ko: `🧠 모델: ${m.model} · ${modeLabel}`, en: `🧠 Model: ${m.model} · ${modeLabel}` }));
            e.view.sessionId = m.session_id;
            e.sessionHost = sessionHostId(e.role.host);
            this.store.saveSession(e.role.id, m.session_id, e.view.costUsd, e.view.cwd, e.sessionHost);
          } else this.log(e, 'system', modeLabel);
          if (e.wantedPermission === 'auto' && mode && mode !== 'auto')
            this.log(e, 'system', tr({ ko: `⚠️ 이 환경에서는 자동 모드를 쓸 수 없어 ${modeLabel}로 실행합니다`, en: `⚠️ Auto mode is not available here; running in ${modeLabel}` }));
        }
        break;
      case 'assistant': {
        if (m.parent_tool_use_id) break; // sub-agent chatter
        for (const b of m.message.content as any[]) {
          if (b.type === 'text' && b.text?.trim()) {
            e.lastText = b.text;
            this.log(e, 'assistant', b.text);
            this.set(e, 'thinking', `💬 ${clip(b.text.replace(/\s+/g, ' '), 55)}`);
          } else if (b.type === 'tool_use') {
            const s = statusForTool(b.name, b.input ?? {});
            this.log(e, 'tool', describeToolCall(b.name, b.input ?? {}));
            this.set(e, s.status, s.activity);
          }
        }
        // only the last reply counts: an error the model recovered from is followed by a normal one
        e.apiFailed = !!m.error;
        if (m.error) this.log(e, 'error', `API: ${m.error}`);
        break;
      }
      case 'user':
        if (!m.parent_tool_use_id && e.view.status !== 'waiting_permission') this.set(e, 'thinking', tr({ ko: '💭 결과 검토 중', en: '💭 Reviewing the result' }));
        break;
      case 'result': {
        // total_cost_usd is cumulative for the session, so bill the delta. A resumed session's first
        // result also carries the transcript's earlier turns, which were billed in an earlier app run:
        // take it as the baseline (lastCost === null) rather than charging it all again.
        const live = e.live;
        const total = m.total_cost_usd ?? 0;
        if (live) {
          if (live.lastCost !== null && !e.role.provider) e.view.costUsd += Math.max(0, total - live.lastCost);
          live.lastCost = total;
        }
        this.store.saveSession(e.role.id, e.view.sessionId, e.view.costUsd, e.view.cwd, e.sessionHost);
        if (m.subtype === 'success' && e.apiFailed) {
          // the reply was the API's error text, not an answer: this turn did not do its work
          this.set(e, 'error', `⚠️ ${clip(e.lastError, 55)}`);
        } else if (m.subtype === 'success') {
          if (m.result) e.lastText = m.result;
          this.log(e, 'result', tr({
              ko: `완료 (${m.num_turns} turns, ${(m.duration_ms / 1000).toFixed(0)}s)`,
              en: `Done (${m.num_turns} turns, ${(m.duration_ms / 1000).toFixed(0)}s)`,
            }));
        } else {
          this.log(e, 'error', tr({ ko: `종료: ${m.subtype}`, en: `Ended: ${m.subtype}` }));
          this.set(e, 'error', `⚠️ ${m.subtype}`);
        }
        e.endTurn?.(); // one instruction done; the session stays open for the next one
        break;
      }
      case 'rate_limit_event': {
        // subscription usage report; 'allowed' is routine and not worth logging
        const info = m.rate_limit_info;
        if (info.status === 'allowed') break;
        const pct = info.utilization != null ? ` ${Math.round(info.utilization * 100)}%` : '';
        const resetsAt = info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : null;
        const reset = resetsAt ? tr({ ko: ` · ${hhmm(resetsAt)} 초기화`, en: ` · resets ${hhmm(resetsAt)}` }) : '';
        if (info.status === 'rejected') e.rateLimitedUntil = resetsAt ?? Date.now() + LIMIT_FALLBACK_MS;
        this.log(e, info.status === 'rejected' ? 'error' : 'system', info.status === 'rejected'
            ? tr({ ko: `⚠️ 구독 사용량 한도 도달${pct}${reset}`, en: `⚠️ Subscription usage limit reached${pct}${reset}` })
            : tr({ ko: `⚠️ 구독 사용량 한도 근접${pct}${reset}`, en: `⚠️ Subscription usage near the limit${pct}${reset}` }));
        break;
      }
    }
  }
}
