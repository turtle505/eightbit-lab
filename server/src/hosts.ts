import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { tr } from '../../shared/i18n.ts';
import type { HostView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import { sq } from './compute/adapter.ts';
import { ROOT, type HostConfig } from './config.ts';
import { SshThrottle } from './sshRate.ts';
import { isChannelLimit, isNoMaster, muxClientOpts, realMuxDeps, SshMux, type MuxDeps, type MuxResult } from './sshMux.ts';

/** Every new ssh connection is counted here; index.ts replaces it with the configured limits. */
export let sshThrottle = new SshThrottle(5, 4);
export const setSshLimit = (perMinute: number, total = 4) => (sshThrottle = new SshThrottle(perMinute, total));

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
 * Everything the office runs on a host — sessions, Codex turns, polls, transfers, tunnels — rides ONE
 * master connection per host (see sshMux.ts): a campus network that sees several new ssh connections in a
 * minute can take the machine for an attacker and cut it off. The master is opened only by
 * `sshMux.ensure()`, which is also the only place the per-minute budget is spent; commands then attach to
 * its socket in data/ssh and never open a connection of their own.
 *
 * Sessions used to keep a connection each, so that one dropped connection could not take every session on
 * a host down. That is given up on purpose: a dropped master ends the sessions on it (their conversations
 * resume on the next instruction, and a task cut off is marked for retry), which is far cheaper than a
 * blocked network port.
 */
/**
 * Where the master sockets live. A unix socket path is limited to about 104 bytes and ssh adds a
 * 40-character name plus a temporary suffix, so an install in a deep folder gets a short folder under
 * ~/.ssh instead of data/ssh (named after the install, so two offices on one machine stay apart).
 */
export function controlDirFor(root: string, home = homedir()): string {
  const local = resolve(root, 'data/ssh');
  return local.length <= 40 ? local : resolve(home, '.ssh', `8bit-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`);
}
export const CONTROL_DIR = controlDirFor(ROOT);
/** options that attach a command to the host's master connection (%C keeps the socket path short) */
export const sshControlOpts = () => muxClientOpts(CONTROL_DIR);
/** every ssh the office spawns uses these */
export const SSH_MUX = [...SSH_BASE, ...sshControlOpts()];

mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });

/** The master connections. Tests swap the deps so nothing touches the network. */
export let sshMux = new SshMux(() => sshThrottle, realMuxDeps(CONTROL_DIR));
export const setMuxDeps = (deps: MuxDeps) => (sshMux = new SshMux(() => sshThrottle, deps));

/** Why a connection could not be had, as a line for the manager. */
export function muxErrorText(alias: string, r: Extract<MuxResult, { ok: false }>): string {
  if (r.reason === 'throttled')
    return tr({ ko: `ssh 접속 한도 (${alias}: 분당 ${sshThrottle.limitFor(alias)}회, 전체 ${sshThrottle.total}회) — ${r.retryInSec}초 뒤 다시 시도하세요`, en: `ssh connection limit (${alias}: ${sshThrottle.limitFor(alias)} per minute, ${sshThrottle.total} in all). Try again in ${r.retryInSec}s.` });
  if (r.reason === 'down')
    return tr({ ko: `${alias}에 접속할 수 없습니다 (${r.err}). 반복 접속을 피하려고 ${r.retryInSec}초 동안 다시 시도하지 않습니다.`, en: `Cannot connect to ${alias} (${r.err}). Not trying again for ${r.retryInSec}s, to avoid knocking repeatedly.` });
  return tr({ ko: `${alias} 접속 실패: ${r.err}`, en: `Could not connect to ${alias}: ${r.err}` });
}

/** What ssh says when the master already carries as many channels as the server allows. */
export const channelLimitText = (alias: string) =>
  tr({ ko: `${alias}의 동시 세션이 너무 많습니다 (접속 하나에 서버가 받는 채널 수를 넘음). 다른 세션이 끝난 뒤 다시 시도하세요.`, en: `Too many things running on ${alias} at once (over the channels the server allows on one connection). Try again when another session has finished.` });
export { isChannelLimit };

/**
 * Run the Claude Code CLI on another machine. `-T` is required: a TTY would corrupt the
 * stream-json protocol that rides this pipe.
 */
export function spawnRemote(cfg: HostConfig, a: SpawnArgs): SpawnedProcess {
  // This cannot await, so it cannot open the master itself: the caller must have awaited
  // sshMux.ensure(cfg.ssh). Refusing here means no future caller can start a session that would
  // quietly open its own connection.
  if (!sshMux.isReady(cfg.ssh))
    throw new Error(tr({ ko: `${cfg.ssh} 접속이 준비되지 않았습니다 — 잠시 후 다시 시도하세요`, en: `No connection to ${cfg.ssh} yet. Try again shortly.` }));
  const p = spawn('ssh', [...SSH_MUX, cfg.ssh, remoteCommand(cfg, a)], { stdio: ['pipe', 'pipe', 'pipe'] });
  // the one ssh failure worth translating: the master already carries as many channels as the server allows
  // or the master went away in the instant between the check and this spawn (it does not connect on its own)
  let told = false;
  p.stderr.on('data', (d) => {
    const s = String(d);
    if (told || !(isChannelLimit(s) || isNoMaster(s))) return;
    told = true;
    bus.send({ t: 'notice', level: 'warn', text: isNoMaster(s) ? tr({ ko: `${cfg.ssh} 접속이 방금 끊겼습니다. 다시 지시하면 새로 연결합니다.`, en: `The connection to ${cfg.ssh} just dropped. Give the instruction again to reconnect.` }) : channelLimitText(cfg.ssh) });
  });
  // stdio is all pipes, so stdin/stdout are non-null — ChildProcess types them as nullable
  return p as unknown as SpawnedProcess;
}

/** A host the office can start sessions on. `ssh: local` means this machine (plain SDK spawn). */
export class Host {
  view: HostView;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

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
      connected: false,
      sessions: 0,
      retryInSec: 0,
      error: tr({ ko: '확인 중…', en: 'Checking…' }),
    };
    if (cfg.ssh !== 'local') sshThrottle.setLimit(cfg.ssh, cfg.sshPerMinute);
  }

  /** Absolute path on this host: expands a leading ~ ourselves, since quoted paths are not expanded. */
  expand(p: string): string {
    if (!p.startsWith('~')) return p;
    if (!this.home) throw new Error(
        tr({
          ko: `${this.view.name} 의 홈 경로를 아직 모릅니다 (연결 확인 전)`,
          en: `The home path of ${this.view.name} is not known yet (connection not checked)`,
        }),
      );
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
   * Run a short command on the host, over its shared connection. If that connection is not up and cannot
   * be opened right now (budget used up, or the host is being left alone after a failure) the command is
   * skipped: a missed poll is harmless, another knock on the server is not.
   */
  private async exec(script: string, timeoutMs = 20_000, force = false): Promise<{ code: number; stdout: string; err: string; throttled?: boolean }> {
    if (!this.isLocal) {
      const m = await sshMux.ensure(this.cfg.ssh, { wait: false, force });
      if (!m.ok) return { code: -1, stdout: '', throttled: m.reason === 'throttled', err: muxErrorText(this.cfg.ssh, m) };
    }
    const p = this.isLocal ? spawn('bash', ['-lc', script]) : spawn('ssh', [...SSH_MUX, this.cfg.ssh, script]);
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
  async check(force = false) {
    const claude = this.cfg.claudePath || 'claude';
    const r = await this.exec(`printf '%s\\n' "$HOME"; ${sq(claude)} --version`, 20_000, force);
    const [home, ...rest] = r.stdout.split('\n');
    if (r.code === 0 && home.trim()) this.home = home.trim();
    r.stdout = rest.join('\n');
    if (r.throttled) return;
    this.refreshUsage(false);
    const fail = (r.err || r.stdout).trim().split('\n').pop() || `exit ${r.code}`;
    // no connection at all is a different thing to say than "connected, but claude did not run"
    const noConn = !this.isLocal && !sshMux.isReady(this.cfg.ssh);
    const next: HostView = r.code === 0
      ? { ...this.view, ok: true, claudeVersion: r.stdout.trim().split('\n').pop() ?? '', error: null }
      : { ...this.view, ok: false, error: noConn ? fail : tr({ ko: `claude 실행 실패: ${fail}`, en: `Failed to run claude: ${fail}` }) };
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

  /** how many sessions are open on this host (bound by the registry to the agents' views) */
  countSessions: () => number = () => 0;

  /** Keep the host's live numbers current (ssh budget, connection, sessions); pushes only when something moved. */
  refreshUsage(push = true) {
    const sessions = this.countSessions();
    const remote = !this.isLocal;
    const sshUsed = remote ? sshThrottle.used(this.cfg.ssh) : 0;
    const sshLimit = remote ? sshThrottle.limitFor(this.cfg.ssh) : 0;
    const connected = remote && sshMux.isReady(this.cfg.ssh);
    const retryInSec = remote ? sshMux.retryIn(this.cfg.ssh) : 0;
    const v = this.view;
    if (sshUsed === v.sshUsed && sshLimit === v.sshLimit && connected === v.connected && sessions === v.sessions && retryInSec === v.retryInSec) return;
    this.view = { ...v, sshUsed, sshLimit, connected, sessions, retryInSec };
    if (push) bus.send({ t: 'host', data: { ...this.view } });
  }

  /** Look at the connection locally (no packet leaves) and refresh the numbers: the master closes by itself when idle. */
  async watch() {
    if (!this.isLocal) await sshMux.peek(this.cfg.ssh);
    this.refreshUsage();
  }

  /** Absolute working directory for a project folder on this host. */
  projectDir(dir: string): string {
    return this.expand(dir.startsWith('/') || dir.startsWith('~') ? dir : `${this.cfg.projectRoot.replace(/\/$/, '')}/${dir}`);
  }

  /** true while a session is running on this host — then its liveness is already proven */
  hasLiveSession: () => boolean = () => false;
  private retryMs = 30_000;

  /**
   * Check once, then stop touching the host. A reachable server gets no traffic at all while idle —
   * polling only existed to keep a badge fresh, which is not worth knocking on a machine that bans
   * noisy clients. We re-check only when it failed (backing off), or on demand.
   *
   * The cost is a badge that can go stale: if the server dies we keep showing "connected" until
   * something actually uses it, and then the real error is reported. Better than a confident guess.
   */
  start() {
    void this.checkThenMaybeRetry();
  }

  private async checkThenMaybeRetry(force = false) {
    if (this.stopped) return;
    await this.check(force);
    if (this.view.ok) {
      this.retryMs = 30_000; // healthy: no timer at all
      return;
    }
    // unreachable, and we need its $HOME before any session can start — keep trying, slower each time
    this.timer = setTimeout(() => void this.checkThenMaybeRetry(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 300_000);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Manual re-check (the UI refresh button), and used before a session when we never got through. */
  async recheck(force = true) {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // asked for by a person (force): try now even if we were leaving the host alone
    await this.checkThenMaybeRetry(force);
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
  /** Check a host we never got through to; a healthy one is left alone. */
  async ensureChecked(id: string) {
    const h = this.hosts.get(id);
    // not forced: an instruction arriving for a host that is down must not become another knock on it
    if (h && !h.view.ok) await h.recheck(false);
  }

  /** Tell each host how to see whether one of its sessions is already proving it is up. */
  bindLiveness(anyLiveOn: (hostId: string) => boolean) {
    for (const h of this.hosts.values()) h.hasLiveSession = () => anyLiveOn(h.cfg.id);
  }
  /** Tell each host how to count the sessions open on it. */
  bindSessions(openOn: (hostId: string) => number) {
    for (const h of this.hosts.values()) h.countSessions = () => openOn(h.cfg.id);
  }
  private watcher: NodeJS.Timeout | null = null;
  start(watchEveryMs = 20_000) {
    for (const h of this.hosts.values()) h.start();
    // a local look every so often keeps "connected" and the session count honest without touching any server
    this.watcher = setInterval(() => void Promise.all([...this.hosts.values()].map((h) => h.watch())), watchEveryMs);
  }
  stop() {
    for (const h of this.hosts.values()) h.stop();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }
}
