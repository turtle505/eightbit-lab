import type { Task } from '../../shared/protocol.ts';

/** A start time this close to now (or past) just starts the task right away. */
export const SCHEDULE_SLACK_MS = 30_000;

/** Scheduled cards whose time has come: still 'todo', with an assignee that (still) exists. */
export function dueTasks(tasks: Task[], now: number, isEmployee: (id: string) => boolean): Task[] {
  return tasks.filter((t) => t.state === 'todo' && t.startAt != null && t.startAt <= now && t.assignee != null && isEmployee(t.assignee));
}

/** "Tue, Nov 25, 9:00 AM" — for the model and logs (agent-facing text stays English). */
export const fmtWhen = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The secretary's `startAt` ("YYYY-MM-DDTHH:mm", local time). Returns epoch ms, or an error the model can act on.
 */
export function parseStartAt(s: string, now = Date.now()): { ms: number } | { error: string } {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  const nowText = `It is now ${fmtWhen(now)} (local time).`;
  if (!m) return { error: `startAt must be local time "YYYY-MM-DDTHH:mm", e.g. "2026-01-31T09:00". ${nowText}` };
  const [, y, mo, d, h, mi] = m.map(Number);
  const ms = new Date(y, mo - 1, d, h, mi).getTime();
  if (Number.isNaN(ms) || new Date(ms).getMonth() !== mo - 1) return { error: `startAt "${s}" is not a real date. ${nowText}` };
  if (ms < now - SCHEDULE_SLACK_MS) return { error: `startAt ${fmtWhen(ms)} is in the past. ${nowText}` };
  return { ms };
}
