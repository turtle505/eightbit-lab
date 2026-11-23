import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { FIGURE_DEFAULT_NAMES, FIGURE_MAX_LEN, type ClientMsg, type FigureKey, type ServerMsg, type Snapshot } from '../../shared/protocol.ts';
import { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import { ServerRegistry } from './compute/registry.ts';
import { ROOT, loadOffice, loadRoles, loadRoutines, loadServers } from './config.ts';
import { Store } from './db.ts';
import { PermissionBroker } from './permissions/broker.ts';
import { RoutineScheduler } from './routines.ts';
import { SkillLibrary } from './skills.ts';
import { ReportLibrary, reportRoots } from './reports.ts';
import { TodayNote } from './todos.ts';
import type { RunFinished } from './agents/manager.ts';
import type { FeedItem } from '../../shared/protocol.ts';
import { UsageMonitor } from './usage.ts';
import { ProviderHub } from './providers.ts';
import { AttachmentLibrary, MAX_ATTACHMENT_BYTES, attachmentBlock } from './attachments.ts';
import { allowedOrigin } from './origin.ts';
import { mkdirSync } from 'node:fs';

const office = loadOffice();
const roles = loadRoles();
const store = new Store();
const broker = new PermissionBroker();
const registry = new ServerRegistry(loadServers(), store);
const agents = new AgentManager(office, roles, store, broker, registry);
const skills = new SkillLibrary(resolve(office.workspaceRoot, 'office-skills'), store);
skills.ensure();
agents.pluginDirs = [skills.dir];
const attachments = new AttachmentLibrary(office.workspaceRoot, store);
mkdirSync(attachments.dir, { recursive: true });
agents.extraDirs = [attachments.dir];
const providers = new ProviderHub(office.providers, store);
agents.providers = providers;
for (const r of roles)
  if (r.provider && !providers.get(r.provider))
    console.warn(`⚠️ ${r.id}: provider '${r.provider}' 가 office(.local).yaml 의 providers 에 없습니다 — 이 직원은 실행할 수 없습니다`);
const sendSkills = () => bus.send({ t: 'skills', data: skills.list() });

// ---- report feed: finished runs + report files that appear or change
const pushFeed = (f: FeedItem) => bus.send({ t: 'feed', data: f });
bus.on('runFinished', (r: RunFinished) => {
  if (!r.text.trim() && r.ok) return;
  pushFeed(store.addFeed({ ts: Date.now(), kind: 'result', employeeId: r.employeeId, title: r.label, body: r.text || '(응답 없음 — 로그 확인)', path: null, ok: r.ok }));
});
const reports = new ReportLibrary(() =>
  reportRoots(office.workspaceRoot, office.reportDirs, (dir) => roles.find((ro) => ro.cwd && resolve(ROOT, ro.cwd) === dir)?.id ?? null),
);
reports.scan(); // baseline: files that already exist are not announced
const today = new TodayNote(office.obsidian);
today.poll();
function pollTodos() {
  const t = today.poll();
  if (t) bus.send({ t: 'todos', data: t });
}
const REPORT_MERGE_MS = 10 * 60_000;
const REPORT_EXCERPT = 4000;
function pollReports() {
  const { list, changed, any } = reports.changes();
  if (!any) return;
  bus.send({ t: 'reports', data: list });
  for (const f of changed) {
    let body = '';
    try {
      const c = reports.read(f.path).content;
      body = c.length > REPORT_EXCERPT ? c.slice(0, REPORT_EXCERPT) + '\n\n…' : c;
    } catch {
      continue;
    }
    const now = Date.now();
    const prev = store.lastFeedForPath(f.path, now - REPORT_MERGE_MS);
    if (prev) pushFeed(store.updateFeed(prev.id, { ts: now, title: f.title, body })!);
    else pushFeed(store.addFeed({ ts: now, kind: 'report', employeeId: f.employeeId, title: f.title, body, path: f.path, ok: true }));
  }
}
const usage = new UsageMonitor(ROOT);
// refresh subscription usage shortly after an employee finishes a run
bus.on('msg', (m: ServerMsg) => {
  if (m.t === 'employee' && (m.data.status === 'done' || m.data.status === 'error')) usage.poke();
});

function assignTask(taskId: number, employeeId: string) {
  if (!agents.has(employeeId)) return;
  const t = store.updateTask(taskId, { assignee: employeeId, state: 'doing' });
  if (!t) return;
  bus.send({ t: 'task', data: t });
  agents.instruct(employeeId, taskPrompt(t.id), t.id, { label: `${t.requireApproval ? '🔒' : '📋'} #${t.id} ${t.title}`, requireApproval: t.requireApproval });
}

function createTask(title: string, detail: string, assignee: string | null, createdBy: string | null = null, requireApproval = false, attachmentIds: number[] = []) {
  const created = store.createTask(title.trim() || '(제목 없음)', detail ?? '', null, createdBy, requireApproval);
  if (attachmentIds.length) store.bindAttachments(created.id, attachmentIds);
  const t = store.getTask(created.id)!;
  bus.send({ t: 'task', data: t });
  if (assignee) assignTask(t.id, assignee);
  return store.getTask(t.id)!;
}

const routines = new RoutineScheduler(
  loadRoutines(),
  store,
  (employeeId, prompt, name, skill) => {
    bus.send({ t: 'notice', level: 'info', text: `⏰ 루틴 시작: ${name}` });
    let extraAllow: string[] = [];
    if (skill) {
      const allow = skills.allowFor(skill);
      if (allow === null) bus.send({ t: 'notice', level: 'warn', text: `🧩 스킬 ${skill}이(가) 승인 후 바뀌었거나 승인되지 않아 자동 허용 없이 실행합니다. 루틴 패널에서 재승인하세요.` });
      else extraAllow = allow;
    }
    agents.instruct(employeeId, prompt, null, { extraAllow, label: `⏰ ${name}` });
  },
  (id) => agents.has(id),
  (name) => skills.has(name),
);

agents.officeApi = {
  employees: () => agents.views(),
  tasks: () => store.listTasks(),
  jobs: () => store.listJobs(),
  servers: () => registry.list(),
  routines: () => routines.list(),
  logsSince: (ts) => store.logsSince(ts),
  createTask,
  createRoutine: (input) => routines.create(input),
  updateRoutine: (id, patch) => routines.update(id, patch),
  deleteRoutine: (id) => routines.remove(id),
  skills: () => skills.list(),
  saveSkill: (name, description, body, allow) => {
    const v = skills.save(name, description, body, allow);
    sendSkills();
    return v;
  },
};

// professor / manager are decoration, not employees; their names live in employee_names under reserved keys
const figureName = (key: FigureKey) => store.getEmployeeName(`__${key}`) ?? FIGURE_DEFAULT_NAMES[key];
const figureNames = () => Object.fromEntries((Object.keys(FIGURE_DEFAULT_NAMES) as FigureKey[]).map((k) => [k, figureName(k)])) as Record<FigureKey, string>;

function snapshot(): Snapshot {
  return {
    employees: agents.views(),
    tasks: store.listTasks(),
    approvals: broker.list(),
    jobs: store.listJobs(),
    servers: registry.list(),
    routines: routines.list(),
    skills: skills.list(),
    reports: reports.list(),
    feed: store.recentFeed(100),
    todos: today.load(),
    recentLogs: store.logsSince(0, 200),
    usage: usage.view,
    running: agents.runningCount(),
    maxConcurrent: office.maxConcurrent,
    figureNames: figureNames(),
    providers: providers.views(),
  };
}

function taskPrompt(id: number): string {
  const t = store.getTask(id)!;
  return `매니저가 작업 #${t.id}을(를) 배정했습니다.\n\n제목: ${t.title}\n\n${t.detail || '(세부 설명 없음)'}${attachmentBlock(store.attachmentsForTask(t.id))}\n\n작업을 마치면 산출물 위치와 요약을 보고하세요.`;
}

// When a delegated task ends, hand the result back to the employee who delegated it (team lead / secretary).
bus.on('runFinished', (r: RunFinished) => {
  if (r.taskId == null) return;
  const t = store.getTask(r.taskId);
  const by = t?.createdBy;
  if (!t || !by || by === r.employeeId || !agents.has(by)) return;
  const who = agents.views().find((v) => v.id === r.employeeId)?.name ?? r.employeeId;
  const result = r.text.trim() ? (r.text.length > 1500 ? `${r.text.slice(0, 1500)}…(생략, 전체는 list_tasks)` : r.text) : '(응답 없음)';
  // the finished task is still 'doing' here (it moves to review right after this event)
  const open = store.listTasks().filter((o) => o.createdBy === by && o.id !== t.id && (o.state === 'todo' || o.state === 'doing'));
  const rest = open.length
    ? `아직 진행 중인 위임 작업: ${open.map((o) => `#${o.id} ${o.title} (${o.assignee ?? '미배정'})`).join(', ')}\n→ 이 결과를 짧게 기록만 하고 기다리세요. 이 결과가 있어야 시작할 수 있는 다음 단계가 계획에 있었다면 지금 배정하세요.`
    : '위임한 작업이 모두 끝났습니다.\n→ 이 결과로 시작해야 할 다음 단계가 계획에 남아 있으면 배정하고, 없으면 전체 결과를 종합해 매니저에게 보고하세요.';
  agents.instruct(
    by,
    `[자동 알림] 작업 #${t.id} "${t.title}" (담당 ${who})이(가) ${r.ok ? '끝났습니다' : '오류로 끝났습니다'}.\n\n결과:\n${result}\n\n${rest}`,
    null,
    { label: `📬 #${t.id} 결과 도착` },
  );
});

// When a remote job ends, tell whoever submitted it so they can follow up.
registry.onJobFinished((job) => {
  bus.send({ t: 'notice', level: job.state === 'completed' ? 'info' : 'warn', text: `Job #${job.id} ${job.name} @${job.server}: ${job.state}` });
  if (job.submittedBy && agents.has(job.submittedBy)) {
    agents.instruct(
      job.submittedBy,
      `[자동 알림] 원격 job #${job.id} (${job.name}, ${job.server})이(가) '${job.state}' 상태로 끝났습니다. mcp__lab__tail_log 로 로그를 확인하고 결과를 짧게 보고하세요. 다음 단계가 명확하지 않으면 제안만 하세요.`,
      null,
      { label: `🖥️ Job #${job.id} ${job.name} (${job.state})` },
    );
  }
});

function handle(msg: ClientMsg, ws: WebSocket) {
  const reply = (m: ServerMsg) => ws.send(JSON.stringify(m));
  switch (msg.t) {
    case 'createTask':
      createTask(msg.title, msg.detail, msg.assignee ?? null, null, !!msg.requireApproval, msg.attachmentIds ?? []);
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
    case 'instruct': {
      const rows = attachments.rows(msg.attachmentIds ?? []);
      if (!msg.text.trim() && !rows.length) break;
      store.markAttachmentsUsed(rows.map((r) => r.id));
      agents.instruct(msg.employeeId, (msg.text.trim() || '첨부 파일을 확인해 주세요.') + attachmentBlock(rows));
      break;
    }
    case 'stop':
      agents.stop(msg.employeeId);
      break;
    case 'resetSession':
      agents.resetSession(msg.employeeId);
      break;
    case 'setPermission':
      agents.setPermission(msg.employeeId, msg.mode);
      break;
    case 'renameEmployee':
      agents.rename(msg.employeeId, msg.nick);
      break;
    case 'renameFigure': {
      if (!(msg.key in FIGURE_DEFAULT_NAMES)) break;
      const n = msg.name.trim().slice(0, FIGURE_MAX_LEN[msg.key]);
      store.setEmployeeName(`__${msg.key}`, n || null);
      bus.send({ t: 'figureName', key: msg.key, name: figureName(msg.key) });
      break;
    }
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
    case 'saveRoutine': {
      const { id, name, schedule, employee, prompt, skill, enabled } = msg;
      const input = { name, schedule, employee, prompt, skill: skill ?? null, enabled };
      const r = id ? routines.update(id, input) : routines.create(input);
      bus.send({ t: 'notice', level: 'info', text: `⏰ 루틴 ${id ? '수정' : '등록'}: ${r.name}` });
      break;
    }
    case 'deleteRoutine': {
      const r = routines.remove(msg.id);
      bus.send({ t: 'notice', level: 'info', text: `🗑️ 루틴 삭제: ${r.name}` });
      break;
    }
    case 'todoOp':
      try {
        bus.send({ t: 'todos', data: today.apply(msg.op) });
      } catch (e) {
        reply({ t: 'todos', data: today.load() }); // show the current note so the next try targets the right line
        throw e;
      }
      break;
    case 'createTodayNote':
      today
        .create()
        .then(() => {
          pollTodos();
          bus.send({ t: 'notice', level: 'info', text: '🗒️ 오늘 노트를 만들었습니다.' });
        })
        .catch((e) => reply({ t: 'notice', level: 'error', text: String(e.message) }));
      break;
    case 'getReport': {
      const r = reports.read(msg.path);
      reply({ t: 'reportContent', path: msg.path, content: r.content, mtime: r.mtime });
      break;
    }
    case 'approveSkill': {
      const v = skills.approve(msg.name);
      sendSkills();
      bus.send({ t: 'notice', level: 'info', text: `🧩 스킬 승인: ${v.name}${v.allow.length ? ` (자동 허용 ${v.allow.length}개)` : ''}` });
      break;
    }
    case 'refreshUsage':
      void usage.refresh();
      break;
    case 'setProviderModel':
      providers.setModel(msg.providerId, msg.model);
      agents.reopenProviderSessions(msg.providerId); // the model is baked into the session's env at start
      bus.send({ t: 'notice', level: 'info', text: `🖥 모델 변경: ${msg.model}` });
      break;
  }
}

// ---- static files (production build) + websocket
const DIST = resolve(ROOT, 'dist');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sameOrigin = (req: import('node:http').IncomingMessage) => allowedOrigin(req.headers.origin, office.port);

function handleApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) {
  const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  if (!sameOrigin(req)) return json(403, { error: 'cross-origin request refused' });

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    if (req.headers['x-office-upload'] !== '1') return json(403, { error: 'X-Office-Upload header required' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) return json(413, { error: '파일이 너무 큽니다 (최대 50 MB)' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ATTACHMENT_BYTES) {
        json(413, { error: '파일이 너무 큽니다 (최대 50 MB)' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      attachments
        .save(url.searchParams.get('name') ?? 'file', Buffer.concat(chunks))
        .then((v) => json(200, v))
        .catch((e) => json(400, { error: String((e as Error).message) }));
    });
    return;
  }

  const m = url.pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (m && req.method === 'GET') {
    const r = attachments.rows([Number(m[1])])[0];
    if (!r || !existsSync(r.path)) return json(404, { error: 'not found' });
    // inline for things a browser shows safely; everything else (incl. html/svg) downloads
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv|markdown))$/.test(r.mime);
    res.writeHead(200, {
      'content-type': inline && r.mime.startsWith('text/') ? `${r.mime}; charset=utf-8` : inline ? r.mime : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'x-content-type-options': 'nosniff',
    });
    createReadStream(r.path).pipe(res);
    return;
  }
  json(404, { error: 'unknown api' });
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  let p = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST) || !existsSync(p) || statSync(p).isDirectory()) p = resolve(DIST, 'index.html');
  if (!existsSync(p)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('개발 모드: http://localhost:5173 을 여세요 (npm run dev). 배포 모드: npm run build 후 다시 실행.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  verifyClient: ({ origin, req }, done) => {
    if (allowedOrigin(origin, office.port)) return done(true);
    console.warn(`⛔ 다른 사이트에서 온 WebSocket 연결 거부: ${origin} (${req.socket.remoteAddress})`);
    done(false, 403, 'cross-origin websocket refused');
  },
});
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
  console.log(`🧬 8-bit Lab backend: http://127.0.0.1:${office.port}  (employees: ${roles.length}, servers: ${registry.list().length}, providers: ${office.providers.map((p) => p.id).join(',') || '-'}, maxConcurrent: ${office.maxConcurrent})`);
  registry.start();
  routines.start();
  usage.start();
  providers.start();
  setInterval(pollReports, 5_000);
  setInterval(pollTodos, 3_000);
  attachments.cleanup();
  setInterval(() => attachments.cleanup(), 3600_000);
  console.log(`⏰ routines: ${routines.list().map((r) => `${r.name}(${r.schedule}${r.enabled ? '' : ', off'})`).join(', ') || '(none)'}`);
});
