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

  constructor(readonly perMinute: number) {}

  private prune(key: string, now: number): number[] {
    const kept = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000);
    this.recent.set(key, kept);
    return kept;
  }

  /** Take a slot if one is free. Returns false when the host is at its budget. */
  allow(key: string, now = Date.now()): boolean {
    const kept = this.prune(key, now);
    if (kept.length >= this.perMinute) return false;
    kept.push(now);
    return true;
  }

  /** How long until a slot frees up (0 when one is free now). */
  waitMs(key: string, now = Date.now()): number {
    const kept = this.prune(key, now);
    if (kept.length < this.perMinute) return 0;
    return Math.max(0, 60_000 - (now - kept[0]) + 50);
  }

  /** Wait for a slot, up to `maxWaitMs`. Resolves true when taken, false on timeout. */
  async reserve(key: string, maxWaitMs = 70_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      if (this.allow(key)) return true;
      const wait = this.waitMs(key);
      if (Date.now() + wait > deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(wait, 2_000)));
    }
  }

  /** Runs in the window right now, for diagnostics. */
  used(key: string, now = Date.now()): number {
    return this.prune(key, now).length;
  }
}
