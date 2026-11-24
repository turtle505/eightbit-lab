import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sq } from '../compute/adapter.ts';
import { SSH_BASE, sshThrottle } from '../hosts.ts';
import type { HostConfig } from '../config.ts';
import type { PermissionBroker } from '../permissions/broker.ts';
import type { CodexTools } from './codexTools.ts';

type Json = Record<string, any>;
type Event = (method: string, params: Json) => void;

/** A single Codex turn over the app-server's documented stdio JSON-RPC transport. */
export class CodexTurn {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private threadId = '';
  private turnId = '';
  private stderr = '';
  private complete!: (v: { threadId: string; text: string; status: string; error?: string }) => void;
  private failed!: (e: Error) => void;
  private finished = false;
  private text = '';
  readonly done: Promise<{ threadId: string; text: string; status: string; error?: string }>;

  constructor(private employeeId: string, private broker: PermissionBroker, private tools: CodexTools, private callTool: (namespace: string, tool: string, args: Record<string, unknown>) => Promise<{ contentItems: { type: string; text: string }[]; success: boolean }>, host?: HostConfig) {
    if (host && host.ssh !== 'local') {
      if (!sshThrottle.allow(host.ssh)) throw new Error(`SSH rate limit: ${host.ssh}`);
      const command = `${sq(host.codexPath || 'codex')} app-server --listen stdio://`;
      this.proc = spawn('ssh', [...SSH_BASE, host.ssh, `exec ${command}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else this.proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.done = new Promise((resolve, reject) => { this.complete = resolve; this.failed = reject; });
    // A handshake failure can reject before start() reaches the completion promise.
    void this.done.catch(() => {});
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (s: string) => { this.stderr = (this.stderr + s).slice(-1200); });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      try { this.receive(JSON.parse(line)); } catch (err) { this.fail(err as Error); }
    });
    this.proc.on('error', (err) => this.fail(err));
    this.proc.on('exit', (code) => this.fail(new Error(`Codex app-server exited (${code}): ${this.stderr}`)));
  }

  private write(v: Json) { this.proc.stdin.write(`${JSON.stringify(v)}\n`); }
  private request(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  private fail(err: Error) {
    if (this.finished) return;
    this.finished = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.failed(err);
    this.proc.kill();
  }
  private async approve(msg: Json) {
    const method = msg.method as string;
    const input = msg.params ?? {};
    if (method === 'item/tool/call') {
      try {
        const result = await this.callTool(input.namespace, input.tool, input.arguments ?? {});
        this.write({ id: msg.id, result });
      } catch (err) {
        this.write({ id: msg.id, result: { contentItems: [{ type: 'inputText', text: String((err as Error).message ?? err) }], success: false } });
      }
      return;
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const tool = method.includes('commandExecution') ? 'Bash' : 'Edit';
      const signal = new AbortController();
      this.onEvent?.('approval/requested', { tool, input });
      const result = await this.broker.request(this.employeeId, tool, input, signal.signal);
      this.onEvent?.('approval/resolved', { tool });
      this.write({ id: msg.id, result: { decision: result.behavior === 'allow' ? 'accept' : 'decline' } });
    } else if (method === 'item/permissions/requestApproval') {
      this.write({ id: msg.id, result: { permissions: {}, scope: 'turn' } });
    } else if (method === 'item/tool/requestUserInput') {
      this.write({ id: msg.id, result: { answers: {} } });
    } else if (method === 'mcpServer/elicitation/request') {
      this.write({ id: msg.id, result: { action: 'decline', content: null } });
    } else this.write({ id: msg.id, error: { code: -32601, message: `Unsupported request: ${method}` } });
  }
  private receive(msg: Json) {
    if (typeof msg.id === 'number' && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.id === 'number' && msg.method) { void this.approve(msg).catch((e) => this.fail(e)); return; }
    const item = msg.params?.item;
    if (msg.method === 'item/completed' && item?.type === 'agentMessage' && item.text) this.text = item.text;
    if (msg.method === 'turn/completed' && !this.finished) {
      this.finished = true;
      this.complete({ threadId: this.threadId, text: this.text, status: msg.params?.turn?.status ?? 'failed', error: msg.params?.turn?.error?.message });
      this.proc.kill();
    }
    this.onEvent?.(msg.method, msg.params ?? {});
  }
  private onEvent?: Event;

  async start(cwd: string, prompt: string, priorThread: string | null, onEvent: Event, ask = false) {
    this.onEvent = onEvent;
    const approvalPolicy = ask ? 'untrusted' : 'on-request';
    await this.request('initialize', { clientInfo: { name: 'eightbit_lab', title: '8-bit Lab', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    const config = await this.request('config/read', { cwd });
    const model = typeof config.config?.model === 'string' ? config.config.model : undefined;
    const response = priorThread
      ? await this.request('thread/resume', { threadId: priorThread, model, excludeTurns: true, dynamicTools: this.tools.specs })
      : await this.request('thread/start', { cwd, model, approvalPolicy, sandbox: 'workspace-write', serviceName: 'eightbit_lab', dynamicTools: this.tools.specs });
    this.threadId = response.thread?.id;
    if (!this.threadId) throw new Error('Codex did not return a thread id');
    const started = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }], model, cwd, approvalPolicy, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } });
    this.turnId = started.turn?.id ?? '';
    return this.done;
  }
  stop() {
    this.broker.cancelFor(this.employeeId);
    if (this.threadId && this.turnId) void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => this.proc.kill());
    else this.proc.kill();
  }
}
