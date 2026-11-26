import { execFile, spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { UpdateView } from '../../shared/protocol.ts';

// Updating from the screen: look whether the remote branch has commits this checkout lacks (git fetch), show
// them, and on request run the same script `npm run update` runs. Nothing here decides how to update; the
// script does (busy check → pull → build → restart), and it takes no arguments from the browser.

export const UNIT = 'eightbit-lab';
const COMMITS_SHOWN = 20;
const LOG_LINES = 40;

/**
 * How far behind the upstream branch this checkout is, from `git rev-list --count HEAD..@{u}` and
 * `git log --format=%s HEAD..@{u}`. Anything that is not a count (no upstream, an error text) is 0.
 */
export function parseBehind(countOut: string, logOut: string): { behind: number; commits: string[] } {
  const n = /^\d+$/.test(countOut.trim()) ? Number(countOut.trim()) : 0;
  const commits = n ? logOut.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, COMMITS_SHOWN) : [];
  return { behind: n, commits };
}

export interface UpdateDeps {
  /** run git in the checkout; rejects when git fails */
  git(args: string[], timeoutMs?: number): Promise<string>;
  /** can this process be restarted by the script? (it runs as the systemd user unit) */
  canRestart(): boolean;
  /** run the update script, calling `onLine` per output line; resolves with its exit code */
  runScript(onLine: (line: string) => void): Promise<number>;
}

export function realDeps(root: string): UpdateDeps {
  return {
    git: (args, timeoutMs = 20_000) =>
      new Promise((res, rej) => {
        execFile('git', args, { cwd: root, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out) => (err ? rej(err) : res(out.trim())));
      }),
    // INVOCATION_ID is set by systemd for a service it started: a backend started by hand on a machine that
    // also has the unit must not "restart" into a second copy
    canRestart: () => !!process.env.INVOCATION_ID && spawnSync('systemctl', ['--user', 'cat', UNIT], { stdio: 'ignore' }).status === 0,
    runScript: (onLine) =>
      new Promise((res) => {
        // a service's PATH may lack node's own folder (nvm): put it first so `npm` and `tsx` resolve
        const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
        const p = spawn('npm', ['run', '--silent', 'update'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        const feed = (d: Buffer) => {
          buf += d.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const l of lines) if (l.trim()) onLine(l);
        };
        p.stdout.on('data', feed);
        p.stderr.on('data', feed);
        p.on('error', (err) => {
          onLine(String(err.message));
          res(-1);
        });
        p.on('close', (code) => {
          if (buf.trim()) onLine(buf);
          res(code ?? -1);
        });
      }),
  };
}

export type ApplyResult = 'started' | 'running' | 'no-restart' | 'busy';

export class Updater {
  view: UpdateView = { version: null, behind: 0, commits: [], checkedAt: 0, canRestart: false, running: false, log: [], ok: false };
  private checking: Promise<UpdateView> | null = null;

  constructor(
    private deps: UpdateDeps,
    private onChange: (v: UpdateView) => void = () => {},
  ) {}

  /** The commit this process started on (call once at boot): what the browser compares after a reconnect. */
  async init(): Promise<void> {
    this.view.canRestart = this.deps.canRestart();
    try {
      this.view.version = await this.deps.git(['rev-parse', '--short', 'HEAD']);
    } catch {
      this.view.version = null; // not a git checkout: nothing to update from
    }
  }

  /** Fetch and compare with the upstream branch. Never throws; `ok: false` means it could not tell. */
  check(): Promise<UpdateView> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        if (this.view.version == null) throw new Error('not a git checkout');
        await this.deps.git(['fetch', '--quiet']);
        const count = await this.deps.git(['rev-list', '--count', 'HEAD..@{u}']);
        const log = await this.deps.git(['log', '--format=%s', `-n${COMMITS_SHOWN}`, 'HEAD..@{u}']);
        Object.assign(this.view, parseBehind(count, log), { ok: true });
      } catch {
        Object.assign(this.view, { behind: 0, commits: [], ok: false });
      }
      this.view.checkedAt = Date.now();
      this.checking = null;
      this.onChange(this.view);
      return this.view;
    })();
    return this.checking;
  }

  /**
   * Run the update script, one run at a time. `busy` are the employees working now: with any, nothing is run
   * (the script would refuse too; this answers faster and names them).
   */
  apply(busy: string[]): ApplyResult {
    if (this.view.running) return 'running';
    if (!this.view.canRestart) return 'no-restart';
    if (busy.length) return 'busy';
    this.view.running = true;
    this.view.log = [];
    this.onChange(this.view);
    void this.deps
      .runScript((line) => {
        this.view.log = [...this.view.log, line].slice(-LOG_LINES);
        this.onChange(this.view);
      })
      .then(async (code) => {
        // still here: the script stopped before the restart (nothing new, or a step failed and it said so)
        this.view.running = false;
        if (code !== 0) this.view.log = [...this.view.log, `✖ exit ${code}`].slice(-LOG_LINES);
        this.onChange(this.view);
        await this.check();
      });
    return 'started';
  }
}
