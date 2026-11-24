import { attachmentLinks, bindAttach } from './attach.ts';
import { followBottom } from './follow.ts';
import { bindSchedule, checkSchedule, scheduledBadge } from './schedule.ts';
import { approvalRisk } from './approvalRisk.ts';
import { lineDiff, type DiffLine } from './diff.ts';
import type { Approval, ClientMsg, EmployeeView, LogLine, Snapshot, Task, TaskState, UsageRow } from '../../../shared/protocol.ts';
import { dowShort, getLang, hhmm, locale, tr } from '../../../shared/i18n.ts';

export type ViewMode = 'game' | 'console' | 'reports' | 'projects';

export interface UIState {
  snap: Snapshot;
  selected: string | null;
  logs: Map<string, LogLine[]>;
  connected: boolean;
  view: ViewMode;
  /** all employees' recent log lines, oldest first (console activity feed) */
  feed: LogLine[];
  /** last time each employee's status/activity changed */
  empUpdated: Map<string, number>;
}

export type Send = (m: ClientMsg) => void;

export const $ = (id: string) => document.getElementById(id)!;
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const short = (name: string) => name.replace(/^.*"(.*)".*$/, '$1');
/** Strip emoji / pictographs (console view shows plain text). */
export const plain = (s: string) => s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim();
/** Emoji icon that the console view hides via CSS. */
export const ico = (e: string) => `<span class="ico">${e} </span>`;
export const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
/** "3m 전" / "3m ago" */
export const agoText = (ts: number) => tr({ ko: `${ago(ts)} 전`, en: `${ago(ts)} ago` });

// Re-render a region only when its data changed (keeps focus / open dropdowns intact).
const keys = new Map<string, string>();
export function changed(region: string, data: unknown): boolean {
  // the language is part of the key: switching it re-renders everything even when the data is the same
  const k = getLang() + JSON.stringify(data);
  if (keys.get(region) === k) return false;
  keys.set(region, k);
  return true;
}

const STATUS: Record<string, { ko: string; en: string }> = {
  idle: { ko: '휴식', en: 'Idle' },
  queued: { ko: '대기열', en: 'Queued' },
  thinking: { ko: '생각 중', en: 'Thinking' },
  typing: { ko: '작업 중', en: 'Working' },
  running: { ko: '실행 중', en: 'Running' },
  researching: { ko: '조사 중', en: 'Researching' },
  remote: { ko: '서버실', en: 'Server room' },
  waiting_permission: { ko: '승인 대기', en: 'Awaiting approval' },
  done: { ko: '완료', en: 'Done' },
  error: { ko: '오류', en: 'Error' },
};

/** Status label in the current language (falls back to the raw status). */
export const statusLabel = (s: string): string => (STATUS[s] ? tr(STATUS[s]) : s);

/** "19:40 초기화 · 25분 후" / "resets 19:40 · in 25 min"; beyond a day the date is included. */
export function resetText(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = hhmm(d);
  const left = ts - Date.now();
  if (left <= 0) return tr({ ko: '곧 초기화', en: 'resetting soon' });
  const mins = Math.max(1, Math.round(left / 60_000));
  const hours = Math.round(left / 3600_000);
  const days = Math.round(left / 86400_000);
  const rel =
    left < 3600_000
      ? tr({ ko: `${mins}분 후`, en: `in ${mins} min` })
      : left < 86400_000
        ? tr({ ko: `${hours}시간 후`, en: `in ${hours}h` })
        : tr({ ko: `${days}일 후`, en: `in ${days}d` });
  const dow = dowShort()[d.getDay()];
  const when = left < 86400_000 ? hm : tr({ ko: `${d.getMonth() + 1}/${d.getDate()}(${dow}) ${hm}`, en: `${dow} ${d.getMonth() + 1}/${d.getDate()} ${hm}` });
  return tr({ ko: `${when} 초기화 · ${rel}`, en: `resets ${when} · ${rel}` });
}

/** Short label for a usage row in the header's extra pill: the model/surface name of a scoped limit, else the label. */
const usageShort = (r: UsageRow): string => r.scope || r.label;

/** "🖥 desktop" when the employee's sessions run on another machine, else '' (the backend's own machine). */
export function hostBadge(st: UIState, e: EmployeeView, plainText = false): string {
  if (!e.hostId) return '';
  const h = (st.snap.hosts ?? []).find((x) => x.id === e.hostId);
  if (!h)
    return `<span class="prov off" title="${esc(tr({ ko: `설정에 host '${e.hostId}' 가 없음`, en: `No host '${e.hostId}' in the config` }))}">${esc(e.hostId)} · ${tr({ ko: '설정 없음', en: 'not configured' })}</span>`;
  // the ssh budget only earns screen space when it is nearly spent; otherwise it lives in the tooltip
  const budget = h.sshLimit > 0 ? tr({ ko: ` · 분당 ssh ${h.sshUsed}/${h.sshLimit}`, en: ` · ssh per minute ${h.sshUsed}/${h.sshLimit}` }) : '';
  const tight = h.sshLimit > 0 && h.sshUsed >= h.sshLimit * 0.8;
  const tip = (h.ok ? tr({ ko: `세션이 이 머신에서 실행됩니다 · claude ${h.claudeVersion ?? ''}`, en: `Sessions run on this machine · claude ${h.claudeVersion ?? ''}` }) : h.error ?? '') + budget;
  return `<span class="prov ${h.ok ? 'on' : 'off'}" title="${esc(tip)}">${esc(plainText ? plain(h.name) : h.name)}${
    h.ok ? '' : tr({ ko: ' · 연결 안 됨', en: ' · unreachable' })
  }${tight ? ` <span class="ssh-tight">⏳ ${h.sshUsed}/${h.sshLimit}</span>` : ''}</span>` +
    (plainText ? '' : ` <button type="button" class="icon-btn host-recheck" data-host="${esc(h.id)}" title="${esc(tr({ ko: '지금 연결 확인 (평소에는 접속하지 않습니다)', en: 'Check the connection now (it is not polled otherwise)' }))}">↻</button>`);
}

/** Provider (local model) of an employee, if it runs on one. */
export function providerOf(st: UIState, e: EmployeeView) {
  return e.provider ? (st.snap.providers ?? []).find((p) => p.id === e.provider) ?? null : null;
}

/** "🖥 workstation · qwen3:8b · connected" — plain text when `plainText` (console table) */
export function providerBadge(st: UIState, e: EmployeeView, plainText = false): string {
  if (!e.provider) return '';
  const p = providerOf(st, e);
  if (!p)
    return `<span class="prov off" title="${esc(tr({ ko: `설정에 provider '${e.provider}' 가 없음`, en: `No provider '${e.provider}' in the config` }))}">${plainText ? '' : '🖥 '}${esc(e.provider)} · ${tr({ ko: '설정 없음', en: 'not configured' })}</span>`;
  const state = p.ok ? tr({ ko: '연결됨', en: 'connected' }) : tr({ ko: '끊김', en: 'disconnected' });
  const tip = p.ok ? tr({ ko: `Ollama ${p.version ?? ''} · 설치된 모델 ${p.models.length}개`, en: `Ollama ${p.version ?? ''} · ${p.models.length} models installed` }) : p.error ?? '';
  return `<span class="prov ${p.ok ? 'on' : 'off'}" title="${esc(tip)}">${esc(plainText ? plain(p.name) : p.name)} · ${esc(p.model)} · ${state}</span>`;
}

/** Each employee's share of the office's total usage (from SDK cost estimates). */
export function usageShare(st: UIState, costUsd: number): string {
  const total = st.snap.employees.reduce((a, e) => a + e.costUsd, 0);
  return total > 0 ? `${Math.round((costUsd / total) * 100)}%` : '—';
}

export function renderHeader(st: UIState, send?: Send) {
  const s = st.snap;
  const busy = s.employees.filter((e) => !e.provider && !['idle', 'done', 'error', 'queued'].includes(e.status)).length;
  const u = s.usage;
  const cu = s.codexUsage;
  const data = [st.connected, busy, s.maxConcurrent, s.approvals.length, u, cu, Math.floor(Date.now() / 60000), typeof Notification !== 'undefined' ? Notification.permission : 'na'];
  if (!changed('header', data)) return;
  // headline meters: session + overall weekly; model-scoped weekly rows go in the tooltip
  const main = u?.rows.filter((r) => r.kind === 'session' || r.kind === 'weekly_all') ?? [];
  const extra = u?.rows.filter((r) => !main.includes(r)) ?? [];
  const tip = (u?.rows ?? []).map((r) => `${r.label}: ${r.percent}% ${resetText(r.resetsAt)}`).join('\n') + (u?.plan ? tr({ ko: `\n플랜: ${u.plan}`, en: `\nPlan: ${u.plan}` }) : '') + tr({ ko: '\n(클릭하면 새로고침)', en: '\n(click to refresh)' });
  const meters = u?.available && main.length
    ? main
        .map(
          (r) => `<button type="button" class="pill meter sev-${esc(r.severity)}" data-usage title="${esc(tip)}">
            ${r.kind === 'session' ? tr({ ko: '세션', en: 'Session' }) : tr({ ko: '주간', en: 'Week' })} <b>${r.percent}%</b><span class="mbar"><i style="width:${Math.min(100, r.percent)}%"></i></span><span class="muted">${esc(resetText(r.resetsAt).split(' · ')[0])}</span></button>`,
        )
        .join('') + (extra.length ? `<span class="pill muted" title="${esc(tip)}">${extra.map((r) => `${esc(usageShort(r))} ${r.percent}%`).join(' · ')}</span>` : '')
    : `<button type="button" class="pill" data-usage title="${esc(u?.note || '')}">${tr({ ko: '사용량', en: 'Usage' })} ${u?.fetchedAt ? '—' : tr({ ko: '확인 중', en: 'checking' })}</button>`;
  const codexTip = (cu?.rows ?? []).map((r) => `${r.label}: ${100 - r.percent}% ${tr({ ko: '남음', en: 'left' })} · ${resetText(r.resetsAt)}`).join('\n') + (cu?.plan ? `\n${cu.plan}` : '');
  const codexMeters = cu?.available && cu.rows.length
    ? cu.rows.map((r) => `<button type="button" class="pill meter sev-${esc(r.severity)}" data-usage title="${esc(codexTip)}">${esc(r.label)} <b>${100 - r.percent}%</b> ${tr({ ko: '남음', en: 'left' })}</button>`).join('')
    : `<button type="button" class="pill" data-usage title="${esc(cu?.note || '')}">Codex ${cu?.fetchedAt ? '—' : tr({ ko: '확인 중', en: 'checking' })}</button>`;
  $('stats').innerHTML = `
    <span class="pill ${st.connected ? 'ok' : 'bad'}">${st.connected ? tr({ ko: '● 연결됨', en: '● Online' }) : tr({ ko: '○ 연결 끊김', en: '○ Offline' })}</span>
    <span class="pill">${tr({ ko: '근무 중', en: 'Working' })} <b>${busy}</b>/${s.maxConcurrent}</span>
    <span class="pill ${s.approvals.length ? 'warn' : ''}">${tr({ ko: '승인 대기', en: 'Approvals' })} <b>${s.approvals.length}</b></span>
    ${meters}${codexMeters}`;
  if (send) $('stats').querySelectorAll('[data-usage]').forEach((b) => b.addEventListener('click', () => send({ t: 'refreshUsage' })));
  const nb = document.getElementById('notify-btn');
  if (nb) nb.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

export function renderApprovals(st: UIState, send: Send) {
  const s = st.snap;
  if (!changed('approvals', [s.approvals, s.employees.map((e) => e.name), st.view])) return;
  const box = $('approvals');
  // game view: only shown when something is pending; console view: always shown
  box.hidden = s.approvals.length === 0 && st.view === 'game';
  box.classList.toggle('empty', s.approvals.length === 0);
  box.innerHTML =
    `<h2>${ico('✋')}${tr({ ko: '승인 요청', en: 'Approval requests' })} <span class="muted small">${tr({ ko: `${s.approvals.length}건`, en: `${s.approvals.length}` })}${
      st.view === 'console' && s.approvals.length ? tr({ ko: ' · 첫 건 a 승인 / d 거부', en: ' · first one: a approve / d deny' }) : ''
    }</span></h2>` +
    (s.approvals.length ? '' : `<p class="muted small">${tr({ ko: '대기 중인 승인 요청이 없습니다.', en: 'No pending approval requests.' })}</p>`) +
    s.approvals
      .map((a) => {
        const who = s.employees.find((e) => e.id === a.employeeId);
        const inp = a.input as Record<string, unknown>;
        const routine = a.toolName.includes('_routine') ? s.routines.find((r) => r.id === inp.id) : undefined;
        const main = inp.command ?? inp.file_path ?? inp.url ?? inp.query ?? (routine ? tr({ ko: `루틴: ${routine.name} (${routine.id})`, en: `Routine: ${routine.name} (${routine.id})` }) : inp.name ?? inp.id) ?? '';
        const rest = JSON.stringify(inp, null, 2);
        const risk = approvalRisk(a.toolName, inp);
        const chips = risk.reasons.map((r) => `<span class="risk-chip">${esc(r)}</span>`).join('');
        return `<div class="approval${risk.high ? ' risk-high' : ''}" data-id="${esc(a.id)}">
          <div class="approval-head"><b>${esc(who ? short(who.name) : a.employeeId)}</b> → <code>${esc(a.toolName)}</code> ${chips}<span class="muted">${agoText(a.createdAt)}</span></div>
          ${main ? `<pre class="cmd">${esc(main)}</pre>` : ''}
          ${editPreview(a.toolName, inp)}
          ${inp.description ? `<div class="muted">${esc(inp.description)}</div>` : ''}
          <details><summary>${tr({ ko: '전체 입력', en: 'Full input' })}</summary><pre>${esc(rest)}</pre></details>
          <div class="row"><button class="primary" data-act="allow">${tr({ ko: '승인', en: 'Approve' })}</button><button data-act="deny">${tr({ ko: '거부', en: 'Deny' })}</button></div>
        </div>`;
      })
      .join('');
  box.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.closest<HTMLElement>('.approval')!.dataset.id!;
      const allow = b.dataset.act === 'allow';
      const a = st.snap.approvals.find((x) => x.id === id);
      if (allow && a && !confirmApprove(a, st.snap)) return;
      send({ t: 'approve', id, allow });
    }),
  );
}

/** "[Codex]" on a task the lead routed to an engine other than the assignee's default */
export function engineBadge(t: Task): string {
  if (!t.engine) return '';
  const name = t.engine === 'codex' ? 'Codex' : 'Claude';
  return `<span class="engine-badge e-${t.engine}" title="${esc(tr({ ko: `이 작업만 ${name}로 실행`, en: `This task runs on ${name}` }))}">${name}</span> `;
}

const WRITE_PREVIEW_LINES = 60;

/** What a file-editing call would change, as a red/green diff instead of the JSON blob. */
function editPreview(tool: string, inp: Record<string, unknown>): string {
  const block = (lines: DiffLine[]) =>
    `<pre class="diff">${lines
      .map((l) => (l.op === '…' ? `<span class="d-gap">⋯</span>` : `<span class="${l.op === '+' ? 'd-add' : l.op === '-' ? 'd-del' : 'd-ctx'}">${l.op} ${esc(l.text)}</span>`))
      .join('')}</pre>`;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (tool === 'Edit') {
    const note = inp.replace_all ? `<div class="muted small">${tr({ ko: '파일 안의 같은 부분을 모두 바꿈', en: 'Replaces every occurrence in the file' })}</div>` : '';
    return note + block(lineDiff(str(inp.old_string), str(inp.new_string)));
  }
  if (tool === 'MultiEdit' && Array.isArray(inp.edits))
    return (inp.edits as Record<string, unknown>[]).map((e) => block(lineDiff(str(e.old_string), str(e.new_string)))).join('');
  if (tool === 'Write') {
    const lines = str(inp.content).split('\n');
    const shown: DiffLine[] = lines.slice(0, WRITE_PREVIEW_LINES).map((text) => ({ op: '+', text }));
    const more = lines.length - shown.length;
    return `<div class="muted small">${tr({ ko: `파일 전체를 이 내용으로 씀 (${lines.length}줄)`, en: `Writes the whole file (${lines.length} lines)` })}</div>${block(shown)}${
      more > 0 ? `<div class="muted small">${tr({ ko: `…${more}줄 더`, en: `…${more} more lines` })}</div>` : ''
    }`;
  }
  return '';
}

const COLS = (): Array<[TaskState, string]> => [
  ['todo', tr({ ko: '할 일', en: 'To do' })],
  ['doing', tr({ ko: '진행 중', en: 'Doing' })],
  ['review', tr({ ko: '검토', en: 'Review' })],
  ['done', tr({ ko: '완료', en: 'Done' })],
];

/** cards opened for detail (by id), and whether Done shows everything; kept across re-renders */
const openCards = new Set<number>();
let doneAll = false;
const DONE_SHOWN = 5;
const DETAIL_CHARS = 600;

/** newest first within a column: the latest results sit on top */
export const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt || b.id - a.id;

export function renderBoard(st: UIState, send: Send) {
  const s = st.snap;
  const emps = [...s.employees].sort((a, b) => a.desk - b.desk);
  // assignee select in the new-task form
  if (changed('assigneeSelect', emps.map((e) => e.id + e.name))) {
    const sel = $('task-assignee') as HTMLSelectElement;
    const v = sel.value;
    sel.innerHTML = `<option value="">${tr({ ko: '(나중에 배정)', en: '(assign later)' })}</option>` + emps.map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))} · ${esc(e.title)}</option>`).join('');
    sel.value = v;
  }
  if (!changed('board', [s.tasks, emps.map((e) => [e.id, e.name]), [...openCards], doneAll, getLang()])) return;

  const board = $('board');
  // a re-render replaces the columns; keep where each one was scrolled to
  const scrolled = new Map([...board.querySelectorAll<HTMLElement>('.col')].map((c) => [c.dataset.state, c.scrollTop]));

  const lock = `<span class="lock" title="${esc(tr({ ko: '승인 받기: 자동 모드여도 도구마다 매니저 승인', en: 'Require approval: every tool needs the manager\'s approval, even in auto mode' }))}">🔒</span>`;
  const card = (t: Task, state: TaskState) => {
    const who = emps.find((e) => e.id === t.assignee);
    const open = openCards.has(t.id);
    const meta = [
      `#${t.id}`,
      who ? esc(short(who.name)) : `<i>${tr({ ko: '미배정', en: 'unassigned' })}</i>`,
      agoText(t.updatedAt),
    ].join(' · ');
    const marks = `${engineBadge(t)}${t.requireApproval ? lock + ' ' : ''}${t.startAt != null && state === 'todo' ? scheduledBadge(t) + ' ' : ''}${
      t.attachments?.length ? `<span class="muted">📎${t.attachments.length}</span> ` : ''
    }`;
    const body = open
      ? `${t.startAt != null && state === 'todo' ? `<div class="card-when"><button data-act="now">${tr({ ko: '▶ 지금 시작', en: '▶ Start now' })}</button></div>` : ''}
         ${t.detail ? `<div class="card-detail">${esc(t.detail.length > DETAIL_CHARS ? `${t.detail.slice(0, DETAIL_CHARS)}…` : t.detail)}</div>` : ''}
         ${t.attachments?.length ? `<div class="card-att">📎 ${attachmentLinks(t.attachments)}</div>` : ''}
         ${t.result ? `<details ${state === 'review' ? 'open' : ''}><summary>${tr({ ko: '보고', en: 'Report' })}</summary><div class="card-result">${esc(t.result)}</div></details>` : ''}
         <div class="row">
           <select data-act="assign"><option value="">${who ? esc(short(who.name)) : tr({ ko: '배정…', en: 'Assign…' })}</option>${emps
             .map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))}</option>`)
             .join('')}</select>
           <button data-act="del" title="${tr({ ko: '삭제', en: 'Delete' })}">✕</button>
         </div>`
      : '';
    return `<div class="card${open ? ' open' : ''}" draggable="true" data-id="${t.id}">
      <button type="button" class="card-title link" data-act="toggle" aria-expanded="${open}" title="${esc(t.title)}">${marks}${esc(t.title)}</button>
      <div class="card-meta"><span>${meta}</span>${state === 'review' ? `<button data-act="done">${tr({ ko: '완료', en: 'Done' })}</button>` : ''}</div>
      ${body}
    </div>`;
  };

  board.innerHTML = COLS().map(([state, label]) => {
    const all = s.tasks.filter((t) => t.state === state).sort(byRecent);
    const tasks = state === 'done' && !doneAll ? all.slice(0, DONE_SHOWN) : all;
    const hidden = all.length - tasks.length;
    const bulk = state === 'review' && all.length >= 2 ? `<button type="button" class="col-act" data-act="all-done">${tr({ ko: '모두 완료', en: 'All done' })}</button>` : '';
    const fold =
      state === 'done' && (hidden > 0 || (doneAll && all.length > DONE_SHOWN))
        ? `<button type="button" class="link col-more" data-act="done-more">${hidden > 0 ? tr({ ko: `+${hidden}개 더 보기`, en: `+${hidden} more` }) : tr({ ko: '접기', en: 'Show fewer' })}</button>`
        : '';
    return `<div class="col" data-state="${state}"><h3>${label} <span class="muted">${all.length}</span>${bulk}</h3>${tasks.map((t) => card(t, state)).join('')}${fold}</div>`;
  }).join('');
  board.querySelectorAll<HTMLElement>('.col').forEach((c) => (c.scrollTop = scrolled.get(c.dataset.state) ?? 0));

  board.querySelectorAll<HTMLElement>('.card').forEach((el) => {
    const id = Number(el.dataset.id);
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/task-id', String(id));
      ev.dataTransfer!.effectAllowed = 'move';
    });
    el.querySelector('[data-act="toggle"]')!.addEventListener('click', () => {
      if (openCards.has(id)) openCards.delete(id);
      else openCards.add(id);
      renderBoard(st, send);
    });
    el.querySelector<HTMLSelectElement>('select[data-act="assign"]')?.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      if (v) send({ t: 'assignTask', taskId: id, employeeId: v });
    });
    el.querySelector('button[data-act="done"]')?.addEventListener('click', () => {
      openCards.delete(id);
      send({ t: 'moveTask', taskId: id, state: 'done' });
    });
    el.querySelector('button[data-act="now"]')?.addEventListener('click', () => {
      const t = st.snap.tasks.find((x) => x.id === id);
      if (t?.assignee) send({ t: 'assignTask', taskId: id, employeeId: t.assignee });
    });
    el.querySelector('button[data-act="del"]')?.addEventListener('click', () => {
      if (confirm(tr({ ko: `작업 #${id}을 삭제할까요?`, en: `Delete task #${id}?` }))) send({ t: 'deleteTask', taskId: id });
    });
  });
  board.querySelector('[data-act="all-done"]')?.addEventListener('click', () => {
    const review = st.snap.tasks.filter((t) => t.state === 'review');
    if (!confirm(tr({ ko: `검토 중인 작업 ${review.length}개를 모두 완료로 옮길까요?`, en: `Move all ${review.length} tasks in Review to Done?` }))) return;
    for (const t of review) {
      openCards.delete(t.id);
      send({ t: 'moveTask', taskId: t.id, state: 'done' });
    }
  });
  board.querySelector('[data-act="done-more"]')?.addEventListener('click', () => {
    doneAll = !doneAll;
    renderBoard(st, send);
  });
  board.querySelectorAll<HTMLElement>('.col').forEach((col) => {
    col.addEventListener('dragover', (ev) => ev.preventDefault());
    col.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const id = Number(ev.dataTransfer?.getData('text/task-id'));
      if (id) send({ t: 'moveTask', taskId: id, state: col.dataset.state as TaskState });
    });
  });
}

export function renderJobs(st: UIState, send: Send) {
  const s = st.snap;
  if (!changed('jobs', [s.jobs, s.servers])) return;
  const servers = s.servers.length
    ? s.servers
        .map(
          (sv) => `<div class="server ${sv.online ? '' : 'offline'}">
        <div><b>${esc(sv.name)}</b> <span class="muted">${sv.type}</span> ${sv.online ? '🟢' : '🔴'}</div>
        ${sv.gpus
          .map(
            (g) => `<div class="gpu" title="${esc(g.name)}"><span>GPU${g.index}</span>
            <span class="bar"><i style="width:${g.util}%"></i></span><span class="muted">${g.util}% · ${(g.memUsed / 1024).toFixed(0)}/${(g.memTotal / 1024).toFixed(0)}G</span></div>`,
          )
          .join('')}
        <div class="muted small">${esc(sv.note)}</div></div>`,
        )
        .join('')
    : `<p class="muted">${tr({
        ko: '등록된 GPU 서버가 없습니다. <code>config/servers.example.yaml</code>을 <code>config/servers.local.yaml</code>로 복사해 채우고 백엔드를 재시작하세요.',
        en: 'No GPU servers registered. Copy <code>config/servers.example.yaml</code> to <code>config/servers.local.yaml</code>, fill it in and restart the backend.',
      })}</p>`;
  const jobs = [...s.jobs]
    .reverse()
    .slice(0, 30)
    .map(
      (j) => `<tr class="job-${j.state}"><td>#${j.id}</td><td>${esc(j.name)}</td><td>${esc(j.server)}</td><td>${esc(j.submittedBy ?? tr({ ko: '나', en: 'me' }))}</td>
      <td><span class="state">${j.state}</span></td><td class="muted">${ago(j.updatedAt)}</td>
      <td>${['pending', 'running', 'unknown'].includes(j.state) ? `<button data-cancel="${j.id}">${tr({ ko: '취소', en: 'Cancel' })}</button>` : ''}</td></tr>`,
    )
    .join('');
  $('jobs').innerHTML = `
    <div class="row space"><h2>${ico('🖥️')}${tr({ ko: '서버실', en: 'Server room' })}</h2><button id="refresh-servers">${tr({ ko: '새로고침', en: 'Refresh' })}</button></div>
    ${servers}
    <h2>${ico('📦')}${tr({ ko: '원격 Job', en: 'Remote jobs' })}</h2>
    ${
      jobs
        ? `<table class="jobs"><thead><tr><th></th><th>${tr({ ko: '이름', en: 'Name' })}</th><th>${tr({ ko: '서버', en: 'Server' })}</th><th>${tr({ ko: '제출', en: 'By' })}</th><th>${tr({ ko: '상태', en: 'State' })}</th><th></th><th></th></tr></thead><tbody>${jobs}</tbody></table>`
        : `<p class="muted">${tr({ ko: '아직 제출된 job이 없습니다.', en: 'No jobs submitted yet.' })}</p>`
    }`;
  $('refresh-servers').addEventListener('click', () => send({ t: 'refreshServers' }));
  $('jobs').querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm(tr({ ko: `job #${b.dataset.cancel}을 취소할까요?`, en: `Cancel job #${b.dataset.cancel}?` }))) send({ t: 'cancelJob', jobId: Number(b.dataset.cancel) });
    }),
  );
}

let panelFor: string | null | undefined;

export function renderEmployeePanel(st: UIState, send: Send) {
  const box = $('employee');
  const e = st.snap.employees.find((x) => x.id === st.selected);
  if (!e) {
    const n = st.snap.employees.length;
    // the count is part of the key: the first render can come before the snapshot (n = 0)
    if (panelFor !== `none:${st.view}:${getLang()}:${n}`) {
      panelFor = `none:${st.view}:${getLang()}:${n}`;
      box.innerHTML =
        st.view === 'console'
          ? `<p class="muted hint">${tr({
              ko: `직원 표에서 행을 클릭하거나 <kbd>1</kbd>–<kbd>${n}</kbd>, <kbd>j</kbd>/<kbd>k</kbd>로 선택하세요. 그 직원의 로그가 여기에 표시되고, 지시는 직원 표 아래 입력칸에서 보냅니다.`,
              en: `Click a row in the staff table or press <kbd>1</kbd>–<kbd>${n}</kbd>, <kbd>j</kbd>/<kbd>k</kbd>. Their log appears here; send instructions from the box under the staff table.`,
            })}</p>`
          : `<p class="muted hint">${tr({
              ko: `사무실에서 직원을 클릭하거나 숫자키 <kbd>1</kbd>–<kbd>${n}</kbd>를 누르면 그 직원의 로그가 여기에 나오고, 사무실 바로 아래 입력칸으로 지시할 수 있습니다. 작업 카드를 직원에게 끌어다 놓으면 바로 배정됩니다.`,
              en: `Click someone in the office or press <kbd>1</kbd>–<kbd>${n}</kbd> to see their log here and instruct them from the box right under the office. Drop a task card on an employee to assign it.`,
            })}</p>`;
    }
    return;
  }
  if (panelFor !== e.id + e.name + getLang()) {
    panelFor = e.id + e.name + getLang();
    keys.delete('emp-head');
    keys.delete('emp-log');
    box.innerHTML = `
      <div id="emp-head"></div>
      <div id="emp-log" class="log"></div>
      <div class="row emp-actions">
        <button type="button" id="emp-stop">${tr({ ko: '중지', en: 'Stop' })}</button>
        <button type="button" id="emp-reset" title="${tr({ ko: '대화 맥락을 비우고 새 세션으로 시작', en: 'Clear the conversation and start a new session' })}">${tr({ ko: '새 세션', en: 'New session' })}</button>
        <button type="button" id="emp-logmode" class="emp-logmode"></button>
      </div>`;
    $('emp-logmode').addEventListener('click', () => {
      logAll = !logAll;
      renderEmployeePanel(st, send);
    });
    $('emp-stop').addEventListener('click', () => send({ t: 'stop', employeeId: e.id }));
    $('emp-reset').addEventListener('click', () => {
      if (confirm(tr({ ko: '대화 맥락을 비우고 새 세션으로 시작할까요?', en: 'Clear the conversation and start a new session?' }))) send({ t: 'resetSession', employeeId: e.id });
    });
  }
  const prov = providerOf(st, e);
  // while a task runs on the other engine, show that one (locked) — it switches back when the task ends
  const engineNow = e.turnEngine ?? e.engine;
  const engineName = (x: string) => (x === 'codex' ? 'Codex' : 'Claude');
  const engineTitle = e.turnEngine
    ? tr({
        ko: `이 작업만 ${engineName(e.turnEngine)}로 실행 중입니다. 끝나면 기본 실행기(${engineName(e.engine)})로 돌아갑니다.`,
        en: `Running this task on ${engineName(e.turnEngine)}; back to the default (${engineName(e.engine)}) when it ends.`,
      })
    : tr({ ko: '실행기 (작업이 끝난 뒤 바꿀 수 있음)', en: 'Agent engine (switch after the current work)' });
  if (changed('emp-head', [e, st.view, st.snap.employees.map((x) => x.costUsd), prov, st.snap.hosts])) {
    $('emp-head').innerHTML = `
      <div class="emp-title"><span class="swatch" style="background:${esc(e.sprite.shirt)}"></span>
        <b>${esc(e.name)}</b> <button type="button" id="emp-rename" class="icon-btn" title="${tr({ ko: '이름 바꾸기', en: 'Rename' })}">✏️</button> <span class="muted">${esc(e.title)}</span>
        <span class="status s-${e.status}">${statusLabel(e.status)}</span>
        <select id="emp-engine" class="${e.turnEngine ? 'engine-turn' : ''}" aria-label="${tr({ ko: '실행기', en: 'Agent engine' })}" title="${esc(engineTitle)}" ${e.provider || e.turnEngine ? 'disabled' : ''}><option value="claude" ${engineNow === 'claude' ? 'selected' : ''}>Claude</option><option value="codex" ${engineNow === 'codex' ? 'selected' : ''}>Codex</option></select>${
          e.turnEngine ? `<span class="engine-badge e-${e.turnEngine}" title="${esc(engineTitle)}">${tr({ ko: '이 작업만', en: 'this task' })}</span>` : ''
        }
        <button type="button" id="emp-perm" class="perm-btn perm-${e.permission}" title="${
          e.permission === 'auto'
            ? tr({
                ko: '🤖 자동 모드: 분류기가 안전하다고 본 도구는 바로 실행하고, 애매한 것만 승인 요청. 클릭하면 승인 모드로 (다음 지시부터 적용)',
                en: '🤖 Auto mode: tools the classifier deems safe run right away; only unclear ones ask for approval. Click for approval mode (from the next instruction)',
              })
            : tr({
                ko: '✋ 승인 모드: 자동 허용 목록 밖의 도구는 모두 승인 요청. 클릭하면 자동 모드로 (다음 지시부터 적용)',
                en: '✋ Approval mode: every tool outside the auto-allow list asks for approval. Click for auto mode (from the next instruction)',
              })
        }">${
          st.view === 'console'
            ? e.permission === 'auto'
              ? tr({ ko: '[자동]', en: '[auto]' })
              : tr({ ko: '[승인]', en: '[ask]' })
            : e.permission === 'auto'
              ? tr({ ko: '🤖 자동', en: '🤖 Auto' })
              : tr({ ko: '✋ 승인', en: '✋ Ask' })
        }</button></div>
      <div class="muted small">${esc(st.view === 'console' ? plain(e.activity) : e.activity)}</div>
      ${e.hostId ? `<div class="small emp-prov">${hostBadge(st, e, st.view === 'console')}</div>` : ''}
      ${
        e.provider
          ? `<div class="small emp-prov">${providerBadge(st, e, st.view === 'console')}${
              prov?.models.length
                ? ` <select id="emp-model" title="${tr({ ko: '이 provider의 모든 직원이 쓸 모델', en: 'Model used by every employee on this provider' })}">${prov.models
                    .map((m) => `<option value="${esc(m)}"${m === prov.model ? ' selected' : ''}>${esc(m)}</option>`)
                    .join('')}${prov.models.includes(prov.model) ? '' : `<option value="${esc(prov.model)}" selected disabled>${esc(prov.model)} ${tr({ ko: '(미설치)', en: '(not installed)' })}</option>`}</select>`
                : ''
            }</div>`
          : ''
      }
      ${
        e.parkedUntil
          ? `<div class="small emp-prov"><span class="prov off">${tr({ ko: '⏸ 사용량 한도', en: '⏸ Usage limit' })} · ${resetText(e.parkedUntil)} → ${tr({ ko: '자동 재개', en: 'auto-resume' })}</span>
             <button type="button" id="emp-resume" title="${tr({ ko: '기다리지 않고 지금 이어서 하기', en: 'Continue now instead of waiting' })}">${tr({ ko: '▶️ 지금 이어서', en: '▶️ Resume now' })}</button></div>`
          : ''
      }
      <div class="muted small">${ico('📁')}${esc(e.cwd || tr({ ko: '(아직 작업 전)', en: '(not started yet)' }))} · <span title="${
        e.live
          ? tr({
              ko: '세션이 열려 있어 다음 지시는 바로 시작합니다. 일하는 중에 보낸 지시도 즉시 전달됩니다.',
              en: 'The session is open, so the next instruction starts right away. Instructions sent mid-turn are delivered immediately.',
            })
          : tr({
              ko: '세션이 닫혀 있습니다. 다음 지시 때 대화를 이어서 다시 엽니다 (첫 응답만 느림).',
              en: 'The session is closed. The next instruction reopens it and resumes the conversation (only the first reply is slow).',
            })
      }">${e.live ? tr({ ko: '🟢 세션 열림', en: '🟢 Session open' }) : tr({ ko: '⚪ 세션 대기', en: '⚪ Session idle' })}</span> ${
        e.sessionId ? esc(e.sessionId.slice(0, 8)) : tr({ ko: '새로 시작', en: 'fresh start' })
      } · ${engineNow === 'codex' ? tr({ ko: 'Codex 구독', en: 'Codex subscription' }) : e.provider ? tr({ ko: '구독 사용 안 함', en: 'no subscription use' }) : tr({ ko: `사무실 사용 비중 ${usageShare(st, e.costUsd)}`, en: `share of office usage ${usageShare(st, e.costUsd)}` })}</div>`;
    document.getElementById('emp-model')?.addEventListener('change', (ev) => {
      if (prov) send({ t: 'setProviderModel', providerId: prov.id, model: (ev.target as HTMLSelectElement).value });
    });
    $('emp-perm').addEventListener('click', () => send({ t: 'setPermission', employeeId: e.id, mode: e.permission === 'auto' ? 'ask' : 'auto' }));
    document.getElementById('emp-engine')?.addEventListener('change', (ev) => {
      const select = ev.target as HTMLSelectElement;
      send({ t: 'setEmployeeEngine', employeeId: e.id, engine: select.value as 'claude' | 'codex' });
      // The server owns the selection; a rejected switch leaves the prior value in place.
      select.value = e.engine;
    });
    document.getElementById('emp-resume')?.addEventListener('click', () => send({ t: 'resumeWork', employeeId: e.id }));
    document.querySelectorAll<HTMLButtonElement>('#emp-head .host-recheck').forEach((b) =>
      b.addEventListener('click', () => send({ t: 'recheckHost', hostId: b.dataset.host! })),
    );
    $('emp-rename').addEventListener('click', () => {
      const nick = prompt(tr({ ko: '새 이름 (비우면 원래 이름으로)', en: 'New name (leave empty for the original)' }), short(e.name));
      if (nick !== null) send({ t: 'renameEmployee', employeeId: e.id, nick });
    });
  }
  // Claude and Codex keep separate conversations: show the one in view (or both, marked)
  const all = st.logs.get(e.id) ?? [];
  const lines = logAll ? all : all.filter((l) => !l.engine || l.engine === engineNow);
  if (changed('emp-log', [e.id, all.length, all[all.length - 1]?.ts, engineNow, logAll, getLang()])) {
    const btn = $('emp-logmode');
    btn.textContent = logAll ? tr({ ko: `📜 ${engineName(engineNow)} 기록만`, en: `📜 ${engineName(engineNow)} only` }) : tr({ ko: '📜 전체 기록', en: '📜 All history' });
    btn.title = logAll
      ? tr({ ko: `지금 실행기(${engineName(engineNow)})의 대화만 보기`, en: `Show only the ${engineName(engineNow)} conversation` })
      : tr({ ko: 'Claude와 Codex 기록을 함께 보기 (C/X 표시)', en: 'Show the Claude and Codex history together (marked C/X)' });
    const log = $('emp-log');
    const mark = (l: LogLine) =>
      logAll && l.engine ? `<span class="eng-mark e-${l.engine}" title="${l.engine === 'codex' ? 'Codex' : 'Claude'}">${l.engine === 'codex' ? 'X' : 'C'}</span>` : '';
    log.innerHTML = lines.length
      ? lines
          .map(
            (l) =>
              `<div class="line k-${l.kind}">${mark(l)}<span class="ts">${new Date(l.ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span><span class="txt">${esc(l.text)}</span></div>`,
          )
          .join('')
      : `<p class="muted small">${tr({ ko: `아직 ${engineName(engineNow)} 대화 기록이 없습니다.`, en: `No ${engineName(engineNow)} conversation yet.` })}</p>`;
    followBottom(`log:${e.id}:${logAll ? 'all' : engineNow}`, log, lines.length);
  }
}

/** employee log: every line (marked by engine) instead of only the conversation in view */
let logAll = false;

export function bindNewTaskForm(send: Send) {
  const form = $('task-form') as HTMLFormElement;
  const att = bindAttach(form, $('task-attach'), $('task-chips'));
  const when = bindSchedule($('task-when'), $('task-when-box'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = ($('task-title') as HTMLInputElement).value.trim();
    if (!title) return;
    if (att.busy()) return void alert(tr({ ko: '첨부 파일을 올리는 중입니다. 잠시 후 다시 눌러 주세요.', en: 'Attachments are still uploading. Please try again in a moment.' }));
    const detail = ($('task-detail') as HTMLTextAreaElement).value;
    const assignee = ($('task-assignee') as HTMLSelectElement).value || null;
    const requireApproval = ($('task-lock') as HTMLInputElement).checked;
    const startAt = checkSchedule(when.take(), assignee);
    if (startAt === undefined) return;
    send({ t: 'createTask', title, detail, assignee, requireApproval, attachmentIds: att.take(), startAt });
    form.reset();
    when.reset();
  });
}

/** Human-readable text for common cron shapes; falls back to the raw expression. */
export function describeCron(expr: string): string {
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!/^\d+$/.test(mi ?? '') || !/^\d+$/.test(h ?? '') || dom !== '*' || mon !== '*') return expr;
  const time = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  if (dow === '*') return tr({ ko: `매일 ${time}`, en: `Every day ${time}` });
  if (dow === '1-5') return tr({ ko: `평일 ${time}`, en: `Weekdays ${time}` });
  if (dow === '0,6' || dow === '6,0') return tr({ ko: `주말 ${time}`, en: `Weekends ${time}` });
  if (/^\d$/.test(dow)) {
    const day = dowShort()[Number(dow) % 7];
    return tr({ ko: `매주 ${day}요일 ${time}`, en: `Every ${day} ${time}` });
  }
  return expr;
}

const when = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString(locale(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** Routine form state survives re-renders: null = closed, '' = new, otherwise the id being edited. */
let routineEdit: string | null = null;
/** language the routines panel shell was drawn in */
let routinesLang = '';

export function renderRoutines(st: UIState, send: Send) {
  const s = st.snap;
  const box = $('routines');
  if (!box.querySelector('#routine-list') || routinesLang !== getLang()) {
    routinesLang = getLang();
    box.innerHTML = `<div class="row space"><h2>${ico('⏰')}${tr({ ko: '루틴', en: 'Routines' })}</h2><button data-act="new" title="${tr({ ko: '새 루틴 등록', en: 'Add a routine' })}">${tr({ ko: '+ 새 루틴', en: '+ New routine' })}</button></div>
      <div id="routine-form"></div>
      <div id="routine-list"></div>
      <p class="muted small">${tr({
        ko: '백엔드가 켜져 있을 때만 실행됩니다. 여기서 추가·수정하거나 비서에게 말로 맡길 수 있습니다. <code>config/routines.yaml</code>은 처음 실행할 때만 불러옵니다.',
        en: 'Runs only while the backend is up. Add or edit routines here, or just ask the secretary. <code>config/routines.yaml</code> is only read on first start.',
      })}</p>`;
    box.querySelector('button[data-act="new"]')!.addEventListener('click', () => {
      routineEdit = routineEdit === '' ? null : '';
      renderRoutineForm(st, send);
    });
  }
  // the form only depends on the employee list and the routine being edited, so typing is not clobbered
  if (changed('routine-form', [routineEdit, s.employees.map((e) => [e.id, e.name]), s.skills.map((k) => k.name), routineEdit ? s.routines.some((r) => r.id === routineEdit) : 0]))
    renderRoutineForm(st, send);
  if (!changed('routines', [s.routines, s.skills, s.employees.map((e) => [e.id, e.name])])) return;
  const list = $('routine-list');
  list.innerHTML =
    s.routines
      .map((r) => {
        const who = s.employees.find((e) => e.id === r.employee);
        const sk = r.skill ? s.skills.find((k) => k.name === r.skill) : undefined;
        const skillLine = !r.skill
          ? ''
          : !sk
            ? `<div class="small bad">${ico('🧩')}office:${esc(r.skill)} — ${tr({ ko: '스킬 파일이 없습니다', en: 'skill file not found' })}</div>`
            : `<div class="small">${ico('🧩')}<code>office:${esc(sk.name)}</code> <span class="muted">${esc(sk.description)}</span>
                ${sk.approved ? (sk.allow.length ? `<span class="muted"> · ${tr({ ko: `자동 허용 ${sk.allow.length}개`, en: `${sk.allow.length} auto-allowed` })}</span>` : '') : `<button data-act="approve-skill" data-skill="${esc(sk.name)}" class="warn-btn">${tr({ ko: '⚠️ 재승인 필요', en: '⚠️ Needs re-approval' })}</button>`}</div>`;
        return `<div class="routine ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
        <div class="row space">
          <div><b>${esc(r.name)}</b> <span class="muted small">${esc(describeCron(r.schedule))} · ${esc(who ? short(who.name) : r.employee)}</span></div>
          <div class="row">
            <label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}/> ${tr({ ko: '켜짐', en: 'On' })}</label>
            <button data-act="run">${tr({ ko: '지금 실행', en: 'Run now' })}</button>
            <button data-act="edit">${tr({ ko: '수정', en: 'Edit' })}</button>
            <button data-act="delete" class="danger">${tr({ ko: '삭제', en: 'Delete' })}</button>
          </div>
        </div>
        ${skillLine}
        <div class="muted small">${tr({ ko: '다음', en: 'Next' })} ${esc(r.enabled ? when(r.nextRun) : tr({ ko: '꺼짐', en: 'off' }))} · ${tr({ ko: '마지막', en: 'Last' })} ${esc(when(r.lastRun))}</div>
      </div>`;
      })
      .join('') ||
    `<p class="muted">${tr({ ko: '등록된 루틴이 없습니다. <b>+ 새 루틴</b>으로 추가하세요.', en: 'No routines yet. Add one with <b>+ New routine</b>.' })}</p>`;
  list.querySelectorAll<HTMLElement>('.routine').forEach((el) => {
    const id = el.dataset.id!;
    const r = s.routines.find((x) => x.id === id)!;
    el.querySelector('button[data-act="run"]')!.addEventListener('click', () => send({ t: 'runRoutine', id }));
    el.querySelector('button[data-act="edit"]')!.addEventListener('click', () => {
      routineEdit = id;
      renderRoutineForm(st, send);
    });
    el.querySelector('button[data-act="delete"]')!.addEventListener('click', () => {
      if (confirm(tr({ ko: `루틴 "${r.name}"을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`, en: `Delete routine "${r.name}"?\nThis cannot be undone.` }))) {
        if (routineEdit === id) routineEdit = null;
        send({ t: 'deleteRoutine', id });
      }
    });
    el.querySelector<HTMLButtonElement>('button[data-act="approve-skill"]')?.addEventListener('click', (ev) => {
      const name = (ev.currentTarget as HTMLElement).dataset.skill!;
      const sk = s.skills.find((k) => k.name === name);
      const rules = sk?.allow.length
        ? tr({ ko: `예약 실행에서 자동 허용될 도구:\n- ${sk.allow.join('\n- ')}`, en: `Tools auto-allowed in scheduled runs:\n- ${sk.allow.join('\n- ')}` })
        : tr({ ko: '자동 허용 도구 없음', en: 'No auto-allowed tools' });
      const path = `workspaces/office-skills/skills/${name}/SKILL.md`;
      if (confirm(tr({ ko: `스킬 office:${name}의 현재 파일 내용을 승인할까요?\n(${path})\n\n${rules}`, en: `Approve the current contents of skill office:${name}?\n(${path})\n\n${rules}` })))
        send({ t: 'approveSkill', name });
    });
    el.querySelector<HTMLInputElement>('input[data-act="toggle"]')!.addEventListener('change', (ev) =>
      send({ t: 'toggleRoutine', id, enabled: (ev.target as HTMLInputElement).checked }),
    );
  });
}

function renderRoutineForm(st: UIState, send: Send) {
  const s = st.snap;
  const box = $('routine-form');
  const editing = routineEdit ? s.routines.find((r) => r.id === routineEdit) : undefined;
  if (routineEdit === null || (routineEdit && !editing)) {
    routineEdit = null;
    box.innerHTML = '';
    return;
  }
  const emps = [...s.employees].sort((a, b) => a.desk - b.desk);
  const r = editing ?? { name: '', schedule: '0 9 * * 1-5', employee: emps.find((e) => e.id === 'sec')?.id ?? emps[0]?.id ?? '', prompt: '', skill: null as string | null };
  box.innerHTML = `<form class="routine-form">
      <b>${editing ? tr({ ko: `루틴 수정: ${esc(editing.name)}`, en: `Edit routine: ${esc(editing.name)}` }) : tr({ ko: '새 루틴', en: 'New routine' })}</b>
      <input name="name" placeholder="${tr({ ko: '이름 (예: 점심 전 job 점검)', en: 'Name (e.g. Check jobs before lunch)' })}" value="${esc(r.name)}" autocomplete="off" required />
      <div class="row">
        <input name="schedule" placeholder="${tr({ ko: '분 시 일 월 요일', en: 'min hour day month weekday' })}" value="${esc(r.schedule)}" autocomplete="off" required />
        <select name="employee">${emps.map((e) => `<option value="${esc(e.id)}" ${e.id === r.employee ? 'selected' : ''}>${esc(short(e.name))} · ${esc(e.title)}</option>`).join('')}</select>
      </div>
      <div class="muted small" data-preview></div>
      <select name="skill">
        <option value="">${tr({ ko: '(스킬 없음 — 지시문 직접 입력)', en: '(no skill — write the instruction)' })}</option>
        ${s.skills.map((k) => `<option value="${esc(k.name)}" ${k.name === r.skill ? 'selected' : ''}>🧩 office:${esc(k.name)} — ${esc(k.description)}</option>`).join('')}
      </select>
      <textarea name="prompt" rows="4">${esc(r.prompt)}</textarea>
      <div class="muted small">${tr({
        ko: '스킬은 비서에게 "○○ 루틴 만들고 싶어"라고 말하면 대화로 정리해서 만들어 줍니다.',
        en: 'To get a skill, tell the secretary "I want a routine that does …" and it will work one out with you.',
      })}</div>
      <div class="row"><button class="primary" type="submit">${editing ? tr({ ko: '저장', en: 'Save' }) : tr({ ko: '등록', en: 'Add' })}</button><button type="button" data-act="cancel">${tr({ ko: '취소', en: 'Cancel' })}</button></div>
    </form>`;
  const form = box.querySelector('form')!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const preview = form.querySelector<HTMLElement>('[data-preview]')!;
  const upd = () => {
    const v = field('schedule').value.trim();
    const d = describeCron(v);
    preview.textContent =
      v.split(/\s+/).length !== 5
        ? tr({ ko: 'cron 5필드: 분 시 일 월 요일 (요일 0=일 … 6=토, 1-5=평일)', en: 'cron, 5 fields: min hour day month weekday (weekday 0=Sun … 6=Sat, 1-5=weekdays)' })
        : d !== v
          ? `→ ${d}`
          : tr({ ko: '분 시 일 월 요일 (요일 0=일 … 6=토)', en: 'min hour day month weekday (weekday 0=Sun … 6=Sat)' });
  };
  field('schedule').addEventListener('input', upd);
  upd();
  const promptEl = form.elements.namedItem('prompt') as HTMLTextAreaElement;
  const updSkill = () => {
    const hasSkill = !!field('skill').value;
    promptEl.placeholder = hasSkill
      ? tr({ ko: '추가 메모 (선택) — 스킬에 덧붙여 보낼 말', en: 'Extra note (optional) — sent along with the skill' })
      : tr({ ko: '정해진 시간마다 직원에게 보낼 지시', en: 'Instruction sent to the employee on schedule' });
    promptEl.rows = hasSkill ? 2 : 4;
  };
  field('skill').addEventListener('change', updSkill);
  updSkill();
  form.querySelector('button[data-act="cancel"]')!.addEventListener('click', () => {
    routineEdit = null;
    renderRoutineForm(st, send);
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = field('name').value.trim();
    const prompt = field('prompt').value;
    const skill = field('skill').value || null;
    if (!name) return;
    if (!skill && !prompt.trim()) {
      alert(tr({ ko: '스킬을 고르거나 지시문을 입력하세요.', en: 'Pick a skill or write an instruction.' }));
      return;
    }
    send({
      t: 'saveRoutine',
      ...(editing ? { id: editing.id } : {}),
      name,
      schedule: field('schedule').value.trim(),
      employee: field('employee').value,
      prompt,
      skill,
    });
    routineEdit = null;
    renderRoutineForm(st, send);
  });
}

/** Approvals that remove things get a second, explicit confirmation. Returns false to abort. */
export function confirmApprove(a: Approval, snap: Snapshot): boolean {
  if (a.toolName === 'mcp__office__save_skill') {
    const inp = a.input as { name?: string; allow?: string[] };
    if (!inp.allow?.length) return true;
    const list = inp.allow.join('\n- ');
    return confirm(
      tr({
        ko: `비서가 스킬 office:${inp.name}을(를) 저장하려고 합니다.\n이 스킬을 실행하는 루틴에서는 아래 도구가 승인 없이 실행됩니다:\n\n- ${list}\n\n승인할까요?`,
        en: `The secretary wants to save skill office:${inp.name}.\nRoutines running this skill will run these tools without approval:\n\n- ${list}\n\nApprove?`,
      }),
    );
  }
  if (a.toolName !== 'mcp__office__delete_routine') return true;
  const id = String((a.input as Record<string, unknown>).id ?? '');
  const r = snap.routines.find((x) => x.id === id);
  const name = r?.name ?? id;
  return confirm(
    tr({ ko: `비서가 루틴 "${name}"을(를) 삭제하려고 합니다.\n삭제하면 되돌릴 수 없습니다. 승인할까요?`, en: `The secretary wants to delete routine "${name}".\nThis cannot be undone. Approve?` }),
  );
}
