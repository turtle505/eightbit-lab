import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { UsageRow, UsageView } from '../../shared/protocol.ts';
import { tr } from '../../shared/i18n.ts';
import { bus } from './bus.ts';

interface Window { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
interface Limits { primary?: Window | null; secondary?: Window | null; planType?: string | null; limitName?: string | null }
interface RateLimitsResponse { rateLimits?: Limits | null; rateLimitsByLimitId?: Record<string, Limits> | null }

export function codexUsageRows(raw: RateLimitsResponse): UsageRow[] {
  const limits = raw.rateLimitsByLimitId?.codex ?? raw.rateLimits;
  if (!limits) return [];
  const windows: [string, Window | null | undefined][] = [['session', limits.primary], ['weekly_all', limits.secondary]];
  return windows.flatMap(([kind, window]) => {
    if (!window || !Number.isFinite(window.usedPercent)) return [];
    const duration = window.windowDurationMins;
    const label = duration === 300 ? tr({ ko: 'Codex · 5시간', en: 'Codex · 5 h' })
      : duration === 10080 ? tr({ ko: 'Codex · 주간', en: 'Codex · week' })
      : duration ? tr({ ko: `Codex · ${duration}분`, en: `Codex · ${duration} min` })
      : kind === 'session' ? tr({ ko: 'Codex · 기본', en: 'Codex · primary' }) : tr({ ko: 'Codex · 보조', en: 'Codex · secondary' });
    const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
    return [{ kind, label, percent, resetsAt: window.resetsAt ? window.resetsAt * 1000 : null, severity: percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal' }];
  });
}

/** Read account quota without starting a Codex turn or spending tokens. */
export function readCodexRateLimits(timeoutMs = 15_000): Promise<RateLimitsResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stderr = '';
    const finish = (error?: Error, value?: RateLimitsResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s: string) => { stderr = (stderr + s).slice(-500); });
    proc.stdin.on('error', (err) => finish(err));
    proc.on('error', (err) => finish(err));
    proc.on('exit', (code) => finish(new Error(`Codex app-server exited (${code}): ${stderr}`)));
    const send = (id: number, method: string, params: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          if (msg.error) throw new Error(msg.error.message);
          proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          send(2, 'account/rateLimits/read', {});
        } else if (msg.id === 2) {
          if (msg.error) throw new Error(msg.error.message);
          finish(undefined, msg.result);
        }
      } catch (err) { finish(err as Error); }
    });
    send(1, 'initialize', { clientInfo: { name: 'eightbit_lab', title: '8-bit Lab', version: '1.0.0' }, capabilities: {} });
  });
}

export class CodexUsageMonitor {
  private state: UsageView = { available: false, plan: null, rows: [], fetchedAt: null, note: tr({ ko: '확인 중', en: 'Checking' }) };
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private debounce: NodeJS.Timeout | null = null;

  get view(): UsageView { return this.state; }

  start(everyMs = 3 * 60_000) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
  }

  poke(delayMs = 5_000) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), delayMs);
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const raw = await readCodexRateLimits();
        const rows = codexUsageRows(raw);
        const limits = raw.rateLimitsByLimitId?.codex ?? raw.rateLimits;
        this.state = { available: rows.length > 0, plan: limits?.planType ?? null, rows, fetchedAt: Date.now(), note: rows.length ? '' : tr({ ko: '한도 정보 없음', en: 'No limit information' }) };
      } catch (err) {
        this.state = { available: false, plan: null, rows: [], fetchedAt: Date.now(), note: tr({ ko: `조회 실패: ${(err as Error).message}`, en: `Lookup failed: ${(err as Error).message}` }).slice(0, 160) };
      } finally {
        this.pending = null;
        bus.send({ t: 'codexUsage', data: this.view });
      }
    })();
    return this.pending;
  }
}
