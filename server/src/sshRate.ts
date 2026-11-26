/**
 * Shared lab servers ban clients that connect too often, and a campus network can cut a machine off
 * for looking like an attack. Every NEW ssh connection the office starts is counted here first, in a
 * sliding one-minute window per host and in one window for the whole machine (the network watching us
 * does not care which server each connection went to).
 *
 * Polling (health, GPU, jobs) calls `allow()` and simply skips the round when it would go over
 * budget — a missed poll costs nothing. Opening a session calls `reserve()`, which waits for a slot
 * instead of failing, because the manager is sitting there expecting it to start.
 */
export class SshThrottle {
  /** start times of the ssh/scp runs still inside the window, per host */
  private recent = new Map<string, number[]>();
  /** per-host overrides; servers have different policies, so each can set its own */
  private limits = new Map<string, number>();

  /** start times of every counted run on a limited host: the machine-wide window */
  private all: number[] = [];

  /** `total` caps new connections from this machine per minute across all hosts; 0 or less = no machine-wide cap */
  constructor(readonly perMinute: number, readonly total = 0) {}

  private pruneAll(now: number): number[] {
    this.all = this.all.filter((t) => now - t < 60_000);
    return this.all;
  }

  /** 0 or less means "no limit on this host". */
  setLimit(key: string, perMinute: number | undefined) {
    if (perMinute === undefined) this.limits.delete(key);
    else this.limits.set(key, perMinute);
  }
  limitFor(key: string): number {
    return this.limits.get(key) ?? this.perMinute;
  }

  private prune(key: string, now: number): number[] {
    const kept = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000);
    this.recent.set(key, kept);
    return kept;
  }

  /** Take a slot if one is free. Returns false when the host is at its budget. */
  allow(key: string, now = Date.now()): boolean {
    const limit = this.limitFor(key);
    if (limit <= 0) return true; // this host opted out
    const kept = this.prune(key, now);
    if (kept.length >= limit) return false;
    if (this.total > 0 && this.pruneAll(now).length >= this.total) return false;
    kept.push(now);
    this.all.push(now);
    return true;
  }

  /**
   * Take one slot per entry of `keys` (a command that connects several times), all or none.
   * Returns the host that is out of room, or null when every slot was taken.
   */
  allowAll(keys: string[], now = Date.now()): string | null {
    const need = new Map<string, number>();
    for (const k of keys) if (this.limitFor(k) > 0) need.set(k, (need.get(k) ?? 0) + 1);
    let counted = 0;
    for (const [k, n] of need) {
      if (this.prune(k, now).length + n > this.limitFor(k)) return k;
      counted += n;
    }
    if (this.total > 0 && this.pruneAll(now).length + counted > this.total) return keys.find((k) => this.limitFor(k) > 0) ?? keys[0];
    for (const [k, n] of need) for (let i = 0; i < n; i++) {
      this.recent.get(k)!.push(now);
      this.all.push(now);
    }
    return null;
  }

  /** Connections counted in the last minute across every host. */
  usedTotal(now = Date.now()): number {
    return this.pruneAll(now).length;
  }

  /** How long until a slot frees up (0 when one is free now). */
  waitMs(key: string, now = Date.now()): number {
    const limit = this.limitFor(key);
    if (limit <= 0) return 0;
    const kept = this.prune(key, now);
    const own = kept.length < limit ? 0 : Math.max(0, 60_000 - (now - kept[0]) + 50);
    const all = this.pruneAll(now);
    const machine = this.total > 0 && all.length >= this.total ? Math.max(0, 60_000 - (now - all[0]) + 50) : 0;
    return Math.max(own, machine);
  }

  /** Wait for a slot, up to `maxWaitMs`, and take it. Resolves true when taken, false on timeout. */
  async reserve(key: string, maxWaitMs = 70_000): Promise<boolean> {
    if (!(await this.waitForSlot(key, maxWaitMs))) return false;
    return this.allow(key);
  }

  /**
   * Wait until a slot is free WITHOUT taking it — for callers whose actual spawn takes the slot
   * itself, so there is exactly one place that spends budget and no double counting.
   */
  async waitForSlot(key: string, maxWaitMs = 70_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const wait = this.waitMs(key);
      if (wait === 0) return true;
      if (Date.now() + wait > deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(wait, 2_000)));
    }
  }

  /** Runs in the window right now, for the host badge. */
  used(key: string, now = Date.now()): number {
    return this.prune(key, now).length;
  }

  /**
   * Which host a shell command would connect to, best effort: `ssh [flags] host ...` or
   * `scp/rsync ... user@host:path`. Returns null when we can't tell, and then we don't block it.
   */
  static targetOf(command: string): string | null {
    return SshThrottle.targetsOf(command)[0] ?? null;
  }

  /**
   * Every host a shell command would connect to, one entry per ssh/scp/rsync/sftp it runs
   * ("ssh a x; ssh a y && scp f b:/p" → [a, a, b]). An occurrence whose host cannot be worked out is left out.
   */
  static targetsOf(command: string): string[] {
    const out: string[] = [];
    const re = /(?:^|[\s;&|(]|\$\()\s*(?:[\w./-]*\/)?(ssh|scp|rsync|sftp|sshfs)\s+([^\n;&|]*)/g;
    for (const m of String(command ?? '').matchAll(re)) {
      const host = SshThrottle.hostOf(m[1], m[2]);
      if (host) out.push(host);
    }
    return out;
  }

  /**
   * Does the command run ssh a number of times we cannot count? A loop, xargs, parallel or watch
   * around an ssh/scp/rsync: one command, any number of connections.
   */
  static loopsOverSsh(command: string): boolean {
    const c = String(command ?? '');
    if (!SshThrottle.targetsOf(c).length && !/\b(ssh|scp|rsync|sftp)\b/.test(c)) return false;
    return /(?:^|[\s;&|(])(?:for|while|until)\s[\s\S]*?[;\n]\s*do\b/.test(c) || /(?:^|[\s;&|(])(?:xargs|parallel|watch)\s/.test(c);
  }

  private static hostOf(tool: string, tail: string): string | null {
    const bare = (w: string) => {
      const host = (w.includes('@') ? w.split('@').pop()! : w).trim().replace(/^["']|["']$/g, '');
      return host && !host.includes('/') && !host.startsWith('$') ? host : null;
    };

    const words: string[] = [];
    const parts = tail.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const w = parts[i];
      if (!w.startsWith('-')) {
        words.push(w);
        continue;
      }
      if (/^-[oiplFbcDeJLRWS]$/.test(w)) i++; // these flags swallow the next word
    }

    // ssh takes the host as its first positional; scp/rsync put it in the `host:path` argument
    if (tool === 'ssh' || tool === 'sftp') return words.length ? bare(words[0]) : null;
    for (const w of words) {
      const colon = w.indexOf(':');
      if (colon > 0 && !w.slice(0, colon).includes('/')) return bare(w.slice(0, colon));
    }
    return null; // local to local, or we simply can't tell
  }
}
