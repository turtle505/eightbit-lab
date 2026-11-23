import './style.css';
import type { ClientMsg, ServerMsg, Snapshot } from '../../shared/protocol.ts';
import { OfficeScene } from './game/office.ts';
import { bindConsoleTaskForm, renderFeed, renderStaffTable, renderTaskTable, renderUsagePanel, sortedEmployees } from './ui/console.ts';
import {
  type ViewMode,
  type UIState,
  bindNewTaskForm,
  renderApprovals,
  renderBoard,
  renderEmployeePanel,
  renderHeader,
  renderJobs,
  renderRoutines,
} from './ui/panels.ts';
import { applyView, initialView } from './ui/view.ts';

const FEED_MAX = 300;

const state: UIState = {
  snap: { employees: [], tasks: [], approvals: [], jobs: [], servers: [], routines: [], recentLogs: [], usage: { available: false, plan: null, rows: [], fetchedAt: null, note: '' }, running: 0, maxConcurrent: 0 } as Snapshot,
  selected: null,
  logs: new Map(),
  connected: false,
  view: initialView(),
  feed: [],
  empUpdated: new Map(),
};

let ws: WebSocket;
export function send(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

const scene = new OfficeScene(document.getElementById('office')!, document.getElementById('overlay')!);

/** Select an employee (both views share the selection). */
function select(id: string | null) {
  state.selected = id;
  scene.selected = id;
  if (id) send({ t: 'getLogs', employeeId: id });
  renderAll();
}
scene.onSelect = select;
scene.onDropTask = (taskId, employeeId) => send({ t: 'assignTask', taskId, employeeId });

function setView(v: ViewMode) {
  state.view = v;
  applyView(v);
  scene.paused = v !== 'game';
  renderAll();
}

function renderAll() {
  renderHeader(state, send);
  // shared panels (live in whichever view is active)
  renderApprovals(state, send);
  renderEmployeePanel(state, send);
  renderRoutines(state, send);
  renderJobs(state, send);
  if (state.view === 'game') {
    renderBoard(state, send);
  } else {
    renderStaffTable(state, send, select);
    renderTaskTable(state, send);
    renderFeed(state);
    renderUsagePanel(state, send);
  }
}

function toast(text: string, level: 'info' | 'warn' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  document.getElementById('toasts')!.append(el);
  setTimeout(() => el.remove(), 7000);
}

function notify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
  } catch {
    /* ignore */
  }
}

function onMsg(m: ServerMsg) {
  const s = state.snap;
  switch (m.t) {
    case 'snapshot':
      state.snap = m.data;
      state.feed = [...(m.data.recentLogs ?? [])];
      scene.setEmployees(m.data.employees);
      scene.setServers(m.data.servers);
      scene.tasks = m.data.tasks;
      if (state.selected) send({ t: 'getLogs', employeeId: state.selected });
      break;
    case 'employee': {
      const i = s.employees.findIndex((e) => e.id === m.data.id);
      const prev = s.employees[i];
      if (i >= 0) s.employees[i] = m.data;
      else s.employees.push(m.data);
      if (!prev || prev.status !== m.data.status || prev.activity !== m.data.activity) state.empUpdated.set(m.data.id, Date.now());
      s.running = s.employees.filter((e) => !['idle', 'queued', 'done', 'error'].includes(e.status)).length;
      scene.upsert(m.data);
      if (prev && prev.status !== 'done' && m.data.status === 'done') notify(`${m.data.name} 완료`, m.data.activity);
      break;
    }
    case 'task': {
      const i = s.tasks.findIndex((t) => t.id === m.data.id);
      if (i >= 0) s.tasks[i] = m.data;
      else s.tasks.push(m.data);
      scene.tasks = s.tasks;
      break;
    }
    case 'taskDeleted':
      s.tasks = s.tasks.filter((t) => t.id !== m.id);
      scene.tasks = s.tasks;
      break;
    case 'approval': {
      s.approvals.push(m.data);
      const who = s.employees.find((e) => e.id === m.data.employeeId)?.name ?? m.data.employeeId;
      notify('승인 요청', `${who}: ${m.data.toolName}`);
      break;
    }
    case 'approvalResolved':
      s.approvals = s.approvals.filter((a) => a.id !== m.id);
      break;
    case 'job': {
      const i = s.jobs.findIndex((j) => j.id === m.data.id);
      if (i >= 0) s.jobs[i] = m.data;
      else s.jobs.push(m.data);
      break;
    }
    case 'server': {
      const i = s.servers.findIndex((x) => x.name === m.data.name);
      if (i >= 0) s.servers[i] = m.data;
      else s.servers.push(m.data);
      scene.setServers(s.servers);
      break;
    }
    case 'usage':
      s.usage = m.data;
      break;
    case 'routine': {
      const i = s.routines.findIndex((r) => r.id === m.data.id);
      if (i >= 0) s.routines[i] = m.data;
      else s.routines.push(m.data);
      break;
    }
    case 'log': {
      state.feed.push(m.data);
      if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
      const arr = state.logs.get(m.data.employeeId);
      if (arr) {
        arr.push(m.data);
        if (arr.length > 500) arr.splice(0, arr.length - 500);
      }
      // game view only shows the selected employee's log; console also has the feed
      if (state.view === 'game' && m.data.employeeId !== state.selected) return;
      break;
    }
    case 'logs':
      state.logs.set(m.employeeId, m.lines);
      break;
    case 'notice':
      toast(m.text, m.level);
      notify('8-bit Lab', m.text);
      break;
  }
  renderAll();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    state.connected = true;
    renderAll();
  };
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => {
    state.connected = false;
    renderAll();
    setTimeout(connect, 1500);
  };
}

document.getElementById('notify-btn')?.addEventListener('click', () => {
  if ('Notification' in window) void Notification.requestPermission().then(() => renderAll());
});
document.querySelectorAll<HTMLButtonElement>('.view-toggle button').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view as ViewMode)),
);

window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if ((ev.target as HTMLElement).closest('input, textarea, select')) return;
  const emps = sortedEmployees(state);
  if (ev.key === '`') {
    ev.preventDefault();
    setView(state.view === 'game' ? 'console' : 'game');
    return;
  }
  const n = Number(ev.key);
  if (n >= 1 && n <= emps.length) return select(emps[n - 1].id);
  if (ev.key === 'Escape') return select(null);
  if (state.view !== 'console') return;

  // console-only shortcuts
  if (ev.key === 'j' || ev.key === 'k') {
    const i = emps.findIndex((e) => e.id === state.selected);
    const next = i < 0 ? 0 : (i + (ev.key === 'j' ? 1 : -1) + emps.length) % emps.length;
    return select(emps[next]?.id ?? null);
  }
  if (ev.key === '/') {
    ev.preventDefault();
    if (!state.selected && emps[0]) select(emps[0].id);
    document.getElementById('emp-input')?.focus();
    return;
  }
  const first = state.snap.approvals[0];
  if (first && (ev.key === 'a' || ev.key === 'd')) {
    send({ t: 'approve', id: first.id, allow: ev.key === 'a' });
    toast(`${ev.key === 'a' ? '승인' : '거부'}: ${first.toolName}`, ev.key === 'a' ? 'info' : 'warn');
  }
});

bindNewTaskForm(send);
bindConsoleTaskForm(send);
setView(state.view);
connect();
// keep relative times ("n분 후 초기화", "갱신") fresh
setInterval(renderAll, 30_000);
