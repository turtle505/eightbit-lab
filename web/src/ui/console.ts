// Console view: plain, table-based rendering of the same office state.
import { attachmentLinks, bindAttach } from './attach.ts';
import type { TaskState } from '../../../shared/protocol.ts';
import { locale, tr } from '../../../shared/i18n.ts';
import { $, type Send, type UIState, ago, agoText, changed, esc, hostBadge, plain, providerBadge, resetText, short, statusLabel, usageShare } from './panels.ts';

const STATE: Record<TaskState, { ko: string; en: string }> = {
  todo: { ko: '할 일', en: 'To do' },
  doing: { ko: '진행 중', en: 'Doing' },
  review: { ko: '검토', en: 'Review' },
  done: { ko: '완료', en: 'Done' },
};
const STATE_ORDER: TaskState[] = ['doing', 'review', 'todo', 'done'];
const KIND: Record<string, { ko: string; en: string }> = {
  user: { ko: '지시', en: 'instr' },
  assistant: { ko: '응답', en: 'reply' },
  tool: { ko: '도구', en: 'tool' },
  result: { ko: '결과', en: 'result' },
  system: { ko: '시스템', en: 'system' },
  error: { ko: '오류', en: 'error' },
};
const kindLabel = (k: string) => (KIND[k] ? tr(KIND[k]) : k);
const BUSY = ['thinking', 'typing', 'running', 'researching', 'remote', 'waiting_permission', 'queued'];

const hms = (ts: number) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The office staff. Project sessions are employees too, but they belong to the projects tab. */
export function sortedEmployees(st: UIState) {
  return st.snap.employees.filter((e) => e.kind !== 'project').sort((a, b) => a.desk - b.desk);
}

export function renderStaffTable(st: UIState, send: Send, select: (id: string | null) => void) {
  const emps = sortedEmployees(st);
  const upd = emps.map((e) => st.empUpdated.get(e.id) ?? 0);
  // ago() changes over time, so include a coarse clock tick in the memo key
  if (!changed('c-staff', [emps, st.selected, upd, st.snap.providers, st.snap.hosts, Math.floor(Date.now() / 15000)])) return;
  const total = emps.reduce((a, e) => a + e.costUsd, 0);
  const rows = emps
    .map((e, i) => {
      const task = e.taskId ? st.snap.tasks.find((t) => t.id === e.taskId) : null;
      const u = st.empUpdated.get(e.id);
      return `<tr data-id="${esc(e.id)}" class="${st.selected === e.id ? 'sel' : ''}">
        <td class="num">${i + 1}</td>
        <td><b>${esc(short(e.name))}</b><div class="muted small">${esc(e.title)}</div>${e.hostId ? `<div class="small">${hostBadge(st, e, true)}</div>` : ''}${e.provider ? `<div class="small">${providerBadge(st, e, true)}</div>` : ''}</td>
        <td><span class="badge b-${e.status}">${statusLabel(e.status)}</span> <span class="muted small" title="${e.permission === 'auto' ? tr({ ko: '자동 모드', en: 'Auto mode' }) : tr({ ko: '승인 모드', en: 'Approval mode' })}">${
          e.permission === 'auto' ? tr({ ko: '자동', en: 'auto' }) : tr({ ko: '승인', en: 'ask' })
        }</span></td>
        <td class="activity" title="${esc(e.activity)}">${esc(plain(e.activity))}</td>
        <td class="num">${task ? `#${task.id}` : '—'}</td>
        <td class="num mono" title="${e.live ? tr({ ko: '세션 열림 (다음 지시 바로 시작)', en: 'Session open (next instruction starts right away)' }) : tr({ ko: '세션 대기 (다음 지시 때 이어서 엶)', en: 'Session idle (reopened on the next instruction)' })}">${e.live ? '●' : '○'} ${e.sessionId ? esc(e.sessionId.slice(0, 8)) : '—'}</td>
        ${
          e.provider
            ? `<td class="num muted" title="${tr({ ko: '로컬 모델 — 구독 사용 안 함', en: 'Local model — no subscription use' })}">${tr({ ko: '로컬', en: 'local' })}</td>`
            : `<td class="num" title="${tr({ ko: `API 가격 환산 ≈$${e.costUsd.toFixed(2)} / 사무실 전체 ≈$${total.toFixed(2)}`, en: `At API prices ≈$${e.costUsd.toFixed(2)} / whole office ≈$${total.toFixed(2)}` })}">${usageShare(st, e.costUsd)}</td>`
        }
        <td class="num muted">${u ? ago(u) : '—'}</td>
        <td class="actions">${BUSY.includes(e.status) ? `<button data-act="stop">${tr({ ko: '중지', en: 'Stop' })}</button>` : ''}</td>
      </tr>`;
    })
    .join('');
  $('c-staff').innerHTML = `<table class="ctable staff">
    <thead><tr><th class="num">#</th><th>${tr({ ko: '직원', en: 'Staff' })}</th><th>${tr({ ko: '상태', en: 'Status' })}</th><th>${tr({ ko: '현재 활동', en: 'Activity' })}</th><th class="num">${tr({ ko: '작업', en: 'Task' })}</th><th class="num">${tr({ ko: '세션', en: 'Session' })}</th><th class="num" title="${tr({ ko: '사무실 전체 사용량 중 이 직원의 비중', en: "This employee's share of the office's total usage" })}">${tr({ ko: '비중', en: 'Share' })}</th><th class="num">${tr({ ko: '갱신', en: 'Updated' })}</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $('c-staff').querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((row) => {
    const id = row.dataset.id!;
    row.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      select(st.selected === id ? null : id);
    });
    row.querySelector('button[data-act="stop"]')?.addEventListener('click', () => send({ t: 'stop', employeeId: id }));
  });
}

const expanded = new Set<number>();

export function renderTaskTable(st: UIState, send: Send) {
  const emps = sortedEmployees(st);
  if (changed('c-assignee', emps.map((e) => e.id + e.name))) {
    const sel = $('c-task-assignee') as HTMLSelectElement;
    const v = sel.value;
    sel.innerHTML = `<option value="">${tr({ ko: '담당: 나중에', en: 'Assignee: later' })}</option>` + emps.map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))}</option>`).join('');
    sel.value = v;
  }
  if (!changed('c-tasks', [st.snap.tasks, emps.map((e) => [e.id, e.name]), [...expanded], Math.floor(Date.now() / 15000)])) return;
  const tasks = [...st.snap.tasks].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.id - a.id);
  const empOpts = (cur: string | null) =>
    `<option value="" ${cur ? '' : 'selected'}>—</option>` +
    emps.map((e) => `<option value="${esc(e.id)}" ${cur === e.id ? 'selected' : ''}>${esc(short(e.name))}</option>`).join('');
  const stateOpts = (cur: TaskState) => STATE_ORDER.map((s) => `<option value="${s}" ${cur === s ? 'selected' : ''}>${tr(STATE[s])}</option>`).join('');
  const rows = tasks
    .map((t) => {
      const open = expanded.has(t.id);
      const main = `<tr data-id="${t.id}" class="task t-${t.state}">
        <td class="num">#${t.id}</td>
        <td class="title"><button class="link" data-act="expand" aria-expanded="${open}">${open ? '▾' : '▸'} ${t.requireApproval ? tr({ ko: '[승인] ', en: '[ask] ' }) : ''}${esc(t.title)}${
          t.attachments?.length ? ` <span class="muted">${tr({ ko: `[첨부 ${t.attachments.length}]`, en: `[${t.attachments.length} files]` })}</span>` : ''
        }</button></td>
        <td><select data-act="state">${stateOpts(t.state)}</select></td>
        <td><select data-act="assign">${empOpts(t.assignee)}</select></td>
        <td class="num muted">${ago(t.updatedAt)}</td>
        <td class="actions"><button data-act="del" title="${tr({ ko: '삭제', en: 'Delete' })}">${tr({ ko: '삭제', en: 'Delete' })}</button></td>
      </tr>`;
      const detail = open
        ? `<tr class="detail"><td></td><td colspan="5">
            ${t.detail ? `<div class="small"><b>${tr({ ko: '지시', en: 'Instruction' })}</b><pre>${esc(t.detail)}</pre></div>` : ''}
            ${t.attachments?.length ? `<div class="small"><b>${tr({ ko: '첨부', en: 'Attachments' })}</b> ${attachmentLinks(t.attachments)}</div>` : ''}
            ${t.result ? `<div class="small"><b>${tr({ ko: '보고', en: 'Report' })}</b><pre>${esc(t.result)}</pre></div>` : `<div class="muted small">${tr({ ko: '아직 보고 없음', en: 'No report yet' })}</div>`}
          </td></tr>`
        : '';
      return main + detail;
    })
    .join('');
  $('c-tasks').innerHTML = tasks.length
    ? `<table class="ctable tasks"><thead><tr><th class="num">#</th><th>${tr({ ko: '제목', en: 'Title' })}</th><th>${tr({ ko: '상태', en: 'State' })}</th><th>${tr({ ko: '담당', en: 'Assignee' })}</th><th class="num">${tr({ ko: '갱신', en: 'Updated' })}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted small">${tr({ ko: '작업이 없습니다. 위 입력줄에서 추가하세요.', en: 'No tasks. Add one from the row above.' })}</p>`;
  $('c-tasks').querySelectorAll<HTMLTableRowElement>('tr.task').forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="expand"]')!.addEventListener('click', () => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTaskTable(st, send);
    });
    row.querySelector<HTMLSelectElement>('select[data-act="state"]')!.addEventListener('change', (ev) =>
      send({ t: 'moveTask', taskId: id, state: (ev.target as HTMLSelectElement).value as TaskState }),
    );
    row.querySelector<HTMLSelectElement>('select[data-act="assign"]')!.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      if (v) send({ t: 'assignTask', taskId: id, employeeId: v });
    });
    row.querySelector('button[data-act="del"]')!.addEventListener('click', () => {
      if (confirm(tr({ ko: `작업 #${id}을 삭제할까요?`, en: `Delete task #${id}?` }))) send({ t: 'deleteTask', taskId: id });
    });
  });
}

export function bindConsoleTaskForm(send: Send) {
  const form = $('c-task-form') as HTMLFormElement;
  const att = bindAttach(form, $('c-task-attach'), $('c-task-chips'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = ($('c-task-title') as HTMLInputElement).value.trim();
    if (!title) return;
    if (att.busy()) return void alert(tr({ ko: '첨부 파일을 올리는 중입니다. 잠시 후 다시 눌러 주세요.', en: 'Attachments are still uploading. Please try again in a moment.' }));
    const detail = ($('c-task-detail') as HTMLInputElement).value;
    const assignee = ($('c-task-assignee') as HTMLSelectElement).value || null;
    const requireApproval = ($('c-task-lock') as HTMLInputElement).checked;
    send({ t: 'createTask', title, detail, assignee, requireApproval, attachmentIds: att.take() });
    form.reset();
  });
}

let feedFilter = '';

export function renderFeed(st: UIState) {
  const lines = st.feed;
  if (!changed('c-feed', [lines.length, lines[lines.length - 1]?.ts, feedFilter, st.snap.employees.map((e) => e.name)])) return;
  const names = new Map(st.snap.employees.map((e) => [e.id, short(e.name)]));
  const shown = lines.filter((l) => !feedFilter || l.employeeId === feedFilter).slice(-200).reverse();
  const body = shown
    .map(
      (l) => `<tr class="k-${l.kind}"><td class="num mono">${hms(l.ts)}</td><td>${esc(names.get(l.employeeId) ?? l.employeeId)}</td>
        <td><span class="kind">${kindLabel(l.kind)}</span></td><td class="txt" title="${esc(l.text.slice(0, 2000))}">${esc(plain(l.text).replace(/\s+/g, ' ').slice(0, 240))}</td></tr>`,
    )
    .join('');
  const box = $('c-feed');
  const opts =
    `<option value="">${tr({ ko: '전체 직원', en: 'All staff' })}</option>` +
    sortedEmployees(st)
      .map((e) => `<option value="${esc(e.id)}" ${feedFilter === e.id ? 'selected' : ''}>${esc(short(e.name))}</option>`)
      .join('');
  box.innerHTML = `<div class="row c-feed-bar"><select id="c-feed-filter">${opts}</select><span class="muted small">${tr({ ko: `최근 ${shown.length}건 · 최신이 위`, en: `Last ${shown.length} · newest first` })}</span></div>
    ${shown.length ? `<div class="feed-scroll"><table class="ctable feed"><tbody>${body}</tbody></table></div>` : `<p class="muted small">${tr({ ko: '아직 활동이 없습니다.', en: 'No activity yet.' })}</p>`}`;
  ($('c-feed-filter') as HTMLSelectElement).addEventListener('change', (ev) => {
    feedFilter = (ev.target as HTMLSelectElement).value;
    renderFeed(st);
  });
}

export function renderUsagePanel(st: UIState, send: Send) {
  const u = st.snap.usage;
  if (!changed('c-usage', [u, Math.floor(Date.now() / 60000)])) return;
  const rows = u?.available
    ? u.rows
        .map(
          (r) => `<div class="urow sev-${esc(r.severity)}">
            <div class="row space"><span>${esc(r.label)}</span><b class="mono">${r.percent}%</b></div>
            <div class="ubar"><i style="width:${Math.min(100, r.percent)}%"></i></div>
            <div class="muted small">${esc(resetText(r.resetsAt))}</div>
          </div>`,
        )
        .join('')
    : `<p class="muted small">${esc(u?.note || tr({ ko: '확인 중', en: 'Checking…' }))}</p>`;
  $('c-usage').innerHTML = `<div class="c-head"><h2>${tr({ ko: '구독 사용량', en: 'Subscription usage' })}${u?.plan ? ` <span class="muted small">${esc(u.plan)}</span>` : ''}</h2>
      <button type="button" id="c-usage-refresh">${tr({ ko: '새로고침', en: 'Refresh' })}</button></div>
    ${rows}
    <p class="muted small">${
      u?.fetchedAt
        ? tr({
            ko: `${agoText(u.fetchedAt)} 조회 · 3분마다, 직원 작업이 끝날 때 갱신`,
            en: `Fetched ${agoText(u.fetchedAt)} · refreshed every 3 min and when a run finishes`,
          })
        : ''
    }${u?.available && u.note ? ` · ${esc(u.note)}` : ''}</p>`;
  $('c-usage-refresh').addEventListener('click', () => send({ t: 'refreshUsage' }));
}
