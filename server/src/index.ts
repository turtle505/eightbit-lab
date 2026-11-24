import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { FIGURE_KEYS, FIGURE_MAX_LEN, figureDefaultName, type ClientMsg, type FigureKey, type ServerMsg, type Snapshot } from '../../shared/protocol.ts';
import { getLang, isLang, setLang, tr } from '../../shared/i18n.ts';
import { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import { ServerRegistry } from './compute/registry.ts';
import { ROOT, loadOffice, loadRoles, loadRoutines, loadServers, teamPrompt } from './config.ts';
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
import { cookieHeader, isAuthorized, loginPage, suggestToken, tokenMatches } from './auth.ts';
import { HostRegistry, setSshLimit } from './hosts.ts';
import { ProjectRegistry } from './projects.ts';
import { mkdirSync } from 'node:fs';

const office = loadOffice();
const servers = loadServers();
// the remote-server etiquette and the lab tools only make sense when there is a remote machine to reach
const withServers = servers.length > 0 || office.hosts.some((h) => h.ssh !== 'local');
const roles = loadRoles(office.domain, withServers);
const store = new Store();
{
  const saved = store.getSetting('language');
  setLang(isLang(saved) ? saved : office.language);
}
const broker = new PermissionBroker();
const registry = new ServerRegistry(servers, store);
const agents = new AgentManager(office, roles, store, broker, registry);
const skills = new SkillLibrary(resolve(office.workspaceRoot, 'office-skills'), store);
skills.ensure();
agents.pluginDirs = [skills.dir];
const attachments = new AttachmentLibrary(office.workspaceRoot, store);
mkdirSync(attachments.dir, { recursive: true });
agents.extraDirs = [attachments.dir];
const orphaned = store.reassignUnknown(roles.map((r) => r.id));
if (orphaned)
  console.warn(
    tr({
      ko: `⚠️ 없는 직원에게 배정돼 있던 작업 ${orphaned}건을 미배정으로 되돌렸습니다`,
      en: `⚠️ Unassigned ${orphaned} task(s) that were assigned to employees who no longer exist`,
    }),
  );
setSshLimit(office.sshPerMinute);
const hosts = new HostRegistry(office.hosts);
agents.hosts = hosts;
for (const r of roles)
  if (r.host && !hosts.get(r.host))
    console.warn(
      tr({
        ko: `⚠️ ${r.id}: host '${r.host}' 가 office(.local).yaml 의 hosts 에 없습니다`,
        en: `⚠️ ${r.id}: host '${r.host}' is not in the hosts of office(.local).yaml`,
      }),
    );
hosts.bindLiveness((hostId) => agents.views().some((v) => v.hostId === hostId && v.live));
const projects = new ProjectRegistry(store, agents, hosts, teamPrompt(office.domain, withServers));
const providers = new ProviderHub(office.providers, store);
agents.providers = providers;
for (const r of roles)
  if (r.provider && !providers.get(r.provider))
    console.warn(
      tr({
        ko: `⚠️ ${r.id}: provider '${r.provider}' 가 office(.local).yaml 의 providers 에 없습니다 — 이 직원은 실행할 수 없습니다`,
        en: `⚠️ ${r.id}: provider '${r.provider}' is not in the providers of office(.local).yaml; this employee cannot run`,
      }),
    );
const sendSkills = () => bus.send({ t: 'skills', data: skills.list() });

// ---- report feed: finished runs + report files that appear or change
const pushFeed = (f: FeedItem) => bus.send({ t: 'feed', data: f });
bus.on('runFinished', (r: RunFinished) => {
  if (!r.text.trim() && r.ok) return;
  pushFeed(store.addFeed({ ts: Date.now(), kind: 'result', employeeId: r.employeeId, title: r.label, body: r.text || tr({ ko: '(응답 없음 — 로그 확인)', en: '(no reply; check the log)' }), path: null, ok: r.ok }));
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
  const created = store.createTask(title.trim() || tr({ ko: '(제목 없음)', en: '(untitled)' }), detail ?? '', null, createdBy, requireApproval);
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
    bus.send({ t: 'notice', level: 'info', text: tr({ ko: `⏰ 루틴 시작: ${name}`, en: `⏰ Routine started: ${name}` }) });
    let extraAllow: string[] = [];
    if (skill) {
      const allow = skills.allowFor(skill);
      if (allow === null)
        bus.send({
          t: 'notice',
          level: 'warn',
          text: tr({
            ko: `🧩 스킬 ${skill}이(가) 승인 후 바뀌었거나 승인되지 않아 자동 허용 없이 실행합니다. 루틴 패널에서 재승인하세요.`,
            en: `🧩 Skill ${skill} changed since approval or was never approved, so it runs without auto-allow. Re-approve it in the routines panel.`,
          }),
        });
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
const figureName = (key: FigureKey) => store.getEmployeeName(`__${key}`) ?? figureDefaultName(key);
const figureNames = () => Object.fromEntries(FIGURE_KEYS.map((k) => [k, figureName(k)])) as Record<FigureKey, string>;

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
    hosts: hosts.views(),
    projects: projects.views(),
    language: getLang(),
  };
}

function taskPrompt(id: number): string {
  const t = store.getTask(id)!;
  return `The manager assigned you task #${t.id}.\n\nTitle: ${t.title}\n\n${t.detail || '(no details)'}${attachmentBlock(store.attachmentsForTask(t.id))}\n\nWhen you finish, report where the outputs are and a summary.`;
}

// When a delegated task ends, hand the result back to the employee who delegated it (team lead / secretary).
bus.on('runFinished', (r: RunFinished) => {
  if (r.taskId == null) return;
  const t = store.getTask(r.taskId);
  const by = t?.createdBy;
  if (!t || !by || by === r.employeeId || !agents.has(by)) return;
  const who = agents.views().find((v) => v.id === r.employeeId)?.name ?? r.employeeId;
  const result = r.text.trim() ? (r.text.length > 1500 ? `${r.text.slice(0, 1500)}…(truncated; full text via list_tasks)` : r.text) : '(no reply)';
  // the finished task is still 'doing' here (it moves to review right after this event)
  const open = store.listTasks().filter((o) => o.createdBy === by && o.id !== t.id && (o.state === 'todo' || o.state === 'doing'));
  const rest = open.length
    ? `Delegated tasks still in progress: ${open.map((o) => `#${o.id} ${o.title} (${o.assignee ?? 'unassigned'})`).join(', ')}\n→ Just note this result briefly and wait. If your plan had a next step that needed this result to start, assign it now.`
    : 'All the tasks you delegated are done.\n→ If your plan still has a next step that starts from this result, assign it; otherwise combine all the results and report to the manager.';
  agents.instruct(
    by,
    `[Automatic notice] Task #${t.id} "${t.title}" (assignee ${who}) ${r.ok ? 'finished' : 'ended with an error'}.\n\nResult:\n${result}\n\n${rest}`,
    null,
    { label: tr({ ko: `📬 #${t.id} 결과 도착`, en: `📬 #${t.id} result in` }) },
  );
});

// When a remote job ends, tell whoever submitted it so they can follow up.
registry.onJobFinished((job) => {
  bus.send({ t: 'notice', level: job.state === 'completed' ? 'info' : 'warn', text: `Job #${job.id} ${job.name} @${job.server}: ${job.state}` });
  if (job.submittedBy && agents.has(job.submittedBy)) {
    agents.instruct(
      job.submittedBy,
      `[Automatic notice] Remote job #${job.id} (${job.name}, ${job.server}) ended in state '${job.state}'. Check the log with mcp__lab__tail_log and report the result briefly. If the next step is not clear, only suggest it.`,
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
      agents.instruct(msg.employeeId, (msg.text.trim() || 'Please look at the attached files.') + attachmentBlock(rows));
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
      if (!FIGURE_KEYS.includes(msg.key)) break;
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
      bus.send({ t: 'notice', level: 'info', text: id ? tr({ ko: `⏰ 루틴 수정: ${r.name}`, en: `⏰ Routine updated: ${r.name}` }) : tr({ ko: `⏰ 루틴 등록: ${r.name}`, en: `⏰ Routine added: ${r.name}` }),
      });
      break;
    }
    case 'deleteRoutine': {
      const r = routines.remove(msg.id);
      bus.send({ t: 'notice', level: 'info', text: tr({ ko: `🗑️ 루틴 삭제: ${r.name}`, en: `🗑️ Routine deleted: ${r.name}` }) });
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
          bus.send({ t: 'notice', level: 'info', text: tr({ ko: '🗒️ 오늘 노트를 만들었습니다.', en: "🗒️ Created today's note." }) });
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
      bus.send({ t: 'notice', level: 'info', text: tr({
          ko: `🧩 스킬 승인: ${v.name}${v.allow.length ? ` (자동 허용 ${v.allow.length}개)` : ''}`,
          en: `🧩 Skill approved: ${v.name}${v.allow.length ? ` (${v.allow.length} auto-allow rule(s))` : ''}`,
        }),
      });
      break;
    }
    case 'refreshUsage':
      void usage.refresh();
      break;
    case 'listHostDirs': {
      const h = hosts.get(msg.hostId);
      if (!h) break;
      void h.listProjects().then((dirs) => reply({ t: 'hostDirs', hostId: msg.hostId, dirs }));
      break;
    }
    case 'createProject':
      projects
        .create(msg.hostId, msg.name, msg.dir, msg.label)
        .then((p) => {
          projects.send();
          bus.send({ t: 'notice', level: 'info', text: tr({ ko: `📂 프로젝트 추가: ${p.name}`, en: `📂 Project added: ${p.name}` }) });
        })
        .catch((e) => reply({ t: 'notice', level: 'error', text: String((e as Error).message) }));
      break;
    case 'archiveProject':
      projects.archive(msg.id);
      bus.send({ t: 'notice', level: 'info', text: tr({ ko: '📂 프로젝트를 보관했습니다', en: '📂 Project archived' }) });
      break;
    case 'addProjectSession':
      projects.addSession(msg.projectId, msg.label);
      break;
    case 'closeProjectSession':
      projects.closeSession(msg.id);
      break;
    case 'setLanguage': {
      if (!isLang(msg.lang) || msg.lang === getLang()) break;
      setLang(msg.lang);
      store.setSetting('language', msg.lang);
      agents.relabelIdle();
      // server-made text (statuses, default names, usage labels) is rebuilt in the new language
      bus.send({ t: 'snapshot', data: snapshot() });
      break;
    }
    case 'resumeWork': {
      const ok = agents.resumeNow(msg.employeeId);
      bus.send({ t: 'notice', level: ok ? 'info' : 'warn', text: ok
          ? tr({ ko: '▶️ 중단된 작업을 다시 시작했습니다', en: '▶️ Resumed the paused work' })
          : tr({ ko: '이어서 할 작업이 없습니다', en: 'Nothing to resume' }),
      });
      break;
    }
    case 'recheckHost':
      void hosts.get(msg.hostId)?.recheck();
      break;
    case 'setSessionInOffice':
      projects.setInOffice(msg.id, msg.inOffice);
      break;
    case 'setProviderModel':
      providers.setModel(msg.providerId, msg.model);
      agents.reopenProviderSessions(msg.providerId); // the model is baked into the session's env at start
      bus.send({ t: 'notice', level: 'info', text: tr({ ko: `🖥 모델 변경: ${msg.model}`, en: `🖥 Model changed: ${msg.model}` }) });
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

  // the one route that may be reached without the token
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.length < 64 && chunks.push(c));
    req.on('end', () => {
      const token = new URLSearchParams(Buffer.concat(chunks).toString()).get('token') ?? '';
      if (!tokenMatches(token, office.authToken)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(true));
        return;
      }
      res.writeHead(303, { location: '/', 'set-cookie': cookieHeader(office.authToken) }).end();
    });
    return;
  }
  if (!isAuthorized(req, office.authToken)) return json(401, { error: tr({ ko: '사무실 토큰이 필요합니다', en: 'Office token required' }) });

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    if (req.headers['x-office-upload'] !== '1') return json(403, { error: 'X-Office-Upload header required' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) return json(413, { error: tr({ ko: '파일이 너무 큽니다 (최대 50 MB)', en: 'File too large (max 50 MB)' }) });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ATTACHMENT_BYTES) {
        json(413, { error: tr({ ko: '파일이 너무 큽니다 (최대 50 MB)', en: 'File too large (max 50 MB)' }) });
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

  if (url.pathname === '/api/busy' && req.method === 'GET') return json(200, agents.busy());

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
  if (!isAuthorized(req, office.authToken)) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(false));
    return;
  }
  let p = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST) || !existsSync(p) || statSync(p).isDirectory()) p = resolve(DIST, 'index.html');
  if (!existsSync(p)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(
      tr({
        ko: '개발 모드: http://localhost:5173 을 여세요 (npm run dev). 배포 모드: npm run build 후 다시 실행.',
        en: 'Dev mode: open http://localhost:5173 (npm run dev). Production: run npm run build, then start again.',
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  verifyClient: ({ origin, req }, done) => {
    if (!allowedOrigin(origin, office.port)) {
      console.warn(
        tr({
          ko: `⛔ 다른 사이트에서 온 WebSocket 연결 거부: ${origin} (${req.socket.remoteAddress})`,
          en: `⛔ Refused a WebSocket connection from another site: ${origin} (${req.socket.remoteAddress})`,
        }),
      );
      return done(false, 403, 'cross-origin websocket refused');
    }
    if (!isAuthorized(req, office.authToken)) {
      console.warn(
        tr({ ko: `⛔ 토큰 없는 WebSocket 연결 거부 (${req.socket.remoteAddress})`, en: `⛔ Refused a WebSocket connection without a token (${req.socket.remoteAddress})` }),
      );
      return done(false, 401, 'office token required');
    }
    done(true);
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
  console.log(`👾 8-bit Lab backend: http://127.0.0.1:${office.port}  (employees: ${roles.length}, servers: ${registry.list().length}, providers: ${office.providers.map((p) => p.id).join(',') || '-'}, maxConcurrent: ${office.maxConcurrent})`);
  registry.start();
  routines.start();
  usage.start();
  providers.start();
  hosts.start();
  // sessions are restored once the hosts have answered, so their home dirs are known
  setTimeout(() => projects.restore(), 4_000);
  setInterval(pollReports, 5_000);
  setInterval(pollTodos, 3_000);
  attachments.cleanup();
  setInterval(() => attachments.cleanup(), 3600_000);
  if (office.authToken) console.log(
      tr({
        ko: '🔑 사무실 토큰 잠금 켜짐 (브라우저는 첫 접속에 한 번 입력, 스크립트는 X-Office-Token 헤더)',
        en: '🔑 Office token lock on (browsers enter it once on first visit; scripts send the X-Office-Token header)',
      }),
    );
  else console.warn(
      tr({
        ko: `🔓 사무실에 토큰 잠금이 없습니다. 이 기기에 SSH 로 들어올 수 있는 사람은 누구나 직원을 조종할 수 있습니다.\n   켜려면 config/office.local.yaml 에:  authToken: "${suggestToken()}"`,
        en: `🔓 The office has no token lock. Anyone who can SSH into this machine can drive the employees.\n   To turn it on, in config/office.local.yaml:  authToken: "${suggestToken()}"`,
      }),
    );
  console.log(`⏰ routines: ${routines.list().map((r) => `${r.name}(${r.schedule}${r.enabled ? '' : ', off'})`).join(', ') || '(none)'}`);
});
