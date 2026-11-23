import './style.css';
import { FIGURE_DEFAULT_NAMES, type ClientMsg, type ServerMsg, type Snapshot } from '../../shared/protocol.ts';
import { OfficeScene } from './game/office.ts';
import { bindConsoleTaskForm, renderFeed, renderStaffTable, renderTaskTable, renderUsagePanel, sortedEmployees } from './ui/console.ts';
import {
  type ViewMode,
  type UIState,
  bindNewTaskForm,
  confirmApprove,
  renderApprovals,
  renderBoard,
  renderEmployeePanel,
  renderHeader,
  renderJobs,
  renderRoutines,
} from './ui/panels.ts';
import { applyView, initialView } from './ui/view.ts';
import { renderReportFeed } from './ui/feed.ts';
import { renderTodos, todosUpdated } from './ui/todos.ts';
import { initReports, onReportContent, renderReports, unreadReports } from './ui/reports.ts';

const FEED_MAX = 300;

const state: UIState = {
  snap: { employees: [], tasks: [], approvals: [], jobs: [], servers: [], routines: [], skills: [], reports: [], feed: [], todos: { enabled: false, date: '', relPath: '', exists: false, mtime: 0, vaultName: '', canCreate: false, sections: [], error: '' }, recentLogs: [], usage: { available: false, plan: null, rows: [], fetchedAt: null, note: '' }, running: 0, maxConcurrent: 0, figureNames: { ...FIGURE_DEFAULT_NAMES }, providers: [] } as Snapshot,
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
scene.onRenameFigure = (key, name) => send({ t: 'renameFigure', key, name });

function setView(v: ViewMode) {
  state.view = v;
  applyView(v);
  scene.paused = v !== 'game';
  renderAll();
}

function renderAll() {
  renderHeader(state, send);
  const unread = unreadReports(state);
  const badge = document.getElementById('reports-unread')!;
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
  if (state.view === 'reports') {
    renderReports(state);
    return;
  }
  // shared panels (live in whichever view is active)
  renderTodos(state, send);
  renderReportFeed(state);
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
      scene.setFigureNames(m.data.figureNames ?? FIGURE_DEFAULT_NAMES);
      scene.tasks = m.data.tasks;
      if (state.selected) send({ t: 'getLogs', employeeId: state.selected });
      break;
    case 'employee': {
      const i = s.employees.findIndex((e) => e.id === m.data.id);
      const prev = s.employees[i];
      if (i >= 0) s.employees[i] = m.data;
      else s.employees.push(m.data);
      if (!prev || prev.status !== m.data.status || prev.activity !== m.data.activity) state.empUpdated.set(m.data.id, Date.now());
      // header shows subscription runs only; employees on a local provider don't count against maxConcurrent
      s.running = s.employees.filter((e) => !e.provider && !['idle', 'queued', 'done', 'error'].includes(e.status)).length;
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
    case 'provider': {
      s.providers ??= [];
      const i = s.providers.findIndex((p) => p.id === m.data.id);
      if (i >= 0) s.providers[i] = m.data;
      else s.providers.push(m.data);
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
    case 'figureName':
      s.figureNames = { ...s.figureNames, [m.key]: m.name };
      scene.setFigureNames({ [m.key]: m.name });
      break;
    case 'routine': {
      const i = s.routines.findIndex((r) => r.id === m.data.id);
      if (i >= 0) s.routines[i] = m.data;
      else s.routines.push(m.data);
      break;
    }
    case 'skills':
      s.skills = m.data;
      break;
    case 'reports':
      s.reports = m.data;
      break;
    case 'feed': {
      const i = s.feed.findIndex((f) => f.id === m.data.id);
      if (i >= 0) s.feed.splice(i, 1);
      s.feed.push(m.data); // an updated report moves back to the bottom, like a new message
      if (s.feed.length > 200) s.feed.splice(0, s.feed.length - 200);
      if (m.data.kind === 'report' && i < 0) notify('📄 새 보고서', m.data.title);
      break;
    }
    case 'todos':
      s.todos = m.data;
      todosUpdated(m.data);
      break;
    case 'reportContent':
      onReportContent(m.path, m.content, m.mtime);
      break;
    case 'routineDeleted':
      s.routines = s.routines.filter((r) => r.id !== m.id);
      break;
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

window.addEventListener('office-toast', (ev) => {
  const d = (ev as CustomEvent<{ text: string; level?: 'info' | 'warn' | 'error' }>).detail;
  toast(d.text, d.level ?? 'info');
});
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
    setView(state.view === 'game' ? 'console' : 'game'); // reports tab is reached by its button
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
    if (ev.key === 'a' && !confirmApprove(first, state.snap)) return;
    send({ t: 'approve', id: first.id, allow: ev.key === 'a' });
    toast(`${ev.key === 'a' ? '승인' : '거부'}: ${first.toolName}`, ev.key === 'a' ? 'info' : 'warn');
  }
});

initReports(send, () => setView('reports'));
bindNewTaskForm(send);
bindConsoleTaskForm(send);
setView(state.view);
connect();
// keep relative times ("n분 후 초기화", "갱신") fresh
setInterval(renderAll, 30_000);
