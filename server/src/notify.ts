/**
 * Push notifications for when the manager is away from the office tab: ntfy (phone app) and/or a
 * Slack/Discord-style incoming webhook. Off unless `notify` is set in office(.local).yaml. Never throws —
 * a broken channel must not break the office.
 */

export const NOTIFY_EVENTS = ['approval', 'result', 'error', 'job', 'scheduled'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export type NotifyPriority = 'low' | 'default' | 'high';

export interface NotifyConfig {
  /** full topic URL, e.g. https://ntfy.sh/<long-random-topic> */
  ntfy: string;
  /** incoming-webhook URL (Slack, Discord, …) */
  webhook: string;
  events: NotifyEvent[];
  /** include the start of the reply text (it leaves this machine) */
  preview: boolean;
  /** skip while an office tab is visible somewhere */
  whenAway: boolean;
}

export function normalizeNotify(raw: Partial<NotifyConfig> | null | undefined): NotifyConfig | null {
  if (!raw) return null;
  const ntfy = String(raw.ntfy ?? '').trim();
  const webhook = String(raw.webhook ?? '').trim();
  if (!ntfy && !webhook) return null;
  const events = Array.isArray(raw.events) ? raw.events.filter((e): e is NotifyEvent => (NOTIFY_EVENTS as readonly string[]).includes(e)) : [...NOTIFY_EVENTS];
  return { ntfy, webhook, events, preview: raw.preview === true, whenAway: raw.whenAway !== false };
}

/** HTTP headers are latin-1; RFC 2047 lets ntfy show a Korean (or emoji) title. */
export function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

const PER_MINUTE = 20;
const PREVIEW_CHARS = 200;

export class Notifier {
  /** set by index.ts: true while some browser has an office tab in front */
  isWatched: () => boolean = () => false;
  fetchFn: typeof fetch = (...a) => fetch(...a);
  private sent: number[] = [];
  private lastWarn = 0;

  constructor(readonly cfg: NotifyConfig | null) {}

  get channels(): string[] {
    return this.cfg ? [this.cfg.ntfy && 'ntfy', this.cfg.webhook && 'webhook'].filter(Boolean) : [];
  }

  /** Cut a reply down to a preview, or drop it when previews are off. */
  preview(text: string): string {
    if (!this.cfg?.preview) return '';
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}…` : t;
  }

  /** Returns whether anything was sent (for tests and the notify:test script). */
  async send(event: NotifyEvent, title: string, body = '', priority: NotifyPriority = 'default', force = false): Promise<boolean> {
    const c = this.cfg;
    if (!c) return false;
    if (!force) {
      if (!c.events.includes(event)) return false;
      if (c.whenAway && this.isWatched()) return false;
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 60_000);
      if (this.sent.length >= PER_MINUTE) {
        this.warn(`more than ${PER_MINUTE} notifications a minute; dropping some`);
        return false;
      }
      this.sent.push(now);
    }
    const jobs: Promise<void>[] = [];
    if (c.ntfy)
      jobs.push(
        this.post(c.ntfy, body || title, {
          Title: encodeHeader(title),
          Priority: priority === 'high' ? '4' : priority === 'low' ? '2' : '3',
          Tags: event,
        }),
      );
    if (c.webhook) {
      const text = body ? `*${title}*\n${body}` : title;
      jobs.push(this.post(c.webhook, JSON.stringify({ text, content: text }), { 'content-type': 'application/json' }));
    }
    const results = await Promise.allSettled(jobs);
    return results.some((r) => r.status === 'fulfilled');
  }

  private async post(url: string, body: string, headers: Record<string, string>): Promise<void> {
    try {
      const res = await this.fetchFn(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      this.warn(`${new URL(url).host}: ${(e as Error).message}`);
      throw e;
    }
  }

  private warn(msg: string) {
    if (Date.now() - this.lastWarn < 60_000) return;
    this.lastWarn = Date.now();
    console.warn(`📱 notify: ${msg}`);
  }
}
