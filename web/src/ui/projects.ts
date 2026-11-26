// Projects tab: per host (the unit of connection), its projects (folders, the unit of work), each holding several
// independent Claude Code sessions.
import { followBottom } from './follow.ts';
import type { EmployeeView, HostView, ProjectView } from '../../../shared/protocol.ts';
import { groupByHost, HOST_CHANNELS } from './targets.ts';
import { locale, tr } from '../../../shared/i18n.ts';
import { $, type Send, type UIState, ago, changed, esc, plain, statusLabel } from './panels.ts';

/** folders offered in the new-project picker, per host (filled by a `hostDirs` reply) */
const dirsByHost = new Map<string, string[]>();
let openSession: string | null = null;
/** the host whose "add project" form is open, and what has been typed into it (the tab is redrawn every 15 s) */
let addingOn: string | null = null;
const draft = { dir: '', name: '', label: '' };

export function setHostDirs(hostId: string, dirs: string[]) {
  dirsByHost.set(hostId, dirs);
}

const BUSY = ['thinking', 'typing', 'running', 'researching', 'remote', 'waiting_permission', 'queued'];

function sessionCard(st: UIState, s: EmployeeView): string {
  const open = openSession === s.id;
  const lines = st.logs.get(s.id) ?? [];
  const last = [...lines].reverse().find((l) => l.kind === 'assistant' || l.kind === 'result');
  return `<div class="psession ${open ? 'open' : ''}" data-id="${esc(s.id)}">
    <div class="prow">
      <button type="button" class="link pname" data-act="open">${open ? '▾' : '▸'} ${esc(plain(s.name.split('·').pop() ?? s.name))}</button>
      <span class="badge b-${s.status}">${statusLabel(s.status)}</span>
      <span class="muted small">${s.live ? '🟢' : '⚪'}</span>
      <span class="muted small last">${esc(plain(last?.text ?? tr({ ko: '아직 지시 없음', en: 'No instructions yet' })).slice(0, 70))}</span>
      <button type="button" data-act="office" title="${
        s.desk >= 0
          ? tr({ ko: '사무실에서 빼기 (세션은 유지)', en: 'Remove from the office (the session stays)' })
          : tr({ ko: '사무실에 책상을 주고 캐릭터로 띄우기', en: 'Give it a desk in the office as a character' })
      }">${s.desk >= 0 ? tr({ ko: '🪑 사무실', en: '🪑 Office' }) : tr({ ko: '사무실에 들이기', en: 'Bring to office' })}</button>
      ${BUSY.includes(s.status) ? `<button type="button" data-act="stop">${tr({ ko: '중지', en: 'Stop' })}</button>` : ''}
      <button type="button" data-act="close" title="${tr({ ko: '이 세션 닫기', en: 'Close this session' })}">✕</button>
    </div>
    ${
      open
        ? `<div class="plog">${lines
            .slice(-60)
            .map((l) => `<div class="line k-${l.kind}"><span class="ts">${new Date(l.ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span><span class="txt">${esc(l.text)}</span></div>`)
            .join('')}</div>
           <form class="instruct psend"><textarea rows="2" placeholder="${tr({ ko: '이 세션에 지시… (Enter 전송)', en: 'Instruct this session… (Enter to send)' })}"></textarea></form>`
        : ''
    }
  </div>`;
}

function projectCard(st: UIState, p: ProjectView): string {
  const host = (st.snap.hosts ?? []).find((h) => h.id === p.hostId);
  return `<section class="pcard" data-project="${esc(p.id)}">
    <header>
      <b>📁 ${esc(p.name)}</b>
      <span class="muted small">${host ? '' : `${esc(p.hostId)} · `}${esc(p.dir)}</span>
      <span class="grow"></span>
      <button type="button" data-act="add">${tr({ ko: '+ 세션', en: '+ Session' })}</button>
      <button type="button" data-act="archive" title="${tr({ ko: '프로젝트 보관 (세션 모두 닫힘)', en: 'Archive the project (closes all sessions)' })}">${tr({ ko: '보관', en: 'Archive' })}</button>
    </header>
    ${p.sessions.length ? p.sessions.map((s) => sessionCard(st, s)).join('') : `<p class="muted small">${tr({ ko: '세션이 없습니다. “+ 세션”을 누르세요.', en: 'No sessions. Press “+ Session”.' })}</p>`}
  </section>`;
}

/** The line that says how a host's one ssh connection is doing. The local machine has none. */
function hostHead(h: HostView): string {
  if (h.local)
    return `<header class="phost-head"><b>${esc(plain(h.name))}</b><span class="muted small">${tr({ ko: '이 컴퓨터', en: 'this machine' })}${h.sessions ? tr({ ko: ` · 세션 ${h.sessions}`, en: ` · ${h.sessions} session${h.sessions > 1 ? 's' : ''}` }) : ''}</span><span class="grow"></span>
      <button type="button" data-act="new-project">${tr({ ko: '+ 프로젝트', en: '+ Project' })}</button></header>`;
  const state = h.connected
    ? `<span class="conn on">🟢 ${tr({ ko: '연결됨', en: 'Connected' })}</span>`
    : h.retryInSec > 0 || !h.ok
      ? `<span class="conn bad" title="${esc(h.error ?? '')}">🔴 ${tr({ ko: '접속 불가', en: 'Unreachable' })}${h.retryInSec > 0 ? tr({ ko: ` · ${h.retryInSec}초 뒤 다시 시도 가능`, en: ` · may retry in ${h.retryInSec}s` }) : ''}</span>`
      : `<span class="conn idle" title="${esc(tr({ ko: '쓰지 않는 동안에는 접속을 닫아 둡니다. 세션을 열거나 지시하면 다시 연결합니다.', en: 'The connection is closed while unused. Opening a session or giving an instruction reconnects.' }))}">⚪ ${tr({ ko: '쉬는 중 (쓸 때 연결)', en: 'Idle (connects when used)' })}</span>`;
  const sess = `<span class="${h.sessions >= HOST_CHANNELS - 2 ? 'conn bad' : 'muted'} small" title="${esc(tr({ ko: `서버는 접속 하나에서 동시에 ${HOST_CHANNELS}개쯤까지 받습니다`, en: `A server takes about ${HOST_CHANNELS} things at once on one connection` }))}">${tr({ ko: '세션', en: 'sessions' })} ${h.sessions}/${HOST_CHANNELS}</span>`;
  const budget = h.sshLimit > 0 ? `<span class="${h.sshUsed >= h.sshLimit ? 'conn bad' : 'muted'} small" title="${esc(tr({ ko: '이번 1분 동안 이 서버로 새로 연 접속 / 한도', en: 'New connections to this server in the last minute / limit' }))}">${tr({ ko: '접속', en: 'connections' })} ${h.sshUsed}/${h.sshLimit}</span>` : '';
  return `<header class="phost-head"><b>${esc(plain(h.name))}</b>${state}${sess}${budget}<span class="grow"></span>
    <button type="button" data-act="recheck" title="${esc(tr({ ko: '지금 연결 확인', en: 'Check the connection now' }))}">↻</button>
    <button type="button" data-act="disconnect" ${h.connected ? '' : 'disabled'} title="${esc(tr({ ko: '이 서버로의 접속을 닫습니다 (쉬는 세션도 닫히고, 대화는 남습니다)', en: 'Close the connection to this server (idle sessions close too; conversations are kept)' }))}">${tr({ ko: '끊기', en: 'Disconnect' })}</button>
    <button type="button" data-act="new-project" ${h.ok ? '' : 'disabled'}>${tr({ ko: '+ 프로젝트', en: '+ Project' })}</button></header>`;
}

const addForm = (hostId: string) => `<form class="pnew" data-host="${esc(hostId)}">
    <input name="dir" list="pnew-dirs" placeholder="${tr({ ko: '폴더 (예: bio2token)', en: 'Folder (e.g. bio2token)' })}" autocomplete="off" value="${esc(draft.dir)}" />
    <datalist id="pnew-dirs">${(dirsByHost.get(hostId) ?? []).map((d) => `<option value="${esc(d)}"></option>`).join('')}</datalist>
    <input name="name" placeholder="${tr({ ko: '이름 (비우면 폴더 이름)', en: 'Name (empty = folder name)' })}" autocomplete="off" value="${esc(draft.name)}" />
    <input name="label" placeholder="${tr({ ko: '첫 세션 이름 (선택)', en: 'First session name (optional)' })}" autocomplete="off" value="${esc(draft.label)}" />
    <button class="primary" type="submit">${tr({ ko: '프로젝트 추가', en: 'Add project' })}</button>
    <button type="button" data-act="cancel-new">${tr({ ko: '취소', en: 'Cancel' })}</button>
  </form>`;

export function renderProjects(st: UIState, send: Send) {
  const projects = st.snap.projects ?? [];
  const hosts = st.snap.hosts ?? [];
  const logKey = projects.flatMap((p) => p.sessions.map((s) => `${s.id}:${(st.logs.get(s.id) ?? []).length}`));
  if (!changed('projects', [projects, hosts, openSession, addingOn, dirsByHost.get(addingOn ?? '')?.length, logKey, Math.floor(Date.now() / 15000)])) return;

  // the tab is rebuilt as a whole: carry what is being typed into the add-project form, and where the cursor was
  const box = $('projects');
  const old = box.querySelector<HTMLFormElement>('form.pnew');
  const focused = old && document.activeElement instanceof HTMLInputElement && old.contains(document.activeElement) ? document.activeElement.name : null;
  if (old) for (const k of ['dir', 'name', 'label'] as const) draft[k] = (old.elements.namedItem(k) as HTMLInputElement).value;

  const groups = groupByHost(hosts, projects);
  box.innerHTML = groups.length
    ? groups
        .map(
          (g) => `<section class="phost" data-host="${esc(g.host?.id ?? '')}">
        ${g.host ? hostHead(g.host) : `<header class="phost-head"><b>${tr({ ko: '설정에 없는 서버', en: 'Servers no longer in the config' })}</b></header>`}
        ${g.host && addingOn === g.host.id ? addForm(g.host.id) : ''}
        ${g.projects.map((p) => projectCard(st, p)).join('')}
        ${g.projects.length || (g.host && addingOn === g.host.id) ? '' : `<p class="muted small phost-empty">${tr({ ko: '프로젝트가 없습니다. “+ 프로젝트”로 이 서버의 폴더를 추가하세요.', en: 'No projects. Add a folder on this server with “+ Project”.' })}</p>`}
      </section>`,
        )
        .join('')
    : `<p class="muted hint">${tr({ ko: '세션을 돌릴 서버가 없습니다. office.local.yaml의 hosts에 추가하세요.', en: 'No servers to run sessions on. Add one under hosts in office.local.yaml.' })}</p>`;

  const form = box.querySelector<HTMLFormElement>('form.pnew');
  if (form && focused) (form.elements.namedItem(focused) as HTMLInputElement | null)?.focus();
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const val = (k: string) => (form.elements.namedItem(k) as HTMLInputElement).value.trim();
    if (!val('dir')) return;
    send({ t: 'createProject', hostId: form.dataset.host!, name: val('name'), dir: val('dir'), label: val('label') || undefined });
    draft.dir = draft.name = draft.label = '';
    addingOn = null;
    renderProjects(st, send);
  });
  form?.querySelector('[data-act="cancel-new"]')?.addEventListener('click', () => {
    draft.dir = draft.name = draft.label = '';
    addingOn = null;
    renderProjects(st, send);
  });

  box.querySelectorAll<HTMLElement>('.phost').forEach((sec) => {
    const hostId = sec.dataset.host!;
    sec.querySelector('[data-act="new-project"]')?.addEventListener('click', () => {
      if (addingOn !== hostId) draft.dir = draft.name = draft.label = '';
      addingOn = addingOn === hostId ? null : hostId;
      if (addingOn && !dirsByHost.has(hostId)) send({ t: 'listHostDirs', hostId }); // folder suggestions, over the shared connection
      renderProjects(st, send);
      box.querySelector<HTMLInputElement>('form.pnew input[name="dir"]')?.focus();
    });
    sec.querySelector('[data-act="recheck"]')?.addEventListener('click', () => send({ t: 'recheckHost', hostId }));
    sec.querySelector('[data-act="disconnect"]')?.addEventListener('click', () => {
      const h = hosts.find((x) => x.id === hostId);
      if (confirm(tr({ ko: `${h ? plain(h.name) : hostId} 접속을 끊을까요? 쉬고 있는 세션도 닫히고, 다음에 쓸 때 다시 연결합니다.`, en: `Disconnect ${h ? plain(h.name) : hostId}? Idle sessions close too, and it reconnects the next time it is used.` }))) send({ t: 'disconnectHost', hostId });
    });
  });

  box.querySelectorAll<HTMLElement>('.pcard').forEach((card) => {
    const id = card.dataset.project!;
    card.querySelector('[data-act="add"]')?.addEventListener('click', () => {
      const label = prompt(tr({ ko: '새 세션 이름 (비우면 "세션 N")', en: 'New session name (empty = "Session N")' }), '')?.trim();
      if (label === undefined) return; // cancelled
      send({ t: 'addProjectSession', projectId: id, label: label || undefined });
    });
    card.querySelector('[data-act="archive"]')?.addEventListener('click', () => {
      if (confirm(tr({ ko: '이 프로젝트를 보관할까요? 열려 있는 세션이 모두 닫힙니다. (폴더는 그대로입니다)', en: 'Archive this project? All open sessions will close. (The folder stays as it is.)' }))) send({ t: 'archiveProject', id });
    });
  });

  $('projects').querySelectorAll<HTMLElement>('.psession').forEach((el) => {
    const id = el.dataset.id!;
    el.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      openSession = openSession === id ? null : id;
      if (openSession) send({ t: 'getLogs', employeeId: id });
      renderProjects(st, send);
    });
    el.querySelector('[data-act="office"]')?.addEventListener('click', () => {
      const cur = (st.snap.projects ?? []).flatMap((p) => p.sessions).find((x) => x.id === id);
      send({ t: 'setSessionInOffice', id, inOffice: !(cur && cur.desk >= 0) });
    });
    el.querySelector('[data-act="stop"]')?.addEventListener('click', () => send({ t: 'stop', employeeId: id }));
    el.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      if (confirm(tr({ ko: '이 세션을 닫을까요? 대화 기록이 사라집니다. (폴더의 파일은 그대로입니다)', en: 'Close this session? Its conversation history will be lost. (Files in the folder stay.)' }))) send({ t: 'closeProjectSession', id });
    });
    const form = el.querySelector<HTMLFormElement>('.psend');
    const input = form?.querySelector('textarea');
    const submit = () => {
      const text = input!.value.trim();
      if (!text) return;
      send({ t: 'instruct', employeeId: id, text });
      input!.value = '';
    };
    form?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });
    input?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        submit();
      }
    });
    const log = el.querySelector<HTMLElement>('.plog');
    // the whole tab is redrawn (also every 15 s), so keep the reader's place instead of yanking them down
    if (log) followBottom(`plog:${id}`, log, (st.logs.get(id) ?? []).length);
  });
}
