import { type ChildProcess, spawn } from 'node:child_process';
import type { ProviderView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import type { ProviderConfig } from './config.ts';
import type { Store } from './db.ts';

/**
 * Environment for a Claude Code session that talks to Ollama's Anthropic-compatible API instead of the
 * subscription. The SDK's `env` replaces process.env, so the base env is spread in. Every model alias
 * (haiku is used for background work such as WebFetch summaries) points at the same local model, or
 * Ollama would answer 404 for "claude-haiku-…".
 */
export function ollamaEnv(base: Record<string, string | undefined>, port: number, model: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

const HEALTH_MS = 30_000;

/** SSH tunnel to one Ollama server + periodic health check; broadcasts its ProviderView on change. */
export class OllamaLink {
  view: ProviderView;
  private proc: ChildProcess | null = null;
  private backoff = 5_000;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    readonly cfg: ProviderConfig,
    private store: Store,
  ) {
    this.view = {
      id: cfg.id,
      name: cfg.name,
      kind: cfg.kind,
      ok: false,
      version: null,
      models: [],
      model: store.getProviderModel(cfg.id) ?? cfg.model,
      error: '연결 중…',
    };
  }

  start() {
    this.stopped = false;
    this.openTunnel();
    this.timers.push(setInterval(() => void this.check(), HEALTH_MS));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.proc?.kill();
    this.proc = null;
  }

  private openTunnel() {
    const { ssh_host, localPort, remotePort } = this.cfg;
    const p = spawn(
      'ssh',
      ['-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ssh_host],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.proc = p;
    let stderr = '';
    p.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-500)));
    p.on('error', (err) => (stderr = err.message));
    p.on('exit', () => {
      if (this.proc === p) this.proc = null;
      if (this.stopped) return;
      // a port already forwarded (e.g. by an earlier dev instance) also lands here; the health check decides
      void this.check(stderr.trim().split('\n').pop() || 'ssh 터널 종료');
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.timers.push(setTimeout(() => !this.stopped && this.openTunnel(), wait));
    });
    // first check once the forward is likely up
    this.timers.push(setTimeout(() => void this.check(), 2_500));
  }

  private async getJson(path: string): Promise<any> {
    const r = await fetch(`http://127.0.0.1:${this.cfg.localPort}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async check(tunnelError?: string) {
    let next: ProviderView;
    try {
      const [ver, tags] = await Promise.all([this.getJson('/api/version'), this.getJson('/api/tags')]);
      const models = ((tags?.models ?? []) as any[]).map((m) => String(m.name)).sort();
      next = { ...this.view, ok: true, version: String(ver?.version ?? ''), models, error: null };
      this.backoff = 5_000;
    } catch (err) {
      const msg = tunnelError ?? (err as Error).message;
      next = { ...this.view, ok: false, error: `${this.cfg.ssh_host}:${this.cfg.remotePort} 응답 없음 (${msg})` };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.view);
    this.view = next;
    if (changed) bus.send({ t: 'provider', data: { ...next } });
  }

  setModel(model: string) {
    if (!this.view.models.includes(model)) throw new Error(`${this.cfg.name}에 설치되지 않은 모델: ${model}`);
    this.store.setProviderModel(this.cfg.id, model);
    this.view = { ...this.view, model };
    bus.send({ t: 'provider', data: { ...this.view } });
  }

  /** what AgentManager needs to start a run, or why it can't */
  runtime(): { model: string; env: Record<string, string> } | { error: string } {
    if (!this.view.ok) return { error: `${this.cfg.name} Ollama에 연결할 수 없음: ${this.view.error ?? '알 수 없음'}` };
    return { model: this.view.model, env: ollamaEnv(process.env, this.cfg.localPort, this.view.model) };
  }
}

export class ProviderHub {
  private links = new Map<string, OllamaLink>();

  constructor(cfgs: ProviderConfig[], store: Store) {
    for (const c of cfgs) this.links.set(c.id, new OllamaLink(c, store));
  }
  get(id: string) {
    return this.links.get(id);
  }
  views(): ProviderView[] {
    return [...this.links.values()].map((l) => ({ ...l.view }));
  }
  start() {
    for (const l of this.links.values()) l.start();
    const stopAll = () => this.stop();
    process.once('exit', stopAll);
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      process.once(sig, () => {
        stopAll();
        process.exit(0);
      });
  }
  stop() {
    for (const l of this.links.values()) l.stop();
  }
  setModel(providerId: string, model: string) {
    const l = this.links.get(providerId);
    if (!l) throw new Error(`알 수 없는 provider: ${providerId}`);
    l.setModel(model);
  }
}
