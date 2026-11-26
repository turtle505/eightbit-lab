import { dowShort, hhmm, tr } from '../../../shared/i18n.ts';
import type { ReportFile, Task } from '../../../shared/protocol.ts';
import { knownTopics, normalizeTopic } from '../../../shared/topics.ts';

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

// ---- a card that follows another one (`afterTask`): it starts when that one reaches review or done ----
/** The task this card is still waiting for, if any (a card started by hand, or whose predecessor finished, waits for nothing). */
export function waitingFor(t: Task, tasks: Task[]): Task | null {
  if (t.state !== 'todo' || t.afterTask == null) return null;
  const prev = tasks.find((o) => o.id === t.afterTask);
  return prev && prev.state !== 'review' && prev.state !== 'done' ? prev : null;
}

export function chainBadge(t: Task, tasks: Task[]): string {
  const prev = waitingFor(t, tasks);
  if (!prev) return '';
  const tip = tr({ ko: `#${prev.id} "${prev.title}"이(가) 끝나면 담당 직원이 시작합니다`, en: `The assignee starts this when #${prev.id} "${prev.title}" finishes` });
  return `<span class="when-badge" title="${tip.replace(/"/g, '&quot;')}">⛓ ${tr({ ko: `#${prev.id} 다음`, en: `after #${prev.id}` })}</span>`;
}

/** Options for the "start after" picker of a new-task form: start now, or any task that has not finished yet. */
export function afterOptions(tasks: Task[]): string {
  const open = tasks.filter((t) => t.state === 'todo' || t.state === 'doing').sort((a, b) => b.id - a.id);
  const cut = (s: string) => (s.length > 28 ? `${s.slice(0, 28)}…` : s);
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    `<option value="">${tr({ ko: '⛓ 바로 시작', en: '⛓ Start right away' })}</option>` +
    open.map((t) => `<option value="${t.id}">${tr({ ko: `#${t.id} 끝난 뒤: ${safe(cut(t.title))}`, en: `After #${t.id}: ${safe(cut(t.title))}` })}</option>`).join('')
  );
}

/** The picker's value as a task id; alerts and returns undefined when following a task but nobody is chosen to start it. */
export function checkAfter(value: string, assignee: string | null): number | null | undefined {
  if (!value) return null;
  if (!assignee) return void alert(tr({ ko: '다른 작업 뒤에 시작하려면 담당 직원을 골라 주세요.', en: 'Pick an assignee for a task that starts after another one.' }));
  return Number(value);
}

// ---- topics (shared/topics.ts): the research subject a task belongs to ----
/** The topic field's value as a folder name; alerts and returns undefined when it would not make one. */
export function checkTopic(value: string): string | null | undefined {
  const n = normalizeTopic(value);
  if ('error' in n)
    return void alert(tr({ ko: '주제는 폴더 이름이 됩니다. 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다 (예: design-survey).', en: 'A topic becomes a folder name: only a-z, 0-9 and hyphens (e.g. design-survey).' }));
  return n.topic;
}
export const topicBadge = (t: Task): string => (t.topic ? `<span class="topic-badge" title="${tr({ ko: '주제', en: 'Topic' })}">#${t.topic}</span>` : '');
/** Fill the shared datalist and the two fields' placeholders (called from both task forms' renders). */
export function renderTopicInputs(tasks: Task[], reports: ReportFile[]) {
  const list = document.getElementById('topic-list');
  if (list) list.innerHTML = knownTopics(tasks, reports).map((t) => `<option value="${t}"></option>`).join('');
  for (const id of ['task-topic', 'c-task-topic']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    el.placeholder = tr({ ko: '주제 (선택, 예: design-survey)', en: 'Topic (optional, e.g. design-survey)' });
    el.title = tr({ ko: '이 작업이 속한 연구 주제. 보고서가 reports/<주제>/ 아래에 저장됩니다.', en: 'The research subject this task belongs to. Its reports are saved under reports/<topic>/.' });
  }
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
