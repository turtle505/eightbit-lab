// Projects tab: folders on a host, each holding several independent Claude Code sessions.
import { followBottom } from './follow.ts';
import type { EmployeeView, ProjectView } from '../../../shared/protocol.ts';
import { locale, tr } from '../../../shared/i18n.ts';
import { $, type Send, type UIState, ago, changed, esc, plain, statusLabel } from './panels.ts';

/** folders offered in the new-project picker, per host (filled by a `hostDirs` reply) */
const dirsByHost = new Map<string, string[]>();
let openSession: string | null = null;

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
      <b>${esc(p.name)}</b>
      <span class="muted small">${esc(host ? plain(host.name) : p.hostId)} · ${esc(p.dir)}</span>
      <span class="grow"></span>
      <button type="button" data-act="add">${tr({ ko: '+ 세션', en: '+ Session' })}</button>
      <button type="button" data-act="archive" title="${tr({ ko: '프로젝트 보관 (세션 모두 닫힘)', en: 'Archive the project (closes all sessions)' })}">${tr({ ko: '보관', en: 'Archive' })}</button>
    </header>
    ${p.sessions.length ? p.sessions.map((s) => sessionCard(st, s)).join('') : `<p class="muted small">${tr({ ko: '세션이 없습니다. “+ 세션”을 누르세요.', en: 'No sessions. Press “+ Session”.' })}</p>`}
  </section>`;
}

export function renderProjects(st: UIState, send: Send) {
  const projects = st.snap.projects ?? [];
  const hosts = st.snap.hosts ?? [];
  const logKey = projects.flatMap((p) => p.sessions.map((s) => `${s.id}:${(st.logs.get(s.id) ?? []).length}`));
  if (!changed('projects', [projects, hosts, openSession, logKey, Math.floor(Date.now() / 15000)])) return;

  const hostOpts = hosts.map((h) => `<option value="${esc(h.id)}"${h.ok ? '' : ' disabled'}>${esc(plain(h.name))}${h.ok ? '' : tr({ ko: ' (연결 안 됨)', en: ' (unreachable)' })}</option>`).join('');
  $('projects').innerHTML = `
    <form id="pnew" class="pnew">
      <select id="pnew-host">${hostOpts}</select>
      <input id="pnew-dir" list="pnew-dirs" placeholder="${tr({ ko: '폴더 (예: bio2token)', en: 'Folder (e.g. bio2token)' })}" autocomplete="off" />
      <datalist id="pnew-dirs"></datalist>
      <input id="pnew-name" placeholder="${tr({ ko: '이름 (비우면 폴더 이름)', en: 'Name (empty = folder name)' })}" autocomplete="off" />
      <input id="pnew-label" placeholder="${tr({ ko: '첫 세션 이름 (선택)', en: 'First session name (optional)' })}" autocomplete="off" />
      <button class="primary" type="submit">${tr({ ko: '프로젝트 추가', en: 'Add project' })}</button>
    </form>
    ${projects.length ? projects.map((p) => projectCard(st, p)).join('') : `<p class="muted hint">${tr({
          ko: '프로젝트가 없습니다. 위에서 호스트와 폴더를 골라 추가하세요. 프로젝트마다 세션을 여러 개 띄울 수 있습니다.',
          en: 'No projects. Pick a host and a folder above to add one. Each project can run several sessions.',
        })}</p>`}`;

  const hostSel = $('pnew-host') as HTMLSelectElement;
  const fillDirs = () => {
    const dirs = dirsByHost.get(hostSel.value);
    if (!dirs) return send({ t: 'listHostDirs', hostId: hostSel.value });
    ($('pnew-dirs') as HTMLDataListElement).innerHTML = dirs.map((d) => `<option value="${esc(d)}"></option>`).join('');
  };
  hostSel.addEventListener('change', fillDirs);
  fillDirs();

  $('pnew').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const dir = ($('pnew-dir') as HTMLInputElement).value.trim();
    if (!dir) return;
    send({
      t: 'createProject',
      hostId: hostSel.value,
      name: ($('pnew-name') as HTMLInputElement).value.trim(),
      dir,
      label: ($('pnew-label') as HTMLInputElement).value.trim() || undefined,
    });
    for (const f of ['pnew-dir', 'pnew-name', 'pnew-label']) ($(f) as HTMLInputElement).value = '';
  });

  $('projects').querySelectorAll<HTMLElement>('.pcard').forEach((card) => {
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
