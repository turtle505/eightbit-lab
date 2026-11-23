import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStatus, EmployeeView, LogLine, PermissionSetting } from '../../../shared/protocol.ts';
import { bus } from '../bus.ts';
import type { ServerRegistry } from '../compute/registry.ts';
import type { OfficeConfig, RoleConfig } from '../config.ts';
import type { Store } from '../db.ts';
import { labToolsServer } from '../mcp/labTools.ts';
import { type OfficeApi, officeToolsServer } from '../mcp/officeTools.ts';
import type { PermissionBroker } from '../permissions/broker.ts';
import type { ProviderHub } from '../providers.ts';
import { describeToolCall, statusForTool } from './status.ts';
import { ensureWorkspace } from './workspace.ts';

interface Work {
  text: string;
  taskId: number | null;
  /** extra auto-allow rules for this run only (an approved skill's office-allow) */
  extraAllow: string[];
  /** short title for the report feed, e.g. "⏰ 아침 브리핑" */
  label: string;
  /** force 'ask' for this run (task marked 🔒 by the manager or the delegating lead) */
  requireApproval: boolean;
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
}

class Employee {
  view: EmployeeView;
  inbox: Work[] = [];
  live: LiveSession | null = null;
  /** resolves the in-flight turn (set by run(), called from the consume loop on `result`) */
  endTurn: (() => void) | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  current: Work | null = null;
  lastText = '';
  /** mode requested for the current run (to report a fallback from auto) */
  wantedPermission: PermissionSetting = 'ask';

  constructor(readonly role: RoleConfig, sessionId: string | null, costUsd: number, permission: PermissionSetting) {
    this.view = {
      id: role.id,
      name: role.name,
      title: role.title,
      desk: role.desk,
      sprite: role.sprite,
      status: 'idle',
      activity: '☕ 대기 중',
      taskId: null,
      sessionId,
      cwd: '',
      costUsd,
      stayAtDesk: role.stayAtDesk ?? false,
      deskStyle: role.deskStyle,
      permission,
      live: false,
      provider: role.provider,
    };
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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
 * Does this call reach a lab server? Those always get a manager approval card, even in auto mode:
 * an agent reading papers off the web should never be one classifier call away from running
 * arbitrary commands on the GPU machines.
 */
export function needsLabApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (LAB_TOOLS.has(toolName)) return true;
  if (toolName !== 'Bash') return false;
  return REMOTE_CMD.test(String(input?.command ?? ''));
}

/** A 🔒 task always asks; otherwise the employee's own setting. Only ever tightens. */
export function effectivePermission(employee: PermissionSetting, requireApproval: boolean): PermissionSetting {
  return requireApproval ? 'ask' : employee;
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
      e.view.name = store.getEmployeeName(r.id) ?? r.name;
      this.emps.set(r.id, e);
    }
  }

  views(): EmployeeView[] {
    return [...this.emps.values()].map((e) => e.view);
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

  /** push the current view to the browsers (status unchanged) */
  private sendView(e: Employee) {
    e.view.live = !!e.live;
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  private set(e: Employee, status: AgentStatus, activity?: string) {
    e.view.live = !!e.live;
    e.view.status = status;
    if (activity !== undefined) e.view.activity = activity;
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  private log(e: Employee, kind: LogLine['kind'], text: string) {
    const line: LogLine = { employeeId: e.role.id, ts: Date.now(), kind, text };
    this.store.addLog(line);
    bus.send({ t: 'log', data: line });
  }

  /** Give an employee an instruction. Queued if they're busy or the office is at capacity. */
  instruct(employeeId: string, text: string, taskId: number | null = null, opts: { extraAllow?: string[]; label?: string; requireApproval?: boolean } = {}) {
    const e = this.emp(employeeId);
    const label = opts.label ?? `💬 ${clip(text.split('\n').find((l) => l.trim())?.trim() ?? '', 40)}`;
    e.inbox.push({ text, taskId, extraAllow: opts.extraAllow ?? [], label, requireApproval: !!opts.requireApproval });
    this.log(e, 'user', taskId ? `[작업 #${taskId}] ${text}` : text);
    if (!e.current && !this.waiting.includes(e)) {
      this.waiting.push(e);
      this.set(e, 'queued', '⏳ 자리 나길 기다리는 중');
    }
    this.pump();
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
      void this.run(e, work).finally(() => {
        if (provider) this.busyProviders.delete(provider);
        else this.running--;
        e.current = null;
        if (e.inbox.length) this.waiting.push(e);
        this.pump();
      });
    }
  }

  /** Stop the current turn but keep the session open, so the next instruction is still warm. */
  stop(employeeId: string) {
    const e = this.emp(employeeId);
    e.inbox = [];
    this.waiting = this.waiting.filter((w) => w !== e);
    this.broker.cancelFor(employeeId);
    const live = e.live;
    if (!live || !e.current) {
      if (!e.current) this.set(e, 'idle', '☕ 대기 중');
      return;
    }
    this.log(e, 'system', '⏹ 중지됨');
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

  /** Rename from the UI: replaces the quoted nickname in the configured name (문헌 리서처 "Ada" → 문헌 리서처 "Bo"). */
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
    if (mode !== 'auto' && mode !== 'ask') throw new Error(`잘못된 권한 모드: ${mode}`);
    this.store.setEmployeePerm(e.role.id, mode);
    e.view.permission = mode;
    this.log(e, 'system', mode === 'auto' ? '🤖 자동 모드로 전환 (다음 지시부터)' : '✋ 승인 모드로 전환 (다음 지시부터)');
    bus.send({ t: 'employee', data: { ...e.view } });
  }

  resetSession(employeeId: string) {
    const e = this.emp(employeeId);
    this.stop(employeeId);
    this.closeSession(e);
    e.view.sessionId = null;
    this.store.saveSession(e.role.id, null, e.view.costUsd, e.view.cwd);
    this.log(e, 'system', '새 대화 세션으로 초기화됨');
    this.set(e, 'idle', '☕ 새 마음으로 대기 중');
  }

  /** Open (or reuse) the employee's long-lived session. Throws with a manager-readable message. */
  private openSession(e: Employee): LiveSession {
    if (e.live) return e.live;

    const cwd = ensureWorkspace(this.office, e.role); // throws → caller reports
    e.view.cwd = cwd;

    const autoAllow = new Set(e.role.autoAllow);
    const mcpServers: Record<string, any> = { lab: labToolsServer(e.role.id, cwd, this.registry, this.store) };
    if (e.role.officeTools && this.officeApi) mcpServers.office = officeToolsServer(e.role.id, this.officeApi);

    let model = e.role.model || this.office.model || undefined;
    let env: Record<string, string> | undefined;
    let providerModel: string | null = null;
    if (e.role.provider) {
      const link = this.providers?.get(e.role.provider);
      const rt = link ? link.runtime() : { error: `설정에 없는 provider: ${e.role.provider} (office.local.yaml 의 providers 확인)` };
      if ('error' in rt) throw new Error(`🖥 ${rt.error}`);
      ({ model, env } = rt);
      providerModel = rt.model;
    }

    // the current work changes every turn, so the callbacks read e.current instead of closing over one Work
    const extraAllowNow = () => e.current?.extraAllow ?? [];
    const perm = effectivePermission(e.view.permission, e.current?.requireApproval ?? false);
    const abort = new AbortController();
    const input = new MessageQueue();

    const q = this.queryFn({
      prompt: input,
      options: {
        cwd,
        additionalDirectories: this.extraDirs,
        model,
        env,
        abortController: abort,
        resume: e.view.sessionId ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: e.role.systemPrompt },
        allowedTools: [...autoAllow],
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
                  if (!needsLabApproval(name, inp)) return { continue: true };
                  if (isAutoAllowed(autoAllow, name) || extraAllowNow().some((r) => matchesRule(r, name, inp))) return { continue: true };
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'ask' as const,
                      permissionDecisionReason: '랩 서버에 접근하는 작업이라 매니저 승인이 필요합니다.',
                    },
                  };
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
            this.log(e, 'system', `🔓 스킬 권한으로 자동 허용: ${describeToolCall(toolName, input as any)}`);
            return { behavior: 'allow', updatedInput: input };
          }
          const prev = { status: e.view.status, activity: e.view.activity };
          this.set(e, 'waiting_permission', `✋ 승인 필요: ${describeToolCall(toolName, input as any).slice(0, 50)}`);
          this.log(e, 'system', `승인 요청: ${describeToolCall(toolName, input as any)}`);
          const res = await this.broker.request(e.role.id, toolName, input, signal);
          this.log(e, 'system', res.behavior === 'allow' ? '✅ 승인됨' : `❌ 거부됨`);
          this.set(e, prev.status, prev.activity);
          return res;
        },
      },
    });

    const live: LiveSession = { q, input, abort, cwd, perm, providerModel, lastCost: e.view.sessionId ? null : 0, done: Promise.resolve() };
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
        this.set(e, 'error', '⚠️ 오류 발생 (로그 확인)');
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
    this.sendView(e);
  }

  /** Close sessions that were opened against this provider, so a model change takes effect. */
  reopenProviderSessions(providerId: string) {
    for (const e of this.emps.values()) {
      if (e.role.provider !== providerId || !e.live) continue;
      const wanted = this.providers?.get(providerId)?.view.model ?? null;
      if (e.live.providerModel === wanted) continue;
      if (e.current) continue; // mid-turn: the idle timer or the next open will pick the new model up
      this.closeSession(e, `🖥 모델이 ${wanted}(으)로 바뀌어 세션을 다시 엽니다 (다음 지시부터)`);
    }
  }

  private armIdleTimer(e: Employee) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const ms = this.office.sessionIdleMinutes * 60_000;
    if (ms <= 0) return;
    e.idleTimer = setTimeout(() => {
      if (!e.current && e.live) this.closeSession(e, `💤 ${this.office.sessionIdleMinutes}분 동안 일이 없어 세션을 닫았습니다 (다음 지시 때 이어서 엶)`);
    }, ms);
  }

  /** Send one instruction into the employee's session and wait for that turn to finish. */
  private async run(e: Employee, work: Work) {
    e.current = work;
    e.view.taskId = work.taskId;
    e.lastText = '';
    this.set(e, 'thinking', '💭 업무 파악 중');
    if (e.idleTimer) clearTimeout(e.idleTimer);

    let live: LiveSession;
    try {
      live = this.openSession(e);
    } catch (err) {
      this.log(e, 'error', (err as Error).message);
      this.set(e, 'error', '⚠️ 세션을 열지 못했습니다');
      return;
    }

    const perm = effectivePermission(e.view.permission, work.requireApproval);
    e.wantedPermission = perm;
    if (perm !== live.perm) {
      try {
        await live.q.setPermissionMode(perm === 'auto' ? 'auto' : 'default');
        live.perm = perm;
        this.log(e, 'system', perm === 'auto' ? '🤖 자동 모드' : '✋ 승인 모드 (이 작업만)');
      } catch (err) {
        this.log(e, 'error', `권한 모드 전환 실패: ${(err as Error).message}`);
      }
    }

    await new Promise<void>((resolve) => {
      e.endTurn = () => {
        e.endTurn = null;
        resolve();
      };
      live.input.push(userMessage(work.text));
    });

    if (live.abort.signal.aborted) {
      this.set(e, 'idle', '☕ 대기 중');
      return;
    }
    const ok = e.view.status !== 'error';
    if (ok) this.set(e, 'done', `✅ 완료: ${clip(e.lastText.replace(/\s+/g, ' '), 50)}`);
    bus.emit('runFinished', { employeeId: e.role.id, label: work.label, text: e.lastText, ok, taskId: work.taskId ?? null } satisfies RunFinished);
    if (work.taskId != null) {
      const t = this.store.updateTask(work.taskId, { state: 'review', result: e.lastText || null });
      if (t) bus.send({ t: 'task', data: t });
    }
    this.armIdleTimer(e);
    // fall back to idle after a while so the desk doesn't look busy forever
    setTimeout(() => {
      if (!e.current && (e.view.status === 'done' || e.view.status === 'error')) this.set(e, 'idle', '☕ 대기 중');
    }, 60_000);
  }

  private handle(e: Employee, m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const mode: string | undefined = m.permissionMode;
          const modeKo = mode === 'auto' ? '🤖 자동 모드' : mode === 'default' ? '✋ 승인 모드' : mode ?? '?';
          if (e.view.sessionId !== m.session_id) {
            this.log(e, 'system', `🧠 모델: ${m.model} · ${modeKo}`);
            e.view.sessionId = m.session_id;
            this.store.saveSession(e.role.id, m.session_id, e.view.costUsd, e.view.cwd);
          } else this.log(e, 'system', modeKo);
          if (e.wantedPermission === 'auto' && mode && mode !== 'auto')
            this.log(e, 'system', `⚠️ 이 환경에서는 자동 모드를 쓸 수 없어 ${modeKo}로 실행합니다`);
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
        if (m.error) this.log(e, 'error', `API: ${m.error}`);
        break;
      }
      case 'user':
        if (!m.parent_tool_use_id && e.view.status !== 'waiting_permission') this.set(e, 'thinking', '💭 결과 검토 중');
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
        this.store.saveSession(e.role.id, e.view.sessionId, e.view.costUsd, e.view.cwd);
        if (m.subtype === 'success') {
          if (m.result) e.lastText = m.result;
          this.log(e, 'result', `완료 (${m.num_turns} turns, ${(m.duration_ms / 1000).toFixed(0)}s)`);
        } else {
          this.log(e, 'error', `종료: ${m.subtype}`);
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
        const reset = info.resetsAt ? ` · ${new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 초기화` : '';
        this.log(e, info.status === 'rejected' ? 'error' : 'system', `⚠️ 구독 사용량 ${info.status === 'rejected' ? '한도 도달' : '한도 근접'}${pct}${reset}`);
        break;
      }
    }
  }
}
