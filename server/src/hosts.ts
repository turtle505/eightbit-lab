import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { HostView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import { sq } from './compute/adapter.ts';
import { ROOT, type HostConfig } from './config.ts';
import { SshThrottle } from './sshRate.ts';

/** Every ssh/scp the office starts passes through this; index.ts replaces it with the configured limit. */
export let sshThrottle = new SshThrottle(5);
export const setSshLimit = (perMinute: number) => (sshThrottle = new SshThrottle(perMinute));

/** Shape the Agent SDK expects back from `spawnClaudeCodeProcess` (a ChildProcess satisfies it). */
export type SpawnArgs = { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal };

/**
 * Only these reach the remote shell. The local PATH/HOME/SHELL would be wrong there, and the
 * session's own env (model aliases, base URL) is exactly what must carry over.
 */
export const forwardEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || v === '') continue;
    if (/^(CLAUDE|ANTHROPIC)_/.test(k)) out[k] = v;
  }
  return out;
};

/**
 * One shell command for the remote end: cd into the session folder, set the forwarded env, then
 * *exec* the CLI so it replaces the shell — that way closing the ssh pipe reaches the CLI itself.
 * Everything interpolated goes through sq().
 */
export function remoteCommand(cfg: HostConfig, a: SpawnArgs): string {
  const claude = cfg.claudePath || a.command; // non-login ssh often lacks ~/.local/bin on PATH
  const env = forwardEnv(a.env);
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`);
  const parts = [...assignments, sq(claude), ...a.args.map(sq)];
  const cd = a.cwd ? `cd ${sq(a.cwd)} && ` : '';
  return `${cd}exec env ${parts.join(' ')}`;
}

export const SSH_BASE = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];

/**
 * Short commands (health checks, folder listings, GPU polling) run many times an hour. Opening a
 * fresh TCP connection each time trips fail2ban and sshd rate limits on shared lab servers — and
 * being locked out of a server is painful to undo. These share one master connection per host
 * instead: the first command opens it, the rest ride it over a local socket, and it lingers a few
 * minutes afterwards. Long-lived sessions deliberately do NOT multiplex, so one dropped connection
 * cannot take every session on that host down with it.
 */
export const CONTROL_DIR = resolve(ROOT, 'data/ssh');
export const sshControlOpts = () => [
  '-o', 'ControlMaster=auto',
  // %C is a short hash of (host, port, user) — a long socket path would exceed the unix socket limit
  '-o', `ControlPath=${CONTROL_DIR}/%C`,
  '-o', 'ControlPersist=5m',
];
export const SSH_SHORT = [...SSH_BASE, ...sshControlOpts()];

mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });

/**
 * Run the Claude Code CLI on another machine. `-T` is required: a TTY would corrupt the
 * stream-json protocol that rides this pipe.
 */
export function spawnRemote(cfg: HostConfig, a: SpawnArgs): SpawnedProcess {
  // The budget is spent HERE, not in the caller: this is the only way a session reaches a server,
  // so no future caller can route around the limit. Callers that can wait should call
  // sshThrottle.waitForSlot() first (which does not consume) to avoid failing needlessly.
  if (!sshThrottle.allow(cfg.ssh))
    throw new Error(`ssh 횟수 제한 (${cfg.ssh}: 분당 ${sshThrottle.limitFor(cfg.ssh)}회) — 잠시 후 다시 시도하세요`);
  // stdio is all pipes, so stdin/stdout are non-null — ChildProcess types them as nullable
  return spawn('ssh', [...SSH_BASE, cfg.ssh, remoteCommand(cfg, a)], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedProcess;
}

/** A host the office can start sessions on. `ssh: local` means this machine (plain SDK spawn). */
export class Host {
  view: HostView;
  private timer: NodeJS.Timeout | null = null;

  /** the host's $HOME, learned at check time — we quote every path, so the remote shell never expands ~ */
  private home: string | null = null;

  constructor(readonly cfg: HostConfig) {
    this.view = {
      id: cfg.id,
      name: cfg.name,
      local: cfg.ssh === 'local',
      ok: false,
      claudeVersion: null,
      projectRoot: cfg.projectRoot,
      sshUsed: 0,
      sshLimit: 0,
      error: '확인 중…',
    };
    if (cfg.ssh !== 'local') sshThrottle.setLimit(cfg.ssh, cfg.sshPerMinute);
  }

  /** Absolute path on this host: expands a leading ~ ourselves, since quoted paths are not expanded. */
  expand(p: string): string {
    if (!p.startsWith('~')) return p;
    if (!this.home) throw new Error(`${this.view.name} 의 홈 경로를 아직 모릅니다 (연결 확인 전)`);
    return p.replace(/^~(?=\/|$)/, this.home);
  }

  get isLocal() {
    return this.cfg.ssh === 'local';
  }

  /** `spawnClaudeCodeProcess` for this host, or undefined to let the SDK spawn locally. */
  spawner(): ((a: SpawnArgs) => SpawnedProcess) | undefined {
    return this.isLocal ? undefined : (a) => spawnRemote(this.cfg, a);
  }

  /**
   * Run a short command on the host. Over ssh this is rate limited: a skipped poll is harmless,
   * being locked out of the server is not.
   */
  private async exec(script: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; err: string }> {
    if (!this.isLocal && !sshThrottle.allow(this.cfg.ssh))
      return { code: -1, stdout: '', err: `ssh 횟수 제한 (${this.cfg.ssh}: 분당 ${sshThrottle.limitFor(this.cfg.ssh)}회) — 이번 확인은 건너뜁니다` };
    const p = this.isLocal ? spawn('bash', ['-lc', script]) : spawn('ssh', [...SSH_SHORT, this.cfg.ssh, script]);
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (err += d));
      p.on('error', (e) => {
        clearTimeout(t);
        resolve({ code: -1, stdout: out, err: String(e.message) });
      });
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, stdout: out, err });
      });
    });
  }

  /** A skipped health check must not flip a working host to "down". */
  async check() {
    const claude = this.cfg.claudePath || 'claude';
    const r = await this.exec(`printf '%s\\n' "$HOME"; ${sq(claude)} --version`);
    const [home, ...rest] = r.stdout.split('\n');
    if (r.code === 0 && home.trim()) this.home = home.trim();
    r.stdout = rest.join('\n');
    if (r.code === -1 && r.err.startsWith('ssh 횟수 제한')) return;
    this.refreshUsage(false);
    const next: HostView = r.code === 0
      ? { ...this.view, ok: true, claudeVersion: r.stdout.trim().split('\n').pop() ?? '', error: null }
      : { ...this.view, ok: false, error: `claude 실행 실패: ${(r.err || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}` };
    const changed = JSON.stringify(next) !== JSON.stringify(this.view);
    this.view = next;
    if (changed) bus.send({ t: 'host', data: { ...next } });
  }

  /** Does this directory exist on the host? (the backend can't stat a remote path) */
  async dirExists(dir: string): Promise<boolean> {
    return (await this.exec(`test -d ${sq(this.expand(dir))}`)).code === 0;
  }

  /** Immediate subdirectories of the host's projectRoot, for the project picker. */
  async listProjects(): Promise<string[]> {
    const r = await this.exec(`ls -1 ${sq(this.expand(this.cfg.projectRoot))} 2>/dev/null`);
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort() : [];
  }

  /** Keep the badge's ssh counter current; pushes only when the numbers actually move. */
  refreshUsage(push = true) {
    if (this.isLocal) return;
    const sshUsed = sshThrottle.used(this.cfg.ssh);
    const sshLimit = sshThrottle.limitFor(this.cfg.ssh);
    if (sshUsed === this.view.sshUsed && sshLimit === this.view.sshLimit) return;
    this.view = { ...this.view, sshUsed, sshLimit };
    if (push) bus.send({ t: 'host', data: { ...this.view } });
  }

  /** Absolute working directory for a project folder on this host. */
  projectDir(dir: string): string {
    return this.expand(dir.startsWith('/') || dir.startsWith('~') ? dir : `${this.cfg.projectRoot.replace(/\/$/, '')}/${dir}`);
  }

  /** true while a session is running on this host — then its liveness is already proven */
  hasLiveSession: () => boolean = () => false;

  start(everyMs = 180_000) {
    void this.check();
    this.timer = setInterval(() => {
      if (!this.hasLiveSession()) void this.check();
    }, everyMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class HostRegistry {
  private hosts = new Map<string, Host>();

  constructor(cfgs: HostConfig[]) {
    for (const c of cfgs) this.hosts.set(c.id, new Host(c));
  }
  get(id: string) {
    return this.hosts.get(id);
  }
  views(): HostView[] {
    for (const h of this.hosts.values()) h.refreshUsage(false);
    return [...this.hosts.values()].map((h) => ({ ...h.view }));
  }

  /** Push the ssh counter for every host that moved (called after a budget slot is taken). */
  refreshUsage() {
    for (const h of this.hosts.values()) h.refreshUsage();
  }
  /** Tell each host how to see whether one of its sessions is already proving it is up. */
  bindLiveness(anyLiveOn: (hostId: string) => boolean) {
    for (const h of this.hosts.values()) h.hasLiveSession = () => anyLiveOn(h.cfg.id);
  }
  start() {
    for (const h of this.hosts.values()) h.start();
  }
  stop() {
    for (const h of this.hosts.values()) h.stop();
  }
}
