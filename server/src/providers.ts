import { execFile } from 'node:child_process';
import { tr } from '../../shared/i18n.ts';
import type { ProviderView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import type { ProviderConfig } from './config.ts';
import type { Store } from './db.ts';
import { muxErrorText, sshControlOpts, sshMux } from './hosts.ts';

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

export const TUNNEL_RETRY_FIRST_MS = 30_000;
export const TUNNEL_RETRY_MAX_MS = 300_000;

/** `ssh -O forward|cancel`: a request to the host's master connection over its local socket (no new connection). */
const muxForward = (op: 'forward' | 'cancel', spec: string, host: string) =>
  new Promise<{ ok: boolean; err: string }>((res) => {
    execFile('ssh', ['-O', op, ...sshControlOpts(), '-L', spec, host], { timeout: 10_000, encoding: 'utf8' }, (e, _o, stderr) => res({ ok: !e, err: String(stderr ?? '').trim().split('\n').pop() ?? '' }));
  });

/**
 * A port forward to one Ollama server + periodic health check; broadcasts its ProviderView on change.
 * The forward is a channel in the host's shared ssh connection (hosts.ts), not a connection of its own.
 */
export class OllamaLink {
  view: ProviderView;
  private retry: NodeJS.Timeout | null = null;
  private backoff = TUNNEL_RETRY_FIRST_MS;
  /** swapped in tests */
  forward = muxForward;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];

  /** the Ollama server runs on this machine, so the "tunnel" is a no-op */
  get isLocal() {
    return this.cfg.ssh_host === 'local';
  }
  /** port to talk to: the tunnel's local end, or the server's own port when it is on this machine */
  get port() {
    return this.isLocal ? this.cfg.remotePort : this.cfg.localPort;
  }

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
      error: tr({ ko: '연결 중…', en: 'Connecting…' }),
    };
  }

  start() {
    this.stopped = false;
    // `ssh: local` → Ollama is on this machine already; no tunnel, talk to it directly
    if (!this.isLocal) void this.openTunnel();
    this.timers.push(setInterval(() => void this.check(), HEALTH_MS));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.isLocal && sshMux.isReady(this.cfg.ssh_host)) void this.forward('cancel', this.spec, this.cfg.ssh_host);
  }

  private get spec() {
    return `127.0.0.1:${this.cfg.localPort}:127.0.0.1:${this.cfg.remotePort}`;
  }

  /**
   * Ask the host's master connection to forward the port. Asking again for a forward that is already
   * there is fine, so this is also how a forward lost with its master comes back. A failure is retried
   * with a growing gap (30 s → 5 min): each attempt on a dead host could be a new connection.
   */
  async openTunnel() {
    if (this.stopped) return;
    this.retry = null;
    const host = this.cfg.ssh_host;
    const m = await sshMux.ensure(host, { wait: false });
    const r = m.ok ? await this.forward('forward', this.spec, host) : { ok: false, err: muxErrorText(host, m) };
    if (this.stopped) return;
    if (r.ok) return void this.check();
    await this.check(r.err || tr({ ko: 'ssh 포워딩 실패', en: 'ssh forward failed' }));
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retry || this.stopped || this.isLocal) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, TUNNEL_RETRY_MAX_MS);
    this.retry = setTimeout(() => void this.openTunnel(), wait);
    this.timers.push(this.retry);
  }

  private async getJson(path: string): Promise<any> {
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async check(tunnelError?: string) {
    let next: ProviderView;
    try {
      const [ver, tags] = await Promise.all([this.getJson('/api/version'), this.getJson('/api/tags')]);
      const models = ((tags?.models ?? []) as any[]).map((m) => String(m.name)).sort();
      next = { ...this.view, ok: true, version: String(ver?.version ?? ''), models, error: null };
      this.backoff = TUNNEL_RETRY_FIRST_MS;
    } catch (err) {
      const msg = tunnelError ?? (err as Error).message;
      const where = `${this.cfg.ssh_host}:${this.cfg.remotePort}`;
      next = { ...this.view, ok: false, error: tr({ ko: `${where} 응답 없음 (${msg})`, en: `no response from ${where} (${msg})` }) };
      // the forward may have gone with its master: ask for it again, on the slow schedule
      if (tunnelError === undefined) this.scheduleRetry();
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.view);
    this.view = next;
    if (changed) bus.send({ t: 'provider', data: { ...next } });
  }

  setModel(model: string) {
    if (!this.view.models.includes(model)) throw new Error(tr({ ko: `${this.cfg.name}에 설치되지 않은 모델: ${model}`, en: `Model not installed on ${this.cfg.name}: ${model}` }));
    this.store.setProviderModel(this.cfg.id, model);
    this.view = { ...this.view, model };
    bus.send({ t: 'provider', data: { ...this.view } });
  }

  /** what AgentManager needs to start a run, or why it can't */
  runtime(): { model: string; env: Record<string, string> } | { error: string } {
    if (!this.view.ok) return {
        error: tr({
          ko: `${this.cfg.name} Ollama에 연결할 수 없음: ${this.view.error ?? '알 수 없음'}`,
          en: `Cannot reach ${this.cfg.name} Ollama: ${this.view.error ?? 'unknown'}`,
        }),
      };
    return { model: this.view.model, env: ollamaEnv(process.env, this.port, this.view.model) };
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
    if (!l) throw new Error(tr({ ko: `알 수 없는 provider: ${providerId}`, en: `Unknown provider: ${providerId}` }));
    l.setModel(model);
  }
}
