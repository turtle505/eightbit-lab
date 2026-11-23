// Projects tab: folders on a host, each holding several independent Claude Code sessions.
import type { EmployeeView, ProjectView } from '../../../shared/protocol.ts';
import { $, STATUS_KO, type Send, type UIState, ago, changed, esc, plain } from './panels.ts';

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
      <span class="badge b-${s.status}">${STATUS_KO[s.status] ?? s.status}</span>
      <span class="muted small">${s.live ? '🟢' : '⚪'}</span>
      <span class="muted small last">${esc(plain(last?.text ?? '아직 지시 없음').slice(0, 70))}</span>
      ${BUSY.includes(s.status) ? '<button type="button" data-act="stop">중지</button>' : ''}
      <button type="button" data-act="close" title="이 세션 닫기">✕</button>
    </div>
    ${
      open
        ? `<div class="plog">${lines
            .slice(-60)
            .map((l) => `<div class="line k-${l.kind}"><span class="ts">${new Date(l.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span><span class="txt">${esc(l.text)}</span></div>`)
            .join('')}</div>
           <form class="instruct psend"><textarea rows="2" placeholder="이 세션에 지시… (Enter 전송)"></textarea></form>`
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
      <button type="button" data-act="add">+ 세션</button>
      <button type="button" data-act="archive" title="프로젝트 보관 (세션 모두 닫힘)">보관</button>
    </header>
    ${p.sessions.length ? p.sessions.map((s) => sessionCard(st, s)).join('') : '<p class="muted small">세션이 없습니다. “+ 세션”을 누르세요.</p>'}
  </section>`;
}

export function renderProjects(st: UIState, send: Send) {
  const projects = st.snap.projects ?? [];
  const hosts = st.snap.hosts ?? [];
  const logKey = projects.flatMap((p) => p.sessions.map((s) => `${s.id}:${(st.logs.get(s.id) ?? []).length}`));
  if (!changed('projects', [projects, hosts, openSession, logKey, Math.floor(Date.now() / 15000)])) return;

  const hostOpts = hosts.map((h) => `<option value="${esc(h.id)}"${h.ok ? '' : ' disabled'}>${esc(plain(h.name))}${h.ok ? '' : ' (연결 안 됨)'}</option>`).join('');
  $('projects').innerHTML = `
    <form id="pnew" class="pnew">
      <select id="pnew-host">${hostOpts}</select>
      <input id="pnew-dir" list="pnew-dirs" placeholder="폴더 (예: bio2token)" autocomplete="off" />
      <datalist id="pnew-dirs"></datalist>
      <input id="pnew-name" placeholder="이름 (비우면 폴더 이름)" autocomplete="off" />
      <button class="primary" type="submit">프로젝트 추가</button>
    </form>
    ${projects.length ? projects.map((p) => projectCard(st, p)).join('') : '<p class="muted hint">프로젝트가 없습니다. 위에서 호스트와 폴더를 골라 추가하세요. 프로젝트마다 세션을 여러 개 띄울 수 있습니다.</p>'}`;

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
    send({ t: 'createProject', hostId: hostSel.value, name: ($('pnew-name') as HTMLInputElement).value.trim(), dir });
    ($('pnew-dir') as HTMLInputElement).value = '';
    ($('pnew-name') as HTMLInputElement).value = '';
  });

  $('projects').querySelectorAll<HTMLElement>('.pcard').forEach((card) => {
    const id = card.dataset.project!;
    card.querySelector('[data-act="add"]')?.addEventListener('click', () => send({ t: 'addProjectSession', projectId: id }));
    card.querySelector('[data-act="archive"]')?.addEventListener('click', () => {
      if (confirm('이 프로젝트를 보관할까요? 열려 있는 세션이 모두 닫힙니다. (폴더는 그대로입니다)')) send({ t: 'archiveProject', id });
    });
  });

  $('projects').querySelectorAll<HTMLElement>('.psession').forEach((el) => {
    const id = el.dataset.id!;
    el.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      openSession = openSession === id ? null : id;
      if (openSession) send({ t: 'getLogs', employeeId: id });
      renderProjects(st, send);
    });
    el.querySelector('[data-act="stop"]')?.addEventListener('click', () => send({ t: 'stop', employeeId: id }));
    el.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      if (confirm('이 세션을 닫을까요? 대화 기록이 사라집니다. (폴더의 파일은 그대로입니다)')) send({ t: 'closeProjectSession', id });
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
    const log = el.querySelector('.plog');
    if (log) log.scrollTop = log.scrollHeight;
  });
}
