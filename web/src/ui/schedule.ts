import { dowShort, hhmm, tr } from '../../../shared/i18n.ts';
import type { Task } from '../../../shared/protocol.ts';

/** value for <input type="datetime-local"> (local time, minutes) */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Quick picks: +1h (rounded to 5 min), tonight 22:00 (or tomorrow's if past), tomorrow 09:00. */
function quick(kind: string): Date {
  const d = new Date();
  if (kind === '1h') {
    d.setMinutes(Math.ceil((d.getMinutes() + 60) / 5) * 5, 0, 0);
  } else if (kind === 'tonight') {
    d.setHours(22, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

/** "11/25 (Tue) 09:00", or "Today 09:00" / "Tomorrow 09:00" */
export function whenLabel(ms: number): string {
  const d = new Date(ms);
  const day = new Date(d).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86_400_000);
  const date =
    diff === 0 ? tr({ ko: '오늘', en: 'Today' }) : diff === 1 ? tr({ ko: '내일', en: 'Tomorrow' }) : `${d.getMonth() + 1}/${d.getDate()} (${dowShort()[d.getDay()]})`;
  return `${date} ${hhmm(d)}`;
}

/** The ⏰ line on a scheduled card (empty when the task isn't waiting for a start time). */
export function scheduledBadge(t: Task): string {
  if (t.state !== 'todo' || t.startAt == null) return '';
  return `<span class="when-badge" title="${tr({ ko: '예약 작업: 이 시각에 담당 직원이 시작합니다', en: 'Scheduled: the assignee starts it at this time' })}">⏰ ${whenLabel(t.startAt)}</span>`;
}

/**
 * Wire the ⏰ button of a new-task form: it opens a row with a date-time field and quick picks.
 * `take()` gives the chosen time (null = start now) or 'past' when it's already gone.
 */
export function bindSchedule(btn: HTMLElement, box: HTMLElement) {
  box.innerHTML = `<input type="datetime-local" class="when-at" />
    <button type="button" data-q="1h">+1h</button>
    <button type="button" data-q="tonight">${tr({ ko: '오늘 밤 22:00', en: 'Tonight 22:00' })}</button>
    <button type="button" data-q="tomorrow">${tr({ ko: '내일 09:00', en: 'Tomorrow 09:00' })}</button>
    <button type="button" data-q="clear" class="icon-btn" title="${tr({ ko: '예약 취소', en: 'Clear' })}">✕</button>`;
  const input = box.querySelector<HTMLInputElement>('.when-at')!;
  const paint = () => btn.classList.toggle('on', !!input.value);
  const close = () => {
    input.value = '';
    box.hidden = true;
    paint();
  };
  btn.addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (box.hidden) close();
    else input.focus();
  });
  input.addEventListener('input', paint);
  box.addEventListener('click', (ev) => {
    const q = (ev.target as HTMLElement).closest<HTMLElement>('[data-q]')?.dataset.q;
    if (!q) return;
    if (q === 'clear') return close();
    input.value = toLocalInput(quick(q));
    paint();
  });
  return {
    take(): number | null | 'past' {
      if (box.hidden || !input.value) return null;
      const ms = new Date(input.value).getTime();
      if (Number.isNaN(ms)) return null;
      return ms < Date.now() - 60_000 ? 'past' : ms;
    },
    reset: close,
  };
}

/** Shared submit check for both forms; returns the startAt to send, or undefined to abort (after telling the user). */
export function checkSchedule(at: number | null | 'past', assignee: string | null): number | null | undefined {
  if (at === null) return null;
  if (at === 'past') return void alert(tr({ ko: '예약 시각이 이미 지났습니다.', en: 'That time has already passed.' }));
  if (!assignee) return void alert(tr({ ko: '예약하려면 담당 직원을 골라 주세요.', en: 'Pick an assignee to schedule a task.' }));
  return at;
}
