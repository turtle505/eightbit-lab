import { attachmentLinks, bindAttach } from './attach.ts';
import type { Approval, ClientMsg, EmployeeView, LogLine, Snapshot, TaskState } from '../../../shared/protocol.ts';

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

// Re-render a region only when its data changed (keeps focus / open dropdowns intact).
const keys = new Map<string, string>();
export function changed(region: string, data: unknown): boolean {
  const k = JSON.stringify(data);
  if (keys.get(region) === k) return false;
  keys.set(region, k);
  return true;
}

export const STATUS_KO: Record<string, string> = {
  idle: '휴식',
  queued: '대기열',
  thinking: '생각 중',
  typing: '작업 중',
  running: '실행 중',
  researching: '조사 중',
  remote: '서버실',
  waiting_permission: '승인 대기',
  done: '완료',
  error: '오류',
};

const DOW_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

/** "19:40 초기화" today/within a day, else "11/29(토) 01:00 초기화". */
export function resetText(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const left = ts - Date.now();
  if (left <= 0) return '곧 초기화';
  const rel = left < 3600_000 ? `${Math.max(1, Math.round(left / 60_000))}분 후` : left < 86400_000 ? `${Math.round(left / 3600_000)}시간 후` : `${Math.round(left / 86400_000)}일 후`;
  const when = left < 86400_000 ? hm : `${d.getMonth() + 1}/${d.getDate()}(${DOW_SHORT[d.getDay()]}) ${hm}`;
  return `${when} 초기화 · ${rel}`;
}

/** "🖥 desktop" when the employee's sessions run on another machine, else '' (the backend's own machine). */
export function hostBadge(st: UIState, e: EmployeeView, plainText = false): string {
  if (!e.hostId) return '';
  const h = (st.snap.hosts ?? []).find((x) => x.id === e.hostId);
  if (!h) return `<span class="prov off" title="설정에 host '${esc(e.hostId)}' 가 없음">${esc(e.hostId)} · 설정 없음</span>`;
  // the ssh budget only earns screen space when it is nearly spent; otherwise it lives in the tooltip
  const budget = h.sshLimit > 0 ? ` · 분당 ssh ${h.sshUsed}/${h.sshLimit}` : '';
  const tight = h.sshLimit > 0 && h.sshUsed >= h.sshLimit * 0.8;
  const tip = (h.ok ? `세션이 이 머신에서 실행됩니다 · claude ${h.claudeVersion ?? ''}` : h.error ?? '') + budget;
  return `<span class="prov ${h.ok ? 'on' : 'off'}" title="${esc(tip)}">${esc(plainText ? plain(h.name) : h.name)}${
    h.ok ? '' : ' · 연결 안 됨'
  }${tight ? ` <span class="ssh-tight">⏳ ${h.sshUsed}/${h.sshLimit}</span>` : ''}</span>`;
}

/** Provider (local model) of an employee, if it runs on one. */
export function providerOf(st: UIState, e: EmployeeView) {
  return e.provider ? (st.snap.providers ?? []).find((p) => p.id === e.provider) ?? null : null;
}

/** "🖥 desktop · qwen3.5:9b · 연결됨" — plain text when `plainText` (console table) */
export function providerBadge(st: UIState, e: EmployeeView, plainText = false): string {
  if (!e.provider) return '';
  const p = providerOf(st, e);
  if (!p) return `<span class="prov off" title="설정에 provider '${esc(e.provider)}' 가 없음">${plainText ? '' : '🖥 '}${esc(e.provider)} · 설정 없음</span>`;
  const state = p.ok ? '연결됨' : '끊김';
  const tip = p.ok ? `Ollama ${p.version ?? ''} · 설치된 모델 ${p.models.length}개` : p.error ?? '';
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
  const data = [st.connected, busy, s.maxConcurrent, s.approvals.length, u, Math.floor(Date.now() / 60000), typeof Notification !== 'undefined' ? Notification.permission : 'na'];
  if (!changed('header', data)) return;
  // headline meters: session + overall weekly; model-scoped weekly rows go in the tooltip
  const main = u?.rows.filter((r) => r.kind === 'session' || r.kind === 'weekly_all') ?? [];
  const extra = u?.rows.filter((r) => !main.includes(r)) ?? [];
  const tip = (u?.rows ?? []).map((r) => `${r.label}: ${r.percent}% ${resetText(r.resetsAt)}`).join('\n') + (u?.plan ? `\n플랜: ${u.plan}` : '') + '\n(클릭하면 새로고침)';
  const meters = u?.available && main.length
    ? main
        .map(
          (r) => `<button type="button" class="pill meter sev-${esc(r.severity)}" data-usage title="${esc(tip)}">
            ${r.kind === 'session' ? '세션' : '주간'} <b>${r.percent}%</b><span class="mbar"><i style="width:${Math.min(100, r.percent)}%"></i></span><span class="muted">${esc(resetText(r.resetsAt).split(' · ')[0])}</span></button>`,
        )
        .join('') + (extra.length ? `<span class="pill muted" title="${esc(tip)}">${extra.map((r) => `${esc(r.label.replace(/^주간 · /, ''))} ${r.percent}%`).join(' · ')}</span>` : '')
    : `<button type="button" class="pill" data-usage title="${esc(u?.note || '')}">사용량 ${u?.fetchedAt ? '—' : '확인 중'}</button>`;
  $('stats').innerHTML = `
    <span class="pill ${st.connected ? 'ok' : 'bad'}">${st.connected ? '● 연결됨' : '○ 연결 끊김'}</span>
    <span class="pill">근무 중 <b>${busy}</b>/${s.maxConcurrent}</span>
    <span class="pill ${s.approvals.length ? 'warn' : ''}">승인 대기 <b>${s.approvals.length}</b></span>
    ${meters}`;
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
    `<h2>${ico('✋')}승인 요청 <span class="muted small">${s.approvals.length}건${st.view === 'console' && s.approvals.length ? ' · 첫 건 a 승인 / d 거부' : ''}</span></h2>` +
    (s.approvals.length ? '' : `<p class="muted small">대기 중인 승인 요청이 없습니다.</p>`) +
    s.approvals
      .map((a) => {
        const who = s.employees.find((e) => e.id === a.employeeId);
        const inp = a.input as Record<string, unknown>;
        const routine = a.toolName.includes('_routine') ? s.routines.find((r) => r.id === inp.id) : undefined;
        const main = inp.command ?? inp.file_path ?? inp.url ?? inp.query ?? (routine ? `루틴: ${routine.name} (${routine.id})` : inp.name ?? inp.id) ?? '';
        const rest = JSON.stringify(inp, null, 2);
        return `<div class="approval" data-id="${esc(a.id)}">
          <div class="approval-head"><b>${esc(who ? short(who.name) : a.employeeId)}</b> → <code>${esc(a.toolName)}</code> <span class="muted">${ago(a.createdAt)} 전</span></div>
          ${main ? `<pre class="cmd">${esc(main)}</pre>` : ''}
          ${inp.description ? `<div class="muted">${esc(inp.description)}</div>` : ''}
          <details><summary>전체 입력</summary><pre>${esc(rest)}</pre></details>
          <div class="row"><button class="primary" data-act="allow">승인</button><button data-act="deny">거부</button></div>
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

const COLS: Array<[TaskState, string]> = [
  ['todo', '할 일'],
  ['doing', '진행 중'],
  ['review', '검토'],
  ['done', '완료'],
];

export function renderBoard(st: UIState, send: Send) {
  const s = st.snap;
  const emps = [...s.employees].sort((a, b) => a.desk - b.desk);
  // assignee select in the new-task form
  if (changed('assigneeSelect', emps.map((e) => e.id + e.name))) {
    const sel = $('task-assignee') as HTMLSelectElement;
    const v = sel.value;
    sel.innerHTML = `<option value="">(나중에 배정)</option>` + emps.map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))} · ${esc(e.title)}</option>`).join('');
    sel.value = v;
  }
  if (!changed('board', [s.tasks, emps.map((e) => [e.id, e.name])])) return;
  $('board').innerHTML = COLS.map(([state, label]) => {
    const tasks = s.tasks.filter((t) => t.state === state);
    return `<div class="col" data-state="${state}"><h3>${label} <span class="muted">${tasks.length}</span></h3>${tasks
      .map((t) => {
        const who = emps.find((e) => e.id === t.assignee);
        return `<div class="card" draggable="true" data-id="${t.id}">
          <div class="card-title">#${t.id} ${t.requireApproval ? `<span class="lock" title="승인 받기: 자동 모드여도 도구마다 매니저 승인">🔒</span> ` : ''}${esc(t.title)}</div>
          ${t.detail ? `<div class="card-detail">${esc(t.detail.slice(0, 140))}</div>` : ''}
          ${t.attachments?.length ? `<div class="card-att">📎 ${attachmentLinks(t.attachments)}</div>` : ''}
          ${t.result ? `<details><summary>보고</summary><div class="card-result">${esc(t.result)}</div></details>` : ''}
          <div class="row">
            <select data-act="assign"><option value="">${who ? esc(short(who.name)) : '배정…'}</option>${emps
              .map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))}</option>`)
              .join('')}</select>
            ${state === 'review' ? `<button data-act="done">완료</button>` : ''}
            <button data-act="del" title="삭제">✕</button>
          </div>
        </div>`;
      })
      .join('')}</div>`;
  }).join('');

  const board = $('board');
  board.querySelectorAll<HTMLElement>('.card').forEach((card) => {
    const id = Number(card.dataset.id);
    card.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/task-id', String(id));
      ev.dataTransfer!.effectAllowed = 'move';
    });
    card.querySelector<HTMLSelectElement>('select[data-act="assign"]')!.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      if (v) send({ t: 'assignTask', taskId: id, employeeId: v });
    });
    card.querySelector('button[data-act="done"]')?.addEventListener('click', () => send({ t: 'moveTask', taskId: id, state: 'done' }));
    card.querySelector('button[data-act="del"]')!.addEventListener('click', () => {
      if (confirm(`작업 #${id}을 삭제할까요?`)) send({ t: 'deleteTask', taskId: id });
    });
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
    : `<p class="muted">등록된 GPU 서버가 없습니다. <code>config/servers.example.yaml</code>을 <code>config/servers.local.yaml</code>로 복사해 채우고 백엔드를 재시작하세요.</p>`;
  const jobs = [...s.jobs]
    .reverse()
    .slice(0, 30)
    .map(
      (j) => `<tr class="job-${j.state}"><td>#${j.id}</td><td>${esc(j.name)}</td><td>${esc(j.server)}</td><td>${esc(j.submittedBy ?? '나')}</td>
      <td><span class="state">${j.state}</span></td><td class="muted">${ago(j.updatedAt)}</td>
      <td>${['pending', 'running', 'unknown'].includes(j.state) ? `<button data-cancel="${j.id}">취소</button>` : ''}</td></tr>`,
    )
    .join('');
  $('jobs').innerHTML = `
    <div class="row space"><h2>${ico('🖥️')}서버실</h2><button id="refresh-servers">새로고침</button></div>
    ${servers}
    <h2>${ico('📦')}원격 Job</h2>
    ${jobs ? `<table class="jobs"><thead><tr><th></th><th>이름</th><th>서버</th><th>제출</th><th>상태</th><th></th><th></th></tr></thead><tbody>${jobs}</tbody></table>` : '<p class="muted">아직 제출된 job이 없습니다.</p>'}`;
  $('refresh-servers').addEventListener('click', () => send({ t: 'refreshServers' }));
  $('jobs').querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm(`job #${b.dataset.cancel}을 취소할까요?`)) send({ t: 'cancelJob', jobId: Number(b.dataset.cancel) });
    }),
  );
}

let panelFor: string | null | undefined;

export function renderEmployeePanel(st: UIState, send: Send) {
  const box = $('employee');
  const e = st.snap.employees.find((x) => x.id === st.selected);
  if (!e) {
    if (panelFor !== `none:${st.view}`) {
      panelFor = `none:${st.view}`;
      box.innerHTML =
        st.view === 'console'
          ? `<p class="muted hint">직원 표에서 행을 클릭하거나 <kbd>1</kbd>–<kbd>${st.snap.employees.length}</kbd>, <kbd>j</kbd>/<kbd>k</kbd>로 선택하세요. 로그와 지시 입력이 여기에 표시됩니다.</p>`
          : `<p class="muted hint">사무실에서 직원을 클릭하거나 숫자키 <kbd>1</kbd>–<kbd>${st.snap.employees.length}</kbd>를 누르세요. 작업 카드를 직원에게 끌어다 놓으면 바로 배정됩니다.</p>`;
    }
    return;
  }
  if (panelFor !== e.id + e.name) {
    panelFor = e.id + e.name;
    keys.delete('emp-head');
    keys.delete('emp-log');
    box.innerHTML = `
      <div id="emp-head"></div>
      <div id="emp-log" class="log"></div>
      <form id="emp-form" class="instruct">
        <textarea id="emp-input" rows="2" placeholder="${esc(short(e.name))}에게 지시하기… (Enter 전송, Shift+Enter 줄바꿈, 파일은 끌어다 놓기)"></textarea>
        <div id="emp-chips" class="att-chips" hidden></div>
        <div class="row">
          <button class="primary" type="submit">지시</button>
          <button type="button" id="emp-attach" class="icon-btn attach-btn" title="파일 첨부">📎</button>
          <button type="button" id="emp-stop">중지</button>
          <button type="button" id="emp-reset" title="대화 맥락을 비우고 새 세션으로 시작">새 세션</button>
        </div>
      </form>`;
    const input = $('emp-input') as HTMLTextAreaElement;
    const att = bindAttach($('emp-form'), $('emp-attach'), $('emp-chips'));
    const submit = () => {
      const text = input.value.trim();
      if (att.busy()) return void alert('첨부 파일을 올리는 중입니다. 잠시 후 다시 보내 주세요.');
      const attachmentIds = att.take();
      if (!text && !attachmentIds.length) return;
      send({ t: 'instruct', employeeId: e.id, text, attachmentIds });
      input.value = '';
    };
    $('emp-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        submit();
      }
    });
    $('emp-stop').addEventListener('click', () => send({ t: 'stop', employeeId: e.id }));
    $('emp-reset').addEventListener('click', () => {
      if (confirm('대화 맥락을 비우고 새 세션으로 시작할까요?')) send({ t: 'resetSession', employeeId: e.id });
    });
  }
  const prov = providerOf(st, e);
  if (changed('emp-head', [e, st.view, st.snap.employees.map((x) => x.costUsd), prov, st.snap.hosts])) {
    $('emp-head').innerHTML = `
      <div class="emp-title"><span class="swatch" style="background:${esc(e.sprite.shirt)}"></span>
        <b>${esc(e.name)}</b> <button type="button" id="emp-rename" class="icon-btn" title="이름 바꾸기">✏️</button> <span class="muted">${esc(e.title)}</span>
        <span class="status s-${e.status}">${STATUS_KO[e.status] ?? e.status}</span>
        <button type="button" id="emp-perm" class="perm-btn perm-${e.permission}" title="${
          e.permission === 'auto'
            ? '🤖 자동 모드: 분류기가 안전하다고 본 도구는 바로 실행하고, 애매한 것만 승인 요청. 클릭하면 승인 모드로 (다음 지시부터 적용)'
            : '✋ 승인 모드: 자동 허용 목록 밖의 도구는 모두 승인 요청. 클릭하면 자동 모드로 (다음 지시부터 적용)'
        }">${st.view === 'console' ? (e.permission === 'auto' ? '[자동]' : '[승인]') : e.permission === 'auto' ? '🤖 자동' : '✋ 승인'}</button></div>
      <div class="muted small">${esc(st.view === 'console' ? plain(e.activity) : e.activity)}</div>
      ${e.hostId ? `<div class="small emp-prov">${hostBadge(st, e, st.view === 'console')}</div>` : ''}
      ${
        e.provider
          ? `<div class="small emp-prov">${providerBadge(st, e, st.view === 'console')}${
              prov?.models.length
                ? ` <select id="emp-model" title="이 provider의 모든 직원이 쓸 모델">${prov.models
                    .map((m) => `<option value="${esc(m)}"${m === prov.model ? ' selected' : ''}>${esc(m)}</option>`)
                    .join('')}${prov.models.includes(prov.model) ? '' : `<option value="${esc(prov.model)}" selected disabled>${esc(prov.model)} (미설치)</option>`}</select>`
                : ''
            }</div>`
          : ''
      }
      <div class="muted small">${ico('📁')}${esc(e.cwd || '(아직 작업 전)')} · <span title="${
        e.live ? '세션이 열려 있어 다음 지시는 바로 시작합니다. 일하는 중에 보낸 지시도 즉시 전달됩니다.' : '세션이 닫혀 있습니다. 다음 지시 때 대화를 이어서 다시 엽니다 (첫 응답만 느림).'
      }">${e.live ? '🟢 세션 열림' : '⚪ 세션 대기'}</span> ${e.sessionId ? esc(e.sessionId.slice(0, 8)) : '새로 시작'} · ${e.provider ? '구독 사용 안 함' : `사무실 사용 비중 ${usageShare(st, e.costUsd)}`}</div>`;
    document.getElementById('emp-model')?.addEventListener('change', (ev) => {
      if (prov) send({ t: 'setProviderModel', providerId: prov.id, model: (ev.target as HTMLSelectElement).value });
    });
    $('emp-perm').addEventListener('click', () => send({ t: 'setPermission', employeeId: e.id, mode: e.permission === 'auto' ? 'ask' : 'auto' }));
    $('emp-rename').addEventListener('click', () => {
      const nick = prompt('새 이름 (비우면 원래 이름으로)', short(e.name));
      if (nick !== null) send({ t: 'renameEmployee', employeeId: e.id, nick });
    });
  }
  const lines = st.logs.get(e.id) ?? [];
  if (changed('emp-log', [e.id, lines.length, lines[lines.length - 1]?.ts])) {
    const log = $('emp-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = lines
      .map(
        (l) =>
          `<div class="line k-${l.kind}"><span class="ts">${new Date(l.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span><span class="txt">${esc(l.text)}</span></div>`,
      )
      .join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

export function bindNewTaskForm(send: Send) {
  const form = $('task-form') as HTMLFormElement;
  const att = bindAttach(form, $('task-attach'), $('task-chips'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = ($('task-title') as HTMLInputElement).value.trim();
    if (!title) return;
    if (att.busy()) return void alert('첨부 파일을 올리는 중입니다. 잠시 후 다시 눌러 주세요.');
    const detail = ($('task-detail') as HTMLTextAreaElement).value;
    const assignee = ($('task-assignee') as HTMLSelectElement).value || null;
    const requireApproval = ($('task-lock') as HTMLInputElement).checked;
    send({ t: 'createTask', title, detail, assignee, requireApproval, attachmentIds: att.take() });
    form.reset();
  });
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** Human-readable Korean for common cron shapes; falls back to the raw expression. */
export function describeCron(expr: string): string {
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!/^\d+$/.test(mi ?? '') || !/^\d+$/.test(h ?? '') || dom !== '*' || mon !== '*') return expr;
  const time = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  if (dow === '*') return `매일 ${time}`;
  if (dow === '1-5') return `평일 ${time}`;
  if (dow === '0,6' || dow === '6,0') return `주말 ${time}`;
  if (/^\d$/.test(dow)) return `매주 ${DOW[Number(dow) % 7]}요일 ${time}`;
  return expr;
}

const when = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** Routine form state survives re-renders: null = closed, '' = new, otherwise the id being edited. */
let routineEdit: string | null = null;

export function renderRoutines(st: UIState, send: Send) {
  const s = st.snap;
  const box = $('routines');
  if (!box.querySelector('#routine-list')) {
    box.innerHTML = `<div class="row space"><h2>${ico('⏰')}루틴</h2><button data-act="new" title="새 루틴 등록">+ 새 루틴</button></div>
      <div id="routine-form"></div>
      <div id="routine-list"></div>
      <p class="muted small">백엔드가 켜져 있을 때만 실행됩니다. 여기서 추가·수정하거나 비서에게 말로 맡길 수 있습니다. <code>config/routines.yaml</code>은 처음 실행할 때만 불러옵니다.</p>`;
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
            ? `<div class="small bad">${ico('🧩')}office:${esc(r.skill)} — 스킬 파일이 없습니다</div>`
            : `<div class="small">${ico('🧩')}<code>office:${esc(sk.name)}</code> <span class="muted">${esc(sk.description)}</span>
                ${sk.approved ? (sk.allow.length ? `<span class="muted"> · 자동 허용 ${sk.allow.length}개</span>` : '') : `<button data-act="approve-skill" data-skill="${esc(sk.name)}" class="warn-btn">⚠️ 재승인 필요</button>`}</div>`;
        return `<div class="routine ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
        <div class="row space">
          <div><b>${esc(r.name)}</b> <span class="muted small">${esc(describeCron(r.schedule))} · ${esc(who ? short(who.name) : r.employee)}</span></div>
          <div class="row">
            <label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}/> 켜짐</label>
            <button data-act="run">지금 실행</button>
            <button data-act="edit">수정</button>
            <button data-act="delete" class="danger">삭제</button>
          </div>
        </div>
        ${skillLine}
        <div class="muted small">다음 ${esc(r.enabled ? when(r.nextRun) : '꺼짐')} · 마지막 ${esc(when(r.lastRun))}</div>
      </div>`;
      })
      .join('') || '<p class="muted">등록된 루틴이 없습니다. <b>+ 새 루틴</b>으로 추가하세요.</p>';
  list.querySelectorAll<HTMLElement>('.routine').forEach((el) => {
    const id = el.dataset.id!;
    const r = s.routines.find((x) => x.id === id)!;
    el.querySelector('button[data-act="run"]')!.addEventListener('click', () => send({ t: 'runRoutine', id }));
    el.querySelector('button[data-act="edit"]')!.addEventListener('click', () => {
      routineEdit = id;
      renderRoutineForm(st, send);
    });
    el.querySelector('button[data-act="delete"]')!.addEventListener('click', () => {
      if (confirm(`루틴 "${r.name}"을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) {
        if (routineEdit === id) routineEdit = null;
        send({ t: 'deleteRoutine', id });
      }
    });
    el.querySelector<HTMLButtonElement>('button[data-act="approve-skill"]')?.addEventListener('click', (ev) => {
      const name = (ev.currentTarget as HTMLElement).dataset.skill!;
      const sk = s.skills.find((k) => k.name === name);
      const rules = sk?.allow.length ? `예약 실행에서 자동 허용될 도구:\n- ${sk.allow.join('\n- ')}` : '자동 허용 도구 없음';
      if (confirm(`스킬 office:${name}의 현재 파일 내용을 승인할까요?\n(workspaces/office-skills/skills/${name}/SKILL.md)\n\n${rules}`)) send({ t: 'approveSkill', name });
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
      <b>${editing ? `루틴 수정: ${esc(editing.name)}` : '새 루틴'}</b>
      <input name="name" placeholder="이름 (예: 점심 전 job 점검)" value="${esc(r.name)}" autocomplete="off" required />
      <div class="row">
        <input name="schedule" placeholder="분 시 일 월 요일" value="${esc(r.schedule)}" autocomplete="off" required />
        <select name="employee">${emps.map((e) => `<option value="${esc(e.id)}" ${e.id === r.employee ? 'selected' : ''}>${esc(short(e.name))} · ${esc(e.title)}</option>`).join('')}</select>
      </div>
      <div class="muted small" data-preview></div>
      <select name="skill">
        <option value="">(스킬 없음 — 지시문 직접 입력)</option>
        ${s.skills.map((k) => `<option value="${esc(k.name)}" ${k.name === r.skill ? 'selected' : ''}>🧩 office:${esc(k.name)} — ${esc(k.description)}</option>`).join('')}
      </select>
      <textarea name="prompt" rows="4">${esc(r.prompt)}</textarea>
      <div class="muted small">스킬은 비서에게 "○○ 루틴 만들고 싶어"라고 말하면 대화로 정리해서 만들어 줍니다.</div>
      <div class="row"><button class="primary" type="submit">${editing ? '저장' : '등록'}</button><button type="button" data-act="cancel">취소</button></div>
    </form>`;
  const form = box.querySelector('form')!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const preview = form.querySelector<HTMLElement>('[data-preview]')!;
  const upd = () => {
    const v = field('schedule').value.trim();
    const d = describeCron(v);
    preview.textContent = v.split(/\s+/).length !== 5 ? 'cron 5필드: 분 시 일 월 요일 (요일 0=일 … 6=토, 1-5=평일)' : d !== v ? `→ ${d}` : '분 시 일 월 요일 (요일 0=일 … 6=토)';
  };
  field('schedule').addEventListener('input', upd);
  upd();
  const promptEl = form.elements.namedItem('prompt') as HTMLTextAreaElement;
  const updSkill = () => {
    const hasSkill = !!field('skill').value;
    promptEl.placeholder = hasSkill ? '추가 메모 (선택) — 스킬에 덧붙여 보낼 말' : '정해진 시간마다 직원에게 보낼 지시';
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
      alert('스킬을 고르거나 지시문을 입력하세요.');
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
    return confirm(
      `비서가 스킬 office:${inp.name}을(를) 저장하려고 합니다.\n이 스킬을 실행하는 루틴에서는 아래 도구가 승인 없이 실행됩니다:\n\n- ${inp.allow.join('\n- ')}\n\n승인할까요?`,
    );
  }
  if (a.toolName !== 'mcp__office__delete_routine') return true;
  const id = String((a.input as Record<string, unknown>).id ?? '');
  const r = snap.routines.find((x) => x.id === id);
  return confirm(`비서가 루틴 "${r?.name ?? id}"을(를) 삭제하려고 합니다.\n삭제하면 되돌릴 수 없습니다. 승인할까요?`);
}
