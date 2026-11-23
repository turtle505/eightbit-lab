/**
 * Shared lab servers ban clients that connect too often, and getting unblocked is painful.
 * Every ssh/scp the office starts goes through here first: a sliding one-minute window per host.
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

  constructor(readonly perMinute: number) {}

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
    kept.push(now);
    return true;
  }

  /** How long until a slot frees up (0 when one is free now). */
  waitMs(key: string, now = Date.now()): number {
    const limit = this.limitFor(key);
    if (limit <= 0) return 0;
    const kept = this.prune(key, now);
    if (kept.length < limit) return 0;
    return Math.max(0, 60_000 - (now - kept[0]) + 50);
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
    const m = /(?:^|[\s;&|(]|\$\()\s*(?:[\w./-]*\/)?(ssh|scp|rsync|sftp|sshfs)\s+([^\n;&|]*)/.exec(String(command ?? ''));
    if (!m) return null;
    const [, tool, tail] = m;
    const bare = (w: string) => {
      const host = (w.includes('@') ? w.split('@').pop()! : w).trim();
      return host && !host.includes('/') ? host : null;
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
