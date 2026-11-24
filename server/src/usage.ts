import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UsageRow, UsageView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import { tr } from '../../shared/i18n.ts';

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

/** Display label of a limit kind, in the current language (looked up per call so it follows a language switch). */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'session':
      return tr({ ko: '세션 (5시간)', en: 'Session (5 h)' });
    case 'weekly_all':
      return tr({ ko: '주간 (전체)', en: 'Weekly (all)' });
    case 'weekly_scoped':
      return tr({ ko: '주간', en: 'Weekly' });
  }
  return kind;
}

const rowLabel = (kind: string, scope?: string) => (scope ? `${kindLabel(kind)} · ${scope}` : kindLabel(kind));

/** Re-derive the labels from `kind` / `scope`, e.g. after the office language changed. */
export const relabelUsageRows = (rows: UsageRow[]): UsageRow[] => rows.map((r) => ({ ...r, label: rowLabel(r.kind, r.scope) }));

/** Turn the endpoint's reply into display rows. Prefers the server's own `limits[]`; falls back to five_hour / seven_day. */
export function toUsageRows(raw: RawUsage): UsageRow[] {
  const rl = raw.rate_limits;
  if (!rl) return [];
  const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || null : null);
  if (rl.limits?.length) {
    return rl.limits.map((l) => {
      const scope = l.scope?.model?.display_name ?? l.scope?.surface?.display_name ?? undefined;
      return {
        kind: l.kind,
        label: rowLabel(l.kind, scope),
        ...(scope ? { scope } : {}),
        percent: Math.round(l.percent ?? 0),
        resetsAt: ms(l.resets_at),
        severity: l.severity ?? 'normal',
      };
    });
  }
  const rows: UsageRow[] = [];
  const sev = (p: number) => (p >= 90 ? 'critical' : p >= 75 ? 'warning' : 'normal');
  if (rl.five_hour?.utilization != null)
    rows.push({ kind: 'session', label: rowLabel('session'), percent: Math.round(rl.five_hour.utilization), resetsAt: ms(rl.five_hour.resets_at), severity: sev(rl.five_hour.utilization) });
  if (rl.seven_day?.utilization != null)
    rows.push({ kind: 'weekly_all', label: rowLabel('weekly_all'), percent: Math.round(rl.seven_day.utilization), resetsAt: ms(rl.seven_day.resets_at), severity: sev(rl.seven_day.utilization) });
  return rows;
}

const METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

class UsageTimeout extends Error {}

/** Why the meters are unavailable; turned into text only when the view is read, so it follows the language. */
type Note = { code: '' } | { code: 'checking' } | { code: 'unsupported' } | { code: 'noLimits' } | { code: 'failed'; timeout: boolean; detail: string };

function noteText(n: Note): string {
  switch (n.code) {
    case '':
      return '';
    case 'checking':
      return tr({ ko: '확인 중', en: 'Checking' });
    case 'unsupported':
      return tr({ ko: '이 SDK 버전은 사용량 조회를 지원하지 않습니다', en: 'This SDK version cannot report usage' });
    case 'noLimits':
      return tr({ ko: '구독 한도 정보 없음 (API 키 사용 등)', en: 'No subscription limits (API key in use?)' });
    case 'failed': {
      const why = n.timeout ? tr({ ko: '시간 초과', en: 'timed out' }) : n.detail;
      return tr({ ko: `조회 실패: ${why}`, en: `Lookup failed: ${why}` }).slice(0, 160);
    }
  }
}

type UsageState = Omit<UsageView, 'note'> & { note: Note };

/**
 * Polls the Claude subscription's usage meters (5-hour session, weekly) through an idle SDK session:
 * the CLI is started with a prompt stream that never yields, so no turn runs and no tokens are spent.
 * The SDK marks this API experimental — failures degrade to "unavailable", never crash the office.
 */
export class UsageMonitor {
  private state: UsageState = { available: false, plan: null, rows: [], fetchedAt: null, note: { code: 'checking' } };
  private q: Query | null = null;
  private release: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(private cwd: string) {}

  /** What the browser sees; labels and note are rendered in the current language on every read. */
  get view(): UsageView {
    return { ...this.state, rows: relabelUsageRows(this.state.rows), note: noteText(this.state.note) };
  }

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
          this.set({ available: false, plan: null, rows: [], fetchedAt: Date.now(), note: { code: 'unsupported' } });
          return;
        }
        const raw: RawUsage = await Promise.race([
          q[METHOD]({ skipBehaviors: true }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new UsageTimeout('timeout')), 30_000)),
        ]);
        if (!raw.rate_limits_available || !raw.rate_limits) {
          this.set({ available: false, plan: raw.subscription_type ?? null, rows: [], fetchedAt: Date.now(), note: { code: 'noLimits' } });
          return;
        }
        this.set({ available: true, plan: raw.subscription_type ?? null, rows: toUsageRows(raw), fetchedAt: Date.now(), note: { code: '' } });
      } catch (e) {
        this.resetSession(); // start a fresh CLI next time
        this.set({ ...this.state, fetchedAt: Date.now(), note: { code: 'failed', timeout: e instanceof UsageTimeout, detail: String((e as Error)?.message ?? e) } });
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  private set(v: UsageState) {
    this.state = v;
    bus.send({ t: 'usage', data: this.view });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.resetSession();
  }
}
