import type { ClientMsg, LogLine, Snapshot, TaskState } from '../../../shared/protocol.ts';

export interface UIState {
  snap: Snapshot;
  selected: string | null;
  logs: Map<string, LogLine[]>;
  connected: boolean;
}

type Send = (m: ClientMsg) => void;

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (name: string) => name.replace(/^.*"(.*)".*$/, '$1');
const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

// Re-render a region only when its data changed (keeps focus / open dropdowns intact).
const keys = new Map<string, string>();
function changed(region: string, data: unknown): boolean {
  const k = JSON.stringify(data);
  if (keys.get(region) === k) return false;
  keys.set(region, k);
  return true;
}

const STATUS_KO: Record<string, string> = {
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

export function renderHeader(st: UIState) {
  const s = st.snap;
  const busy = s.employees.filter((e) => !['idle', 'done', 'error', 'queued'].includes(e.status)).length;
  const cost = s.employees.reduce((a, e) => a + e.costUsd, 0);
  const data = [st.connected, busy, s.maxConcurrent, s.approvals.length, cost.toFixed(2), typeof Notification !== 'undefined' ? Notification.permission : 'na'];
  if (!changed('header', data)) return;
  $('stats').innerHTML = `
    <span class="pill ${st.connected ? 'ok' : 'bad'}">${st.connected ? '● 연결됨' : '○ 연결 끊김'}</span>
    <span class="pill">근무 중 <b>${busy}</b>/${s.maxConcurrent}</span>
    <span class="pill ${s.approvals.length ? 'warn' : ''}">승인 대기 <b>${s.approvals.length}</b></span>
    <span class="pill" title="Agent SDK가 보고한 추정 비용 (구독 사용량 참고용)">누적 사용량 ≈ $${cost.toFixed(2)}</span>`;
  const nb = document.getElementById('notify-btn');
  if (nb) nb.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

export function renderApprovals(st: UIState, send: Send) {
  const s = st.snap;
  if (!changed('approvals', [s.approvals, s.employees.map((e) => e.name)])) return;
  const box = $('approvals');
  box.hidden = s.approvals.length === 0;
  box.innerHTML =
    `<h2>✋ 승인 요청</h2>` +
    s.approvals
      .map((a) => {
        const who = s.employees.find((e) => e.id === a.employeeId);
        const inp = a.input as Record<string, unknown>;
        const main = inp.command ?? inp.file_path ?? inp.url ?? inp.query ?? '';
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
      send({ t: 'approve', id, allow: b.dataset.act === 'allow' });
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
          <div class="card-title">#${t.id} ${esc(t.title)}</div>
          ${t.detail ? `<div class="card-detail">${esc(t.detail.slice(0, 140))}</div>` : ''}
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
    <div class="row space"><h2>🖥️ 서버실</h2><button id="refresh-servers">새로고침</button></div>
    ${servers}
    <h2>📦 원격 Job</h2>
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
    if (panelFor !== null) {
      panelFor = null;
      box.innerHTML = `<p class="muted hint">사무실에서 직원을 클릭하거나 숫자키 <kbd>1</kbd>–<kbd>5</kbd>를 누르세요. 작업 카드를 직원에게 끌어다 놓으면 바로 배정됩니다.</p>`;
    }
    return;
  }
  if (panelFor !== e.id) {
    panelFor = e.id;
    keys.delete('emp-head');
    keys.delete('emp-log');
    box.innerHTML = `
      <div id="emp-head"></div>
      <div id="emp-log" class="log"></div>
      <form id="emp-form" class="instruct">
        <textarea id="emp-input" rows="2" placeholder="${esc(short(e.name))}에게 지시하기… (Enter 전송, Shift+Enter 줄바꿈)"></textarea>
        <div class="row">
          <button class="primary" type="submit">지시</button>
          <button type="button" id="emp-stop">중지</button>
          <button type="button" id="emp-reset" title="대화 맥락을 비우고 새 세션으로 시작">새 세션</button>
        </div>
      </form>`;
    const input = $('emp-input') as HTMLTextAreaElement;
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      send({ t: 'instruct', employeeId: e.id, text });
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
  if (changed('emp-head', e)) {
    $('emp-head').innerHTML = `
      <div class="emp-title"><span class="swatch" style="background:${esc(e.sprite.shirt)}"></span>
        <b>${esc(e.name)}</b> <span class="muted">${esc(e.title)}</span>
        <span class="status s-${e.status}">${STATUS_KO[e.status] ?? e.status}</span></div>
      <div class="muted small">${esc(e.activity)}</div>
      <div class="muted small">📁 ${esc(e.cwd || '(아직 작업 전)')} · 세션 ${e.sessionId ? esc(e.sessionId.slice(0, 8)) : '새로 시작'} · ≈$${e.costUsd.toFixed(2)}</div>`;
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
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = ($('task-title') as HTMLInputElement).value.trim();
    if (!title) return;
    const detail = ($('task-detail') as HTMLTextAreaElement).value;
    const assignee = ($('task-assignee') as HTMLSelectElement).value || null;
    send({ t: 'createTask', title, detail, assignee });
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

export function renderRoutines(st: UIState, send: Send) {
  const s = st.snap;
  if (!changed('routines', [s.routines, s.employees.map((e) => [e.id, e.name])])) return;
  const box = $('routines');
  const rows = s.routines
    .map((r) => {
      const who = s.employees.find((e) => e.id === r.employee);
      return `<div class="routine ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
        <div class="row space">
          <div><b>${esc(r.name)}</b> <span class="muted small">${esc(describeCron(r.schedule))} · ${esc(who ? short(who.name) : r.employee)}</span></div>
          <div class="row">
            <label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}/> 켜짐</label>
            <button data-act="run">지금 실행</button>
          </div>
        </div>
        <div class="muted small">다음 ${esc(r.enabled ? when(r.nextRun) : '꺼짐')} · 마지막 ${esc(when(r.lastRun))}</div>
      </div>`;
    })
    .join('');
  box.innerHTML = `<h2>⏰ 루틴</h2>${rows || '<p class="muted">등록된 루틴이 없습니다. <code>config/routines.yaml</code>에 추가하세요.</p>'}
    <p class="muted small">백엔드가 켜져 있을 때만 실행됩니다. 일정 변경은 <code>config/routines.yaml</code> 수정 후 재시작.</p>`;
  box.querySelectorAll<HTMLElement>('.routine').forEach((el) => {
    const id = el.dataset.id!;
    el.querySelector('button[data-act="run"]')!.addEventListener('click', () => send({ t: 'runRoutine', id }));
    el.querySelector<HTMLInputElement>('input[data-act="toggle"]')!.addEventListener('change', (ev) =>
      send({ t: 'toggleRoutine', id, enabled: (ev.target as HTMLInputElement).checked }),
    );
  });
}
