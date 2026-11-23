import './style.css';
import type { ClientMsg, ServerMsg, Snapshot } from '../../shared/protocol.ts';
import { OfficeScene } from './game/office.ts';
import { bindNewTaskForm, renderApprovals, renderBoard, renderEmployeePanel, renderHeader, renderJobs, renderRoutines, type UIState } from './ui/panels.ts';

const state: UIState = {
  snap: { employees: [], tasks: [], approvals: [], jobs: [], servers: [], routines: [], running: 0, maxConcurrent: 0 } as Snapshot,
  selected: null,
  logs: new Map(),
  connected: false,
};

let ws: WebSocket;
export function send(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

const scene = new OfficeScene(document.getElementById('office')!, document.getElementById('overlay')!);
scene.onSelect = (id) => {
  state.selected = id;
  if (id) send({ t: 'getLogs', employeeId: id });
  renderAll();
};
scene.onDropTask = (taskId, employeeId) => send({ t: 'assignTask', taskId, employeeId });

function renderAll() {
  renderHeader(state);
  renderApprovals(state, send);
  renderBoard(state, send);
  renderJobs(state, send);
  renderRoutines(state, send);
  renderEmployeePanel(state, send);
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
    case 'routine': {
      const i = s.routines.findIndex((r) => r.id === m.data.id);
      if (i >= 0) s.routines[i] = m.data;
      else s.routines.push(m.data);
      break;
    }
    case 'log': {
      const arr = state.logs.get(m.data.employeeId);
      if (arr) {
        arr.push(m.data);
        if (arr.length > 500) arr.splice(0, arr.length - 500);
      }
      if (m.data.employeeId !== state.selected) return; // no re-render needed
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

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).closest('input, textarea')) return;
  const n = Number(ev.key);
  if (n >= 1 && n <= state.snap.employees.length) {
    const e = [...state.snap.employees].sort((a, b) => a.desk - b.desk)[n - 1];
    scene.selected = e.id;
    scene.onSelect(e.id);
  }
  if (ev.key === 'Escape') {
    scene.selected = null;
    scene.onSelect(null);
  }
});

bindNewTaskForm(send);
connect();
renderAll();
