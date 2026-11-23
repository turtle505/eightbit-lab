// Console view: plain, table-based rendering of the same office state.
import { attachmentLinks, bindAttach } from './attach.ts';
import type { TaskState } from '../../../shared/protocol.ts';
import { $, STATUS_KO, type Send, type UIState, ago, changed, esc, hostBadge, plain, providerBadge, resetText, short, usageShare } from './panels.ts';

const STATE_KO: Record<TaskState, string> = { todo: '할 일', doing: '진행 중', review: '검토', done: '완료' };
const STATE_ORDER: TaskState[] = ['doing', 'review', 'todo', 'done'];
const KIND_KO: Record<string, string> = { user: '지시', assistant: '응답', tool: '도구', result: '결과', system: '시스템', error: '오류' };
const BUSY = ['thinking', 'typing', 'running', 'researching', 'remote', 'waiting_permission', 'queued'];

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function sortedEmployees(st: UIState) {
  return [...st.snap.employees].sort((a, b) => a.desk - b.desk);
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
        <td><span class="badge b-${e.status}">${STATUS_KO[e.status] ?? e.status}</span> <span class="muted small" title="${e.permission === 'auto' ? '자동 모드' : '승인 모드'}">${e.permission === 'auto' ? '자동' : '승인'}</span></td>
        <td class="activity" title="${esc(e.activity)}">${esc(plain(e.activity))}</td>
        <td class="num">${task ? `#${task.id}` : '—'}</td>
        <td class="num mono" title="${e.live ? '세션 열림 (다음 지시 바로 시작)' : '세션 대기 (다음 지시 때 이어서 엶)'}">${e.live ? '●' : '○'} ${e.sessionId ? esc(e.sessionId.slice(0, 8)) : '—'}</td>
        ${e.provider ? `<td class="num muted" title="로컬 모델 — 구독 사용 안 함">로컬</td>` : `<td class="num" title="API 가격 환산 ≈$${e.costUsd.toFixed(2)} / 사무실 전체 ≈$${total.toFixed(2)}">${usageShare(st, e.costUsd)}</td>`}
        <td class="num muted">${u ? ago(u) : '—'}</td>
        <td class="actions">${BUSY.includes(e.status) ? `<button data-act="stop">중지</button>` : ''}</td>
      </tr>`;
    })
    .join('');
  $('c-staff').innerHTML = `<table class="ctable staff">
    <thead><tr><th class="num">#</th><th>직원</th><th>상태</th><th>현재 활동</th><th class="num">작업</th><th class="num">세션</th><th class="num" title="사무실 전체 사용량 중 이 직원의 비중">비중</th><th class="num">갱신</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $('c-staff').querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
    const id = tr.dataset.id!;
    tr.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      select(st.selected === id ? null : id);
    });
    tr.querySelector('button[data-act="stop"]')?.addEventListener('click', () => send({ t: 'stop', employeeId: id }));
  });
}

const expanded = new Set<number>();

export function renderTaskTable(st: UIState, send: Send) {
  const emps = sortedEmployees(st);
  if (changed('c-assignee', emps.map((e) => e.id + e.name))) {
    const sel = $('c-task-assignee') as HTMLSelectElement;
    const v = sel.value;
    sel.innerHTML = `<option value="">담당: 나중에</option>` + emps.map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))}</option>`).join('');
    sel.value = v;
  }
  if (!changed('c-tasks', [st.snap.tasks, emps.map((e) => [e.id, e.name]), [...expanded], Math.floor(Date.now() / 15000)])) return;
  const tasks = [...st.snap.tasks].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.id - a.id);
  const empOpts = (cur: string | null) =>
    `<option value="" ${cur ? '' : 'selected'}>—</option>` +
    emps.map((e) => `<option value="${esc(e.id)}" ${cur === e.id ? 'selected' : ''}>${esc(short(e.name))}</option>`).join('');
  const stateOpts = (cur: TaskState) => STATE_ORDER.map((s) => `<option value="${s}" ${cur === s ? 'selected' : ''}>${STATE_KO[s]}</option>`).join('');
  const rows = tasks
    .map((t) => {
      const open = expanded.has(t.id);
      const main = `<tr data-id="${t.id}" class="task t-${t.state}">
        <td class="num">#${t.id}</td>
        <td class="title"><button class="link" data-act="expand" aria-expanded="${open}">${open ? '▾' : '▸'} ${t.requireApproval ? '[승인] ' : ''}${esc(t.title)}${t.attachments?.length ? ` <span class="muted">[첨부 ${t.attachments.length}]</span>` : ''}</button></td>
        <td><select data-act="state">${stateOpts(t.state)}</select></td>
        <td><select data-act="assign">${empOpts(t.assignee)}</select></td>
        <td class="num muted">${ago(t.updatedAt)}</td>
        <td class="actions"><button data-act="del" title="삭제">삭제</button></td>
      </tr>`;
      const detail = open
        ? `<tr class="detail"><td></td><td colspan="5">
            ${t.detail ? `<div class="small"><b>지시</b><pre>${esc(t.detail)}</pre></div>` : ''}
            ${t.attachments?.length ? `<div class="small"><b>첨부</b> ${attachmentLinks(t.attachments)}</div>` : ''}
            ${t.result ? `<div class="small"><b>보고</b><pre>${esc(t.result)}</pre></div>` : '<div class="muted small">아직 보고 없음</div>'}
          </td></tr>`
        : '';
      return main + detail;
    })
    .join('');
  $('c-tasks').innerHTML = tasks.length
    ? `<table class="ctable tasks"><thead><tr><th class="num">#</th><th>제목</th><th>상태</th><th>담당</th><th class="num">갱신</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted small">작업이 없습니다. 위 입력줄에서 추가하세요.</p>`;
  $('c-tasks').querySelectorAll<HTMLTableRowElement>('tr.task').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-act="expand"]')!.addEventListener('click', () => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTaskTable(st, send);
    });
    tr.querySelector<HTMLSelectElement>('select[data-act="state"]')!.addEventListener('change', (ev) =>
      send({ t: 'moveTask', taskId: id, state: (ev.target as HTMLSelectElement).value as TaskState }),
    );
    tr.querySelector<HTMLSelectElement>('select[data-act="assign"]')!.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      if (v) send({ t: 'assignTask', taskId: id, employeeId: v });
    });
    tr.querySelector('button[data-act="del"]')!.addEventListener('click', () => {
      if (confirm(`작업 #${id}을 삭제할까요?`)) send({ t: 'deleteTask', taskId: id });
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
    if (att.busy()) return void alert('첨부 파일을 올리는 중입니다. 잠시 후 다시 눌러 주세요.');
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
      (l) => `<tr class="k-${l.kind}"><td class="num mono">${hhmm(l.ts)}</td><td>${esc(names.get(l.employeeId) ?? l.employeeId)}</td>
        <td><span class="kind">${KIND_KO[l.kind] ?? l.kind}</span></td><td class="txt" title="${esc(l.text.slice(0, 2000))}">${esc(plain(l.text).replace(/\s+/g, ' ').slice(0, 240))}</td></tr>`,
    )
    .join('');
  const box = $('c-feed');
  const opts =
    `<option value="">전체 직원</option>` +
    sortedEmployees(st)
      .map((e) => `<option value="${esc(e.id)}" ${feedFilter === e.id ? 'selected' : ''}>${esc(short(e.name))}</option>`)
      .join('');
  box.innerHTML = `<div class="row c-feed-bar"><select id="c-feed-filter">${opts}</select><span class="muted small">최근 ${shown.length}건 · 최신이 위</span></div>
    ${shown.length ? `<div class="feed-scroll"><table class="ctable feed"><tbody>${body}</tbody></table></div>` : '<p class="muted small">아직 활동이 없습니다.</p>'}`;
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
    : `<p class="muted small">${esc(u?.note || '확인 중')}</p>`;
  $('c-usage').innerHTML = `<div class="c-head"><h2>구독 사용량${u?.plan ? ` <span class="muted small">${esc(u.plan)}</span>` : ''}</h2>
      <button type="button" id="c-usage-refresh">새로고침</button></div>
    ${rows}
    <p class="muted small">${u?.fetchedAt ? `${ago(u.fetchedAt)} 전 조회 · 3분마다, 직원 작업이 끝날 때 갱신` : ''}${u?.available && u.note ? ` · ${esc(u.note)}` : ''}</p>`;
  $('c-usage-refresh').addEventListener('click', () => send({ t: 'refreshUsage' }));
}
