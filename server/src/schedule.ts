import type { Task } from '../../shared/protocol.ts';

/** A start time this close to now (or past) just starts the task right away. */
export const SCHEDULE_SLACK_MS = 30_000;

/** Scheduled cards whose time has come: still 'todo', with an assignee that (still) exists. */
export function dueTasks(tasks: Task[], now: number, isEmployee: (id: string) => boolean): Task[] {
  return tasks.filter((t) => t.state === 'todo' && t.startAt != null && t.startAt <= now && t.assignee != null && isEmployee(t.assignee));
}

// ---- task chains: a card that follows another one (`afterTask`) ----
/** A task counts as finished for whatever follows it once its run succeeded (review) or the manager closed it (done). */
export const isFinished = (t: Pick<Task, 'state'>): boolean => t.state === 'review' || t.state === 'done';

/** Is this card still waiting for the task it follows? (Only a 'todo' card waits; one that was started by hand does not.) */
export function waitsOn(t: Task, tasks: Task[]): Task | null {
  if (t.state !== 'todo' || t.afterTask == null) return null;
  const prev = tasks.find((o) => o.id === t.afterTask);
  return prev && !isFinished(prev) ? prev : null;
}

/** Cards whose predecessor has finished: still 'todo', with an assignee that (still) exists. */
export function readyFollowers(tasks: Task[], isEmployee: (id: string) => boolean): Task[] {
  return tasks.filter((t) => {
    if (t.state !== 'todo' || t.afterTask == null || t.assignee == null || !isEmployee(t.assignee)) return false;
    const prev = tasks.find((o) => o.id === t.afterTask);
    return !!prev && isFinished(prev);
  });
}

/** Waiting cards whose predecessor no longer exists (deleted): they cannot start by themselves any more. */
export const orphanedFollowers = (tasks: Task[]): Task[] => tasks.filter((t) => t.state === 'todo' && t.afterTask != null && !tasks.some((o) => o.id === t.afterTask));

const PREV_RESULT_MAX = 6000;
/** What a follow-up task is told about the task before it (agent-facing, English). */
export function followBlock(prev: Task, who: string): string {
  const result = (prev.result ?? '').trim();
  const shown = result.length > PREV_RESULT_MAX ? `${result.slice(0, PREV_RESULT_MAX)}\n…(truncated; the full text is in task #${prev.id})` : result;
  return (
    `\n\nThis task follows task #${prev.id} "${prev.title}", done by ${who}. Build on its result; do not redo that work.` +
    `\n\n--- Result of task #${prev.id} ---\n${shown || '(it left no written result; look for the files it mentions or produced)'}\n--- end of result ---`
  );
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
