import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStatus, EmployeeView, LogLine } from '../../../shared/protocol.ts';
import { bus } from '../bus.ts';
import type { ServerRegistry } from '../compute/registry.ts';
import type { OfficeConfig, RoleConfig } from '../config.ts';
import type { Store } from '../db.ts';
import { labToolsServer } from '../mcp/labTools.ts';
import { type OfficeApi, officeToolsServer } from '../mcp/officeTools.ts';
import type { PermissionBroker } from '../permissions/broker.ts';
import { describeToolCall, statusForTool } from './status.ts';
import { ensureWorkspace } from './workspace.ts';

interface Work {
  text: string;
  taskId: number | null;
}

class Employee {
  view: EmployeeView;
  inbox: Work[] = [];
  q: Query | null = null;
  abort: AbortController | null = null;
  current: Work | null = null;
  lastText = '';

  constructor(readonly role: RoleConfig, sessionId: string | null, costUsd: number) {
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
    };
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Exact tool name, or a server-level rule like "mcp__office" that covers every "mcp__office__*" tool. */
export function isAutoAllowed(rules: Iterable<string>, toolName: string): boolean {
  for (const r of rules) if (r === toolName || toolName.startsWith(r + '__')) return true;
  return false;
}

/** Runs each employee as a Claude Agent SDK session, with a global concurrency limit. */
export class AgentManager {
  private emps = new Map<string, Employee>();
  private waiting: Employee[] = []; // FIFO of employees waiting for a slot
  private running = 0;
  /** set by index.ts; needed for employees with officeTools */
  officeApi: OfficeApi | null = null;

  constructor(
    private office: OfficeConfig,
    roles: RoleConfig[],
    private store: Store,
    private broker: PermissionBroker,
    private registry: ServerRegistry,
  ) {
    for (const r of roles) {
      const s = store.getSession(r.id);
      this.emps.set(r.id, new Employee(r, s.sessionId, s.costUsd));
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
  instruct(employeeId: string, text: string, taskId: number | null = null) {
    const e = this.emp(employeeId);
    e.inbox.push({ text, taskId });
    this.log(e, 'user', taskId ? `[작업 #${taskId}] ${text}` : text);
    if (!e.current && !this.waiting.includes(e)) {
      this.waiting.push(e);
      this.set(e, 'queued', '⏳ 자리 나길 기다리는 중');
    }
    this.pump();
  }

  private pump() {
    while (this.running < this.office.maxConcurrent && this.waiting.length) {
      const e = this.waiting.shift()!;
      const work = e.inbox.shift();
      if (!work) continue;
      this.running++;
      void this.run(e, work).finally(() => {
        this.running--;
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
    const model = e.role.model || this.office.model || undefined;

    const q = query({
      prompt: work.text,
      options: {
        cwd,
        model,
        abortController: abort,
        resume: e.view.sessionId ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: e.role.systemPrompt },
        allowedTools: [...autoAllow],
        permissionMode: 'default',
        mcpServers,
        canUseTool: async (toolName, input, { signal }) => {
          if (isAutoAllowed(autoAllow, toolName)) return { behavior: 'allow', updatedInput: input };
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
    if (e.view.status !== 'error') this.set(e, 'done', `✅ 완료: ${clip(e.lastText.replace(/\s+/g, ' '), 50)}`);
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
          if (e.view.sessionId !== m.session_id) {
            e.view.sessionId = m.session_id;
            this.store.saveSession(e.role.id, m.session_id, e.view.costUsd, e.view.cwd);
          }
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
        e.view.costUsd += m.total_cost_usd ?? 0;
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
      case 'rate_limit_event' as any:
        this.log(e, 'system', '⚠️ rate limit 이벤트');
        break;
    }
  }
}
