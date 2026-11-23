import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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
  q: Query | null = null;
  abort: AbortController | null = null;
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

  private set(e: Employee, status: AgentStatus, activity?: string) {
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

  stop(employeeId: string) {
    const e = this.emp(employeeId);
    e.inbox = [];
    this.waiting = this.waiting.filter((w) => w !== e);
    this.broker.cancelFor(employeeId);
    e.abort?.abort();
    e.q?.close();
    if (!e.current) this.set(e, 'idle', '☕ 대기 중');
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
    e.view.sessionId = null;
    this.store.saveSession(e.role.id, null, e.view.costUsd, e.view.cwd);
    this.log(e, 'system', '새 대화 세션으로 초기화됨');
    this.set(e, 'idle', '☕ 새 마음으로 대기 중');
  }

  private async run(e: Employee, work: Work) {
    e.current = work;
    e.view.taskId = work.taskId;
    e.lastText = '';
    this.set(e, 'thinking', '💭 업무 파악 중');

    let cwd: string;
    try {
      cwd = ensureWorkspace(this.office, e.role);
    } catch (err) {
      this.log(e, 'error', `작업 폴더 준비 실패: ${(err as Error).message}`);
      this.set(e, 'error', '⚠️ 작업 폴더 준비 실패');
      return;
    }
    e.view.cwd = cwd;

    const abort = new AbortController();
    e.abort = abort;
    const autoAllow = new Set(e.role.autoAllow);
    const mcpServers: Record<string, any> = { lab: labToolsServer(e.role.id, cwd, this.registry, this.store) };
    if (e.role.officeTools && this.officeApi) mcpServers.office = officeToolsServer(e.role.id, this.officeApi);
    let model = e.role.model || this.office.model || undefined;
    let env: Record<string, string> | undefined;
    if (e.role.provider) {
      const link = this.providers?.get(e.role.provider);
      const rt = link ? link.runtime() : { error: `설정에 없는 provider: ${e.role.provider} (office.local.yaml 의 providers 확인)` };
      if ('error' in rt) {
        this.log(e, 'error', `🖥 ${rt.error}`);
        this.set(e, 'error', '⚠️ 로컬 모델 연결 실패');
        return;
      }
      ({ model, env } = rt);
    }

    const perm = effectivePermission(e.view.permission, work.requireApproval);
    e.wantedPermission = perm;
    const q = query({
      prompt: work.text,
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
                  if (isAutoAllowed(autoAllow, name) || work.extraAllow.some((r) => matchesRule(r, name, inp))) return { continue: true };
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
          if (work.extraAllow.some((r) => matchesRule(r, toolName, input))) {
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
    e.q = q;

    try {
      for await (const m of q) this.handle(e, m);
    } catch (err) {
      if (!abort.signal.aborted) {
        this.log(e, 'error', String((err as Error).message ?? err));
        this.set(e, 'error', '⚠️ 오류 발생 (로그 확인)');
      }
    } finally {
      e.q = null;
      e.abort = null;
    }

    if (abort.signal.aborted) {
      this.log(e, 'system', '⏹ 중지됨');
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
        if (!e.role.provider) e.view.costUsd += m.total_cost_usd ?? 0; // a local model's "cost" is meaningless
        this.store.saveSession(e.role.id, e.view.sessionId, e.view.costUsd, e.view.cwd);
        if (m.subtype === 'success') {
          if (m.result) e.lastText = m.result;
          this.log(e, 'result', `완료 (${m.num_turns} turns, ${(m.duration_ms / 1000).toFixed(0)}s)`);
        } else {
          this.log(e, 'error', `종료: ${m.subtype}`);
          this.set(e, 'error', `⚠️ ${m.subtype}`);
        }
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
