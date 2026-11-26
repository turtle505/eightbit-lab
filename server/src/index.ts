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
import { NOTEBOOK_ROOT, ReportLibrary, reportRoots } from './reports.ts';
import { Notebook } from './notebook.ts';
import { realDeps, Updater } from './update.ts';
import { searchAll } from './search.ts';
import { normalizeTopic, topicLine } from '../../shared/topics.ts';
import { TodayNote } from './todos.ts';
import type { RunFinished } from './agents/manager.ts';
import type { Engine, FeedItem, Job } from '../../shared/protocol.ts';
import { UsageMonitor } from './usage.ts';
import { CodexUsageMonitor } from './codexUsage.ts';
import { Notifier } from './notify.ts';
import { dueTasks, followBlock, isFinished, orphanedFollowers, readyFollowers, retryBlock, SCHEDULE_SLACK_MS, strandedTasks } from './schedule.ts';
import { ProviderHub } from './providers.ts';
import { AttachmentLibrary, MAX_ATTACHMENT_BYTES, attachmentBlock, hasPdfToText } from './attachments.ts';
import { allowedOrigin } from './origin.ts';
import { cookieHeader, isAuthorized, loginPage, suggestToken, tokenMatches } from './auth.ts';
import { HostRegistry, setSshLimit, sshMux } from './hosts.ts';
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
// The professor used to be decoration with its name under a reserved key; it is an employee (`prof`) now.
// Carry a name the manager gave the figure over to the employee, once.
{
  const old = store.getEmployeeName('__professor');
  if (old != null) {
    if (store.getEmployeeName('prof') == null && roles.some((r) => r.id === 'prof')) store.setEmployeeName('prof', old);
    store.setEmployeeName('__professor', null);
  }
}
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
setSshLimit(office.sshPerMinute, office.sshPerMinuteTotal);
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
hosts.bindSessions((hostId) => agents.views().filter((v) => v.hostId === hostId && v.live).length);
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
const notifier = new Notifier(office.notify);
const empName = (id: string) => agents.views().find((v) => v.id === id)?.name ?? id;
/** Evaluation Analyst "Gauss" → Gauss */
const shortName = (id: string) => empName(id).replace(/^.*"(.*)".*$/, '$1');
bus.on('runFinished', (r: RunFinished) => {
  void notifier.send(r.ok ? 'result' : 'error', `${r.ok ? '✅' : '⚠️'} ${empName(r.employeeId)}: ${r.label}`, notifier.preview(r.text), r.ok ? 'default' : 'high');
});
bus.on('msg', (m: ServerMsg) => {
  if (m.t === 'approval')
    void notifier.send('approval', tr({ ko: `🔐 ${empName(m.data.employeeId)} 승인 요청: ${m.data.toolName}`, en: `🔐 ${empName(m.data.employeeId)} needs approval: ${m.data.toolName}` }), '', 'high');
});
bus.on('runFinished', (r: RunFinished) => {
  if (!r.text.trim() && r.ok) return;
  pushFeed(store.addFeed({ ts: Date.now(), kind: 'result', employeeId: r.employeeId, title: r.label, body: r.text || tr({ ko: '(응답 없음 — 로그 확인)', en: '(no reply; check the log)' }), path: null, ok: r.ok }));
});
const reports = new ReportLibrary(() =>
  reportRoots(office.workspaceRoot, office.reportDirs, (dir) => roles.find((ro) => ro.cwd && resolve(ROOT, ro.cwd) === dir)?.id ?? null, office.notebook),
);
// ---- lab notebook: the office's own dated record of what ended and what the manager jotted down
const notebook = new Notebook(resolve(office.workspaceRoot, NOTEBOOK_ROOT), office.notebook, (text) => bus.send({ t: 'notice', level: 'warn', text }));
bus.on('runFinished', (r: RunFinished) => {
  const t = r.taskId != null ? store.getTask(r.taskId) : undefined;
  if (t) notebook.add({ kind: 'task', ts: Date.now(), taskId: t.id, title: t.title, who: shortName(r.employeeId), ok: r.ok, topic: t.topic, text: r.text, error: r.error });
});
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
    if (f.root === NOTEBOOK_ROOT) continue; // the notebook changes all day; it is read in the reports tab, not announced
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
// ---- the office's own version: is the remote ahead, and the update button
const updater = new Updater(realDeps(ROOT), (v) => bus.send({ t: 'update', data: { ...v } }));
const UPDATE_CHECK_MS = 30 * 60_000;
const usage = new UsageMonitor(ROOT);
const codexUsage = new CodexUsageMonitor();
// refresh subscription usage shortly after an employee finishes a run
bus.on('msg', (m: ServerMsg) => {
  // a task can run on the engine that isn't the employee's default, so refresh both (debounced, cheap)
  if (m.t === 'employee' && (m.data.status === 'done' || m.data.status === 'error')) {
    codexUsage.poke();
    usage.poke();
  }
});

function assignTask(taskId: number, employeeId: string) {
  if (!agents.has(employeeId)) return;
  const before = store.getTask(taskId);
  // assigning by hand starts a scheduled card now; starting again clears the mark of the attempt before
  const t = store.updateTask(taskId, { assignee: employeeId, state: 'doing', startAt: null, halt: null, error: null });
  if (!t || !before) return;
  bus.send({ t: 'task', data: t });
  agents.instruct(employeeId, taskPrompt(t.id) + retryBlock(before), t.id, { label: `${t.requireApproval ? '🔒' : '📋'} #${t.id} ${t.title}`, requireApproval: t.requireApproval, engine: t.engine, attachmentPaths: store.attachmentsForTask(t.id).flatMap((r) => [r.path, ...(r.textPath ? [r.textPath] : [])]) });
}

function createTask(
  title: string,
  detail: string,
  assignee: string | null,
  createdBy: string | null = null,
  requireApproval = false,
  attachmentIds: number[] = [],
  startAt: number | null = null,
  engine: Engine | null = null,
  afterTask: number | null = null,
  topic: string | null = null,
) {
  const known = !!assignee && agents.has(assignee);
  // following another task: wait for it if it is still going; if it already finished, start now with its result
  const prev = afterTask != null ? store.getTask(afterTask) : undefined;
  const waits = known && !!prev && !isFinished(prev);
  // a start time only means something with someone to start it; one that's (nearly) now just starts now.
  // A card that follows another has no start time of its own: the other task finishing is its start.
  const later = known && !waits && startAt != null && startAt > Date.now() + SCHEDULE_SLACK_MS ? startAt : null;
  // a follow-up with no topic of its own belongs to the topic of the task it follows
  const norm = normalizeTopic(topic);
  const subject = ('topic' in norm ? norm.topic : null) ?? prev?.topic ?? null;
  const created = store.createTask(title.trim() || tr({ ko: '(제목 없음)', en: '(untitled)' }), detail ?? '', later || waits ? assignee : null, createdBy, requireApproval, later, engine, prev ? prev.id : null, subject);
  if (attachmentIds.length) store.bindAttachments(created.id, attachmentIds);
  const t = store.getTask(created.id)!;
  bus.send({ t: 'task', data: t });
  if (assignee && !later && !waits) assignTask(t.id, assignee);
  return store.getTask(t.id)!;
}

/** Start cards whose predecessor has finished, and free the ones whose predecessor was deleted. */
function startFollowers() {
  const tasks = store.listTasks();
  for (const t of orphanedFollowers(tasks)) {
    const freed = store.updateTask(t.id, { afterTask: null });
    if (!freed) continue;
    bus.send({ t: 'task', data: freed });
    bus.send({ t: 'notice', level: 'warn', text: tr({ ko: `⛓ #${t.id} ${t.title}: 앞 작업이 삭제되어 대기를 풀었습니다. 직접 시작해 주세요.`, en: `⛓ #${t.id} ${t.title}: the task it followed was deleted, so it no longer waits. Start it by hand.` }) });
  }
  for (const t of readyFollowers(tasks, (id) => agents.has(id))) {
    const who = empName(t.assignee!);
    bus.send({ t: 'notice', level: 'info', text: tr({ ko: `⛓ #${t.afterTask} 완료 → #${t.id} 시작: ${t.title} → ${who}`, en: `⛓ #${t.afterTask} finished → #${t.id} started: ${t.title} → ${who}` }) });
    assignTask(t.id, t.assignee!);
  }
}
// a task reaching review/done, or being deleted, may release what follows it (deferred: this runs inside bus.send)
bus.on('msg', (m: ServerMsg) => {
  if ((m.t === 'task' && isFinished(m.data)) || m.t === 'taskDeleted') setImmediate(startFollowers);
});

/** Start scheduled cards whose time has come (checked every 20 s; at boot, ones missed while the backend was down). */
function startDueTasks(now = Date.now()) {
  for (const t of dueTasks(store.listTasks(), now, (id) => agents.has(id))) {
    const late = now - t.startAt! > 5 * 60_000;
    const who = empName(t.assignee!);
    bus.send({
      t: 'notice',
      level: 'info',
      text: late
        ? tr({ ko: `⏰ 예약 작업 #${t.id} 시작 (예정보다 늦음): ${t.title} → ${who}`, en: `⏰ Scheduled task #${t.id} started late: ${t.title} → ${who}` })
        : tr({ ko: `⏰ 예약 작업 #${t.id} 시작: ${t.title} → ${who}`, en: `⏰ Scheduled task #${t.id} started: ${t.title} → ${who}` }),
    });
    void notifier.send('scheduled', tr({ ko: `⏰ ${who}: #${t.id} ${t.title} 시작`, en: `⏰ ${who} started #${t.id} ${t.title}` }), '', 'low');
    assignTask(t.id, t.assignee!);
  }
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
  usage: () => ({ claude: usage.view, codex: codexUsage.view }),
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

// the manager figure and the whiteboard are decoration, not employees; their text lives in employee_names under reserved keys
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
    codexUsage: codexUsage.view,
    running: agents.runningCount(),
    maxConcurrent: office.maxConcurrent,
    figureNames: figureNames(),
    providers: providers.views(),
    hosts: hosts.views(),
    projects: projects.views(),
    language: getLang(),
    update: updater.view,
  };
}

function taskPrompt(id: number): string {
  const t = store.getTask(id)!;
  // a follow-up gets the result of the task before it
  const prev = t.afterTask != null ? store.getTask(t.afterTask) : undefined;
  const follows = prev ? followBlock(prev, prev.assignee ? empName(prev.assignee) : 'someone') : '';
  return `The manager assigned you task #${t.id}.\n\nTitle: ${t.title}${topicLine(t.topic)}\n\n${t.detail || '(no details)'}${attachmentBlock(store.attachmentsForTask(t.id))}${follows}\n\nWhen you finish, report where the outputs are and a summary.`;
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
bus.on('resultRecorded', (job: Job) => {
  notebook.add({ kind: 'result', ts: Date.now(), jobId: job.id, name: job.name, who: job.submittedBy ? shortName(job.submittedBy) : 'manager', topic: job.topic, metrics: job.metrics ?? {}, params: job.params, note: job.note });
});
registry.onJobFinished((job) => {
  notebook.add({ kind: 'job', ts: Date.now(), jobId: job.id, name: job.name, server: job.server, state: job.state, topic: job.topic });
  bus.send({ t: 'notice', level: job.state === 'completed' ? 'info' : 'warn', text: `Job #${job.id} ${job.name} @${job.server}: ${job.state}` });
  void notifier.send('job', `🖥️ Job #${job.id} ${job.name} @${job.server}: ${job.state}`, '', job.state === 'completed' ? 'default' : 'high');
  if (job.submittedBy && agents.has(job.submittedBy)) {
    agents.instruct(
      job.submittedBy,
      `[Automatic notice] Remote job #${job.id} (${job.name}, ${job.server}) ended in state '${job.state}'. Check the log with mcp__lab__tail_log and report the result briefly. If the log shows final metrics, write them with mcp__lab__record_result (job_id ${job.id}) so the run appears in the comparison table; record only numbers that are in the log. If the next step is not clear, only suggest it.`,
      null,
      { label: `🖥️ Job #${job.id} ${job.name} (${job.state})` },
    );
  }
});

function handle(msg: ClientMsg, ws: WebSocket) {
  const reply = (m: ServerMsg) => ws.send(JSON.stringify(m));
  switch (msg.t) {
    case 'createTask':
      createTask(msg.title, msg.detail, msg.assignee ?? null, null, !!msg.requireApproval, msg.attachmentIds ?? [], msg.startAt ?? null, null, msg.afterTask ?? null, msg.topic ?? null);
      break;
    case 'presence':
      if (msg.visible) watching.add(ws);
      else watching.delete(ws);
      break;
    case 'assignTask':
      assignTask(msg.taskId, msg.employeeId);
      break;
    case 'retryTask': {
      const t = store.getTask(msg.taskId);
      if (!t || t.state !== 'doing' || !t.halt || !t.assignee) break;
      if (!agents.has(t.assignee)) reply({ t: 'notice', level: 'warn', text: tr({ ko: '담당 직원이 없습니다. 다른 직원에게 배정하세요.', en: 'The assignee no longer exists. Assign it to someone else.' }) });
      else assignTask(t.id, t.assignee);
      break;
    }
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
      if (projects.isWaiting(msg.employeeId)) {
        reply({ t: 'notice', level: 'warn', text: tr({ ko: '이 세션의 서버에 아직 연결되지 않았습니다. 서버 줄의 ↻로 확인한 뒤 다시 보내세요.', en: 'This session\'s server is not connected yet. Check it with ↻ on the server line, then send again.' }) });
        break;
      }
      const rows = attachments.rows(msg.attachmentIds ?? []);
      if (!msg.text.trim() && !rows.length) break;
      store.markAttachmentsUsed(rows.map((r) => r.id));
      agents.instruct(msg.employeeId, (msg.text.trim() || 'Please look at the attached files.') + attachmentBlock(rows), null, { attachmentPaths: rows.flatMap((r) => [r.path, ...(r.textPath ? [r.textPath] : [])]) });
      break;
    }
    case 'addNote': {
      const text = msg.text.trim().slice(0, 4000);
      if (!text) break;
      if (!notebook.on) reply({ t: 'notice', level: 'warn', text: tr({ ko: '연구 노트가 꺼져 있습니다 (office.yaml의 notebook).', en: 'The notebook is off (notebook in office.yaml).' }) });
      else if (notebook.add({ kind: 'memo', ts: Date.now(), text })) pollReports();
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
    case 'setEmployeeEngine':
      agents.setEngine(msg.employeeId, msg.engine);
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
    case 'search':
      // answered to the browser that asked only
      reply({ t: 'searchResults', q: msg.q, hits: searchAll(String(msg.q ?? '').slice(0, 200), store, reports, (id) => agents.views().find((v) => v.id === id)?.name ?? id) });
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
    case 'checkUpdate':
      void updater.check();
      break;
    case 'applyUpdate': {
      const working = agents.busy().working.map((w) => shortName(w.id));
      const r = updater.apply(working);
      if (r === 'busy')
        reply({ t: 'notice', level: 'warn', text: tr({ ko: `지금 일하는 직원이 있어 업데이트하지 않았습니다: ${working.join(', ')}. 다시 시작하면 하던 일이 끊깁니다.`, en: `Not updating: ${working.join(', ')} ${working.length > 1 ? 'are' : 'is'} working, and a restart would cut that off.` }) });
      else if (r === 'no-restart')
        reply({ t: 'notice', level: 'warn', text: tr({ ko: '이 환경에서는 화면에서 다시 시작할 수 없습니다. 터미널에서 npm run update 를 실행한 뒤 직접 다시 시작하세요.', en: 'This setup cannot be restarted from the screen. Run npm run update in a terminal, then restart the backend yourself.' }) });
      else if (r === 'running') reply({ t: 'notice', level: 'info', text: tr({ ko: '업데이트가 이미 진행 중입니다.', en: 'An update is already running.' }) });
      break;
    }
    case 'refreshUsage':
      void usage.refresh();
      void codexUsage.refresh();
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
    case 'disconnectHost': {
      const h = hosts.get(msg.hostId);
      if (!h || h.isLocal) break;
      const busy = agents.busyOn(h.cfg.id);
      if (busy.length) {
        reply({ t: 'notice', level: 'warn', text: tr({ ko: `${h.view.name}에서 일하는 중이라 끊지 않았습니다: ${busy.join(', ')}`, en: `Not disconnecting ${h.view.name}: ${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} working there` }) });
        break;
      }
      agents.closeSessionsOn(h.cfg.id);
      void sshMux.close(h.cfg.ssh).then(() => h.refreshUsage());
      break;
    }
    case 'setSessionInOffice':
      try {
        projects.setInOffice(msg.id, msg.inOffice);
      } catch (e) {
        // no seat at the project tables: say so, without the alarm of an error
        reply({ t: 'notice', level: 'warn', text: String((e as Error).message) });
      }
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
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(true, figureName('title')));
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
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(false, figureName('title')));
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
/** tabs in front right now: phone notifications wait while someone is watching (notify.whenAway) */
const watching = new Set<WebSocket>();
notifier.isWatched = () => watching.size > 0;
wss.on('connection', (ws) => {
  ws.on('close', () => watching.delete(ws));
  ws.send(JSON.stringify({ t: 'snapshot', data: snapshot() } satisfies ServerMsg));
  // someone opened the office: if the last look at the remote is old, look again now rather than at the next half hour
  if (office.updateCheck && updater.view.checkedAt && Date.now() - updater.view.checkedAt > 10 * 60_000) void updater.check();
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
  void updater.init().then(() => {
    bus.send({ t: 'update', data: { ...updater.view } });
    if (!office.updateCheck) return;
    void updater.check();
    setInterval(() => void updater.check(), UPDATE_CHECK_MS);
  });
  void hasPdfToText().then((ok) => {
    if (!ok) console.log(tr({ ko: '· pdftotext가 없어 PDF 첨부는 원본 그대로 전달됩니다 (poppler 설치 시 글을 먼저 뽑아 토큰을 아낍니다)', en: '· pdftotext not found: PDF attachments are passed as they are (install poppler to hand over their text first and save tokens)' }));
  });
  registry.start();
  routines.start();
  usage.start();
  codexUsage.start();
  providers.start();
  hosts.start();
  // project sessions come back as their hosts answer (a host's home folder is needed to place them)
  projects.restore();
  bus.on('msg', (m: ServerMsg) => {
    if (m.t === 'host' && m.data.ok) projects.restore();
  });
  setInterval(pollReports, 5_000);
  setInterval(pollTodos, 3_000);
  attachments.cleanup();
  setInterval(() => attachments.cleanup(), 3600_000);
  // cards a restart cut off would look in progress forever: mark them so they can be started again
  for (const t of strandedTasks(store.listTasks(), () => false)) store.updateTask(t.id, { halt: 'restart' });
  startDueTasks();
  startFollowers(); // ones whose predecessor finished while the backend was down
  setInterval(startDueTasks, 20_000);
  if (notifier.channels.length) console.log(`📱 notifications → ${notifier.channels.join(' + ')} (${office.notify!.events.join(', ')})`);
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
