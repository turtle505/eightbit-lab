import { execFile } from 'node:child_process';
import type { SshThrottle } from './sshRate.ts';

// One ssh connection per server, shared by everything the office does there.
//
// A campus network that sees several new ssh connections within a minute can take the machine for an
// attacker and cut it off. So the office opens ONE master connection per host (ssh ControlMaster) and
// runs every session, poll, transfer and tunnel as a channel inside it: however much is going on, the
// network sees one connection. This module is the only place that connection is opened, which makes it
// the only place the per-minute budget is spent.

export type MuxResult =
  | { ok: true }
  /** `throttled`: no room in this minute's budget. `down`: the last attempt failed and we are backing off. `failed`: this attempt failed. */
  | { ok: false; reason: 'throttled' | 'down' | 'failed'; err: string; retryInSec: number };

export interface MuxDeps {
  /** Is the master connection for this alias up? Must not touch the network (`ssh -O check`). */
  check(alias: string): Promise<boolean>;
  /** Open the master connection. The one call here that reaches the server. */
  open(alias: string): Promise<{ ok: boolean; err: string }>;
  /** Close the master connection (`ssh -O exit`): a request over the local socket. */
  close(alias: string): Promise<void>;
  now(): number;
}

export interface EnsureOpts {
  /** wait for room in the budget (someone is waiting for this) instead of giving up at once (a poll that can be skipped) */
  wait?: boolean;
  /** try even while backing off after a failure: the manager pressed "check again" */
  force?: boolean;
}

export const BACKOFF_FIRST_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;

export class SshMux {
  /** attempts in flight, so that callers arriving together share one */
  private flights = new Map<string, Promise<MuxResult>>();
  /** hosts whose last attempt failed: no new attempt before `until` */
  private down = new Map<string, { until: number; wait: number; err: string }>();
  /** aliases whose master was up at the last look (a cheap, synchronous answer for code that cannot await) */
  private ready = new Set<string>();

  constructor(
    private throttle: () => SshThrottle,
    private deps: MuxDeps,
  ) {}

  /** Was the master up the last time anyone looked? `ensure()` is the real check. */
  isReady(alias: string): boolean {
    return this.ready.has(alias);
  }

  /** Look whether the master is up, without opening it and without spending anything (keeps `isReady` current). */
  async peek(alias: string): Promise<boolean> {
    if (this.flights.has(alias)) return this.ready.has(alias); // an attempt is under way; its result will say
    const up = await this.deps.check(alias);
    if (up) this.ready.add(alias);
    else this.ready.delete(alias);
    return up;
  }

  /** Close the master. Whatever was riding it ends; the next `ensure()` opens a new one. */
  async close(alias: string): Promise<void> {
    await this.flights.get(alias)?.catch(() => {});
    this.ready.delete(alias);
    await this.deps.close(alias);
  }

  /** Seconds until a host that failed may be tried again (0 = it may be tried now). */
  retryIn(alias: string): number {
    const d = this.down.get(alias);
    return d ? Math.max(0, Math.ceil((d.until - this.deps.now()) / 1000)) : 0;
  }

  /**
   * Make sure the shared connection to `alias` exists, opening it if needed. However many callers arrive
   * at once, at most one connection attempt is made and they all get its result.
   */
  async ensure(alias: string, opts: EnsureOpts = {}): Promise<MuxResult> {
    for (;;) {
      let flight = this.flights.get(alias);
      const mine = !flight;
      if (!flight) {
        flight = this.attempt(alias, opts).finally(() => this.flights.delete(alias));
        this.flights.set(alias, flight);
      }
      const r = await flight;
      // someone else's attempt gave up on the budget at once, but this caller is willing to wait: go again
      if (!r.ok && r.reason === 'throttled' && opts.wait && !mine) continue;
      return r;
    }
  }

  private async attempt(alias: string, opts: EnsureOpts): Promise<MuxResult> {
    if (await this.deps.check(alias)) {
      this.ready.add(alias);
      this.down.delete(alias);
      return { ok: true };
    }
    this.ready.delete(alias);
    const d = this.down.get(alias);
    if (d && !opts.force && this.deps.now() < d.until) return { ok: false, reason: 'down', err: d.err, retryInSec: this.retryIn(alias) };

    const t = this.throttle();
    const got = opts.wait ? await t.reserve(alias, 70_000) : t.allow(alias, this.deps.now());
    if (!got) return { ok: false, reason: 'throttled', err: 'ssh connection budget for this minute is used up', retryInSec: Math.ceil(t.waitMs(alias, this.deps.now()) / 1000) };

    const r = await this.deps.open(alias);
    if (r.ok) {
      this.ready.add(alias);
      this.down.delete(alias);
      return { ok: true };
    }
    // a server that does not answer is left alone for a while, longer each time: every knock is a new connection
    const wait = Math.min(d ? d.wait * 2 : BACKOFF_FIRST_MS, BACKOFF_MAX_MS);
    this.down.set(alias, { until: this.deps.now() + wait, wait, err: r.err });
    return { ok: false, reason: 'failed', err: r.err, retryInSec: Math.ceil(wait / 1000) };
  }
}

/** printed by a client that found no master to ride (see muxClientOpts) */
export const NO_MASTER = 'eightbit-no-master';

/**
 * ssh options for a command that rides the master. It never opens a master of its own, and it cannot
 * open a plain connection either: ssh only runs ProxyCommand when it has to connect by itself, so with
 * the master's socket missing it fails on the spot (no DNS lookup, no packet) instead of quietly making
 * the extra connection this whole module exists to prevent. Given on the command line, it also wins
 * over any ProxyJump in ~/.ssh/config.
 */
export const muxClientOpts = (controlDir: string): string[] => ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlDir}/%C`, '-o', `ProxyCommand=echo ${NO_MASTER} >&2; false`];

/** Did an ssh client fail because the master it was to ride was gone? */
export const isNoMaster = (stderr: string): boolean => stderr.includes(NO_MASTER);

/** How long the master stays after its last channel closes. Sessions and polls keep it open; an idle office lets it go. */
export const CONTROL_PERSIST = '10m';

const run = (args: string[], timeoutMs: number) =>
  new Promise<{ code: number; err: string }>((res) => {
    execFile('ssh', args, { timeout: timeoutMs, encoding: 'utf8' }, (e, _out, stderr) => res({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : -1) : 0, err: String(stderr ?? '') }));
  });

/** The real thing: `ssh -O check` to look (a local socket, no network), and one `ssh … true` to open the master. */
export function realMuxDeps(controlDir: string): MuxDeps {
  const path = `ControlPath=${controlDir}/%C`;
  return {
    check: async (alias) => (await run(['-O', 'check', '-o', path, alias], 5_000)).code === 0,
    open: async (alias) => {
      // ControlMaster=auto, not yes: a socket file left behind by a dead master is cleaned up and replaced
      const r = await run(
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
          '-o', 'ControlMaster=auto', '-o', path, '-o', `ControlPersist=${CONTROL_PERSIST}`, alias, 'true'],
        40_000,
      );
      return { ok: r.code === 0, err: r.err.trim().split('\n').pop() || (r.code === 0 ? '' : `ssh exit ${r.code}`) };
    },
    close: async (alias) => void (await run(['-O', 'exit', '-o', path, alias], 5_000)),
    now: () => Date.now(),
  };
}

/** sshd refuses a new channel on a connection that already carries its limit (MaxSessions, 10 by default). */
export const isChannelLimit = (stderr: string): boolean => /open failed: administratively prohibited|channel \d+: open failed|mux_client_request_session: session request failed/i.test(stderr);
