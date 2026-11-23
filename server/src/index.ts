import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg, Snapshot } from '../../shared/protocol.ts';
import { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import { ServerRegistry } from './compute/registry.ts';
import { ROOT, loadOffice, loadRoles, loadRoutines, loadServers } from './config.ts';
import { Store } from './db.ts';
import { PermissionBroker } from './permissions/broker.ts';
import { RoutineScheduler } from './routines.ts';

const office = loadOffice();
const roles = loadRoles();
const store = new Store();
const broker = new PermissionBroker();
const registry = new ServerRegistry(loadServers(), store);
const agents = new AgentManager(office, roles, store, broker, registry);

function assignTask(taskId: number, employeeId: string) {
  if (!agents.has(employeeId)) return;
  const t = store.updateTask(taskId, { assignee: employeeId, state: 'doing' });
  if (!t) return;
  bus.send({ t: 'task', data: t });
  agents.instruct(employeeId, taskPrompt(t.id), t.id);
}

function createTask(title: string, detail: string, assignee: string | null) {
  const t = store.createTask(title.trim() || '(제목 없음)', detail ?? '', null);
  bus.send({ t: 'task', data: t });
  if (assignee) assignTask(t.id, assignee);
  return store.getTask(t.id)!;
}

const routines = new RoutineScheduler(
  loadRoutines(),
  store,
  (employeeId, prompt, name) => {
    bus.send({ t: 'notice', level: 'info', text: `⏰ 루틴 시작: ${name}` });
    agents.instruct(employeeId, prompt);
  },
  (id) => agents.has(id),
);

agents.officeApi = {
  employees: () => agents.views(),
  tasks: () => store.listTasks(),
  jobs: () => store.listJobs(),
  servers: () => registry.list(),
  routines: () => routines.list(),
  logsSince: (ts) => store.logsSince(ts),
  createTask,
};

function snapshot(): Snapshot {
  return {
    employees: agents.views(),
    tasks: store.listTasks(),
    approvals: broker.list(),
    jobs: store.listJobs(),
    servers: registry.list(),
    routines: routines.list(),
    running: agents.runningCount(),
    maxConcurrent: office.maxConcurrent,
  };
}

function taskPrompt(id: number): string {
  const t = store.getTask(id)!;
  return `매니저가 작업 #${t.id}을(를) 배정했습니다.\n\n제목: ${t.title}\n\n${t.detail || '(세부 설명 없음)'}\n\n작업을 마치면 산출물 위치와 요약을 보고하세요.`;
}

// When a remote job ends, tell whoever submitted it so they can follow up.
registry.onJobFinished((job) => {
  bus.send({ t: 'notice', level: job.state === 'completed' ? 'info' : 'warn', text: `Job #${job.id} ${job.name} @${job.server}: ${job.state}` });
  if (job.submittedBy && agents.has(job.submittedBy)) {
    agents.instruct(
      job.submittedBy,
      `[자동 알림] 원격 job #${job.id} (${job.name}, ${job.server})이(가) '${job.state}' 상태로 끝났습니다. mcp__lab__tail_log 로 로그를 확인하고 결과를 짧게 보고하세요. 다음 단계가 명확하지 않으면 제안만 하세요.`,
    );
  }
});

function handle(msg: ClientMsg, ws: WebSocket) {
  const reply = (m: ServerMsg) => ws.send(JSON.stringify(m));
  switch (msg.t) {
    case 'createTask':
      createTask(msg.title, msg.detail, msg.assignee ?? null);
      break;
    case 'assignTask':
      assignTask(msg.taskId, msg.employeeId);
      break;
    case 'moveTask': {
      const t = store.updateTask(msg.taskId, { state: msg.state });
      if (t) bus.send({ t: 'task', data: t });
      break;
    }
    case 'deleteTask':
      store.deleteTask(msg.taskId);
      bus.send({ t: 'taskDeleted', id: msg.taskId });
      break;
    case 'instruct':
      if (msg.text.trim()) agents.instruct(msg.employeeId, msg.text.trim());
      break;
    case 'stop':
      agents.stop(msg.employeeId);
      break;
    case 'resetSession':
      agents.resetSession(msg.employeeId);
      break;
    case 'approve':
      broker.answer(msg.id, msg.allow, msg.message);
      break;
    case 'getLogs':
      reply({ t: 'logs', employeeId: msg.employeeId, lines: store.recentLogs(msg.employeeId) });
      break;
    case 'cancelJob':
      registry.cancel(msg.jobId).catch((e) => reply({ t: 'notice', level: 'error', text: String(e.message) }));
      break;
    case 'refreshServers':
      void registry.refreshServers();
      break;
    case 'runRoutine':
      routines.run(msg.id);
      break;
    case 'toggleRoutine':
      routines.setEnabled(msg.id, msg.enabled);
      break;
  }
}

// ---- static files (production build) + websocket
const DIST = resolve(ROOT, 'dist');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST) || !existsSync(p) || statSync(p).isDirectory()) p = resolve(DIST, 'index.html');
  if (!existsSync(p)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('개발 모드: http://localhost:5173 을 여세요 (npm run dev). 배포 모드: npm run build 후 다시 실행.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});

const wss = new WebSocketServer({ server: http, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'snapshot', data: snapshot() } satisfies ServerMsg));
  ws.on('message', (raw) => {
    try {
      handle(JSON.parse(String(raw)) as ClientMsg, ws);
    } catch (e) {
      ws.send(JSON.stringify({ t: 'notice', level: 'error', text: String((e as Error).message) } satisfies ServerMsg));
    }
  });
});
bus.on('msg', (m: ServerMsg) => {
  const s = JSON.stringify(m);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(s);
});

http.listen(office.port, '127.0.0.1', () => {
  console.log(`🧬 8-bit Lab backend: http://127.0.0.1:${office.port}  (employees: ${roles.length}, servers: ${registry.list().length}, maxConcurrent: ${office.maxConcurrent})`);
  registry.start();
  routines.start();
  console.log(`⏰ routines: ${routines.list().map((r) => `${r.name}(${r.schedule}${r.enabled ? '' : ', off'})`).join(', ') || '(none)'}`);
});
