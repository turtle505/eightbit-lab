import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UsageRow, UsageView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';

/** Raw rows as the claude.ai usage endpoint sends them (subset we use). */
export interface RawLimit {
  kind: string;
  group?: string;
  percent: number;
  resets_at: string | null;
  severity?: string;
  scope?: { model?: { display_name?: string } | null; surface?: { display_name?: string } | null } | null;
}
interface RawWindow {
  utilization: number | null;
  resets_at: string | null;
}
export interface RawUsage {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: { limits?: RawLimit[] | null; five_hour?: RawWindow | null; seven_day?: RawWindow | null } | null;
}

const KIND_LABEL: Record<string, string> = { session: '세션 (5시간)', weekly_all: '주간 (전체)', weekly_scoped: '주간' };

/** Turn the endpoint's reply into display rows. Prefers the server's own `limits[]`; falls back to five_hour / seven_day. */
export function toUsageRows(raw: RawUsage): UsageRow[] {
  const rl = raw.rate_limits;
  if (!rl) return [];
  const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || null : null);
  if (rl.limits?.length) {
    return rl.limits.map((l) => {
      const scope = l.scope?.model?.display_name ?? l.scope?.surface?.display_name;
      const base = KIND_LABEL[l.kind] ?? l.kind;
      return {
        kind: l.kind,
        label: scope ? `${base} · ${scope}` : base,
        percent: Math.round(l.percent ?? 0),
        resetsAt: ms(l.resets_at),
        severity: l.severity ?? 'normal',
      };
    });
  }
  const rows: UsageRow[] = [];
  const sev = (p: number) => (p >= 90 ? 'critical' : p >= 75 ? 'warning' : 'normal');
  if (rl.five_hour?.utilization != null)
    rows.push({ kind: 'session', label: KIND_LABEL.session, percent: Math.round(rl.five_hour.utilization), resetsAt: ms(rl.five_hour.resets_at), severity: sev(rl.five_hour.utilization) });
  if (rl.seven_day?.utilization != null)
    rows.push({ kind: 'weekly_all', label: KIND_LABEL.weekly_all, percent: Math.round(rl.seven_day.utilization), resetsAt: ms(rl.seven_day.resets_at), severity: sev(rl.seven_day.utilization) });
  return rows;
}

const METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/**
 * Polls the Claude subscription's usage meters (5-hour session, weekly) through an idle SDK session:
 * the CLI is started with a prompt stream that never yields, so no turn runs and no tokens are spent.
 * The SDK marks this API experimental — failures degrade to "unavailable", never crash the office.
 */
export class UsageMonitor {
  view: UsageView = { available: false, plan: null, rows: [], fetchedAt: null, note: '확인 중' };
  private q: Query | null = null;
  private release: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(private cwd: string) {}

  start(everyMs = 3 * 60_000) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
  }

  /** Refresh soon (coalesces bursts, e.g. several agents finishing together). */
  poke(delayMs = 5_000) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), delayMs);
  }

  private session(): Query {
    if (this.q) return this.q;
    const idle = (async function* (this: UsageMonitor): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((r) => (this.release = r));
    }).call(this);
    this.q = query({ prompt: idle, options: { cwd: this.cwd, persistSession: false } });
    return this.q;
  }

  private resetSession() {
    this.release?.();
    try {
      this.q?.close();
    } catch {
      /* already closed */
    }
    this.q = null;
    this.release = null;
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const q = this.session() as any;
        if (typeof q[METHOD] !== 'function') {
          this.set({ available: false, plan: null, rows: [], fetchedAt: Date.now(), note: '이 SDK 버전은 사용량 조회를 지원하지 않습니다' });
          return;
        }
        const raw: RawUsage = await Promise.race([
          q[METHOD]({ skipBehaviors: true }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('시간 초과')), 30_000)),
        ]);
        if (!raw.rate_limits_available || !raw.rate_limits) {
          this.set({ available: false, plan: raw.subscription_type ?? null, rows: [], fetchedAt: Date.now(), note: '구독 한도 정보 없음 (API 키 사용 등)' });
          return;
        }
        this.set({ available: true, plan: raw.subscription_type ?? null, rows: toUsageRows(raw), fetchedAt: Date.now(), note: '' });
      } catch (e) {
        this.resetSession(); // start a fresh CLI next time
        this.set({ ...this.view, fetchedAt: Date.now(), note: `조회 실패: ${(e as Error).message}`.slice(0, 160) });
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  private set(v: UsageView) {
    this.view = v;
    bus.send({ t: 'usage', data: v });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.resetSession();
  }
}
