import { tr } from '../../../shared/i18n.ts';
import type { UpdateView } from '../../../shared/protocol.ts';
import { type Send, type UIState, ago, esc } from './panels.ts';

/**
 * The "new version" pill in the top bar and its dialog: which commits the remote has that this office lacks,
 * and a button that runs the update script on the backend (when it can restart itself).
 */
let dlg: HTMLDialogElement | null = null;
let lastKey = '';
/** the version the page was loaded with: a different one after a reconnect means the web files changed too */
let loadedVersion: string | null = null;

/** After a snapshot: true when the backend now runs another version than the one this page came from. */
export function versionChanged(u: UpdateView | undefined): boolean {
  const v = u?.version ?? null;
  if (!v) return false;
  if (!loadedVersion) {
    loadedVersion = v;
    return false;
  }
  return v !== loadedVersion;
}

/** The pill for the top bar: loud when the remote is ahead, otherwise just the version, which opens the dialog and checks now. */
export function updatePill(u: UpdateView | undefined): string {
  if (!u) return '';
  if (u.running) return `<button type="button" class="pill warn" data-update>⬆ ${tr({ ko: '업데이트 중…', en: 'Updating…' })}</button>`;
  if (u.behind > 0)
    return `<button type="button" class="pill update-pill" data-update title="${esc(tr({ ko: '눌러서 바뀐 내용 보기', en: 'Click to see what changed' }))}">⬆ ${tr({ ko: '새 버전', en: 'New version' })} <b>${u.behind}</b></button>`;
  if (!u.version) return ''; // not a git checkout: nothing to update from
  return `<button type="button" class="pill muted version-pill" data-update title="${esc(tr({ ko: '지금 버전. 눌러서 새 버전이 있는지 확인', en: 'The running version. Click to check for a newer one' }))}">${esc(u.version)}</button>`;
}

export function openUpdate(st: UIState, send: Send) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'exp-dialog update-dialog';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) dlg!.close();
    });
  }
  lastKey = '';
  renderUpdate(st, send);
  if (!dlg.open) dlg.showModal();
  // opening it is asking: look at the remote now instead of waiting for the half-hourly check
  if (!st.snap.update?.running) send({ t: 'checkUpdate' });
}

export function renderUpdate(st: UIState, send: Send) {
  if (!dlg || (!dlg.open && lastKey)) return;
  const u = st.snap.update;
  if (!u) return;
  const busy = st.snap.employees.filter((e) => !['idle', 'done', 'error'].includes(e.status)).length;
  const key = JSON.stringify([u, busy, st.snap.language]);
  if (key === lastKey) return;
  lastKey = key;
  const checked = u.checkedAt ? tr({ ko: `${ago(u.checkedAt)} 전 확인`, en: `checked ${ago(u.checkedAt)} ago` }) : tr({ ko: '아직 확인 안 함', en: 'not checked yet' });
  const status = !u.ok && u.checkedAt
    ? tr({ ko: '원격 저장소를 확인하지 못했습니다 (오프라인이거나 추적하는 브랜치가 없음).', en: 'Could not look at the remote (offline, or no upstream branch).' })
    : u.behind
      ? tr({ ko: `새 커밋 ${u.behind}개가 있습니다.`, en: `${u.behind} new commit${u.behind > 1 ? 's' : ''}.` })
      : tr({ ko: '최신 버전입니다.', en: 'Up to date.' });
  const action = u.running
    ? `<p>${tr({ ko: '업데이트 중입니다. 끝나면 서버가 다시 시작되고 이 화면이 새로 열립니다.', en: 'Updating. When it is done the backend restarts and this page reloads.' })}</p>`
    : !u.behind
      ? ''
      : !u.canRestart
        ? `<p class="muted">${tr({
            ko: '이 환경에서는 화면에서 다시 시작할 수 없습니다 (systemd 서비스로 돌고 있지 않음). 터미널에서 <code>npm run update</code>를 실행하고 서버를 직접 다시 시작하세요.',
            en: 'This setup cannot restart itself from the screen (it is not running as the systemd service). Run <code>npm run update</code> in a terminal and restart the backend yourself.',
          })}</p>`
        : `<p>${
            busy
              ? tr({ ko: `지금 ${busy}명이 일하고 있습니다. 다시 시작하면 하던 일이 끊기므로 끝난 뒤에 누르세요.`, en: `${busy} ${busy > 1 ? 'employees are' : 'employee is'} working now. A restart would cut that off, so wait until they finish.` })
              : tr({ ko: '받아서 빌드한 뒤 서버를 다시 시작합니다. 1분쯤 걸리고, 그동안 화면이 잠깐 끊깁니다.', en: 'Pulls, builds and restarts the backend. Takes about a minute; the page disconnects briefly.' })
          }</p>
          <button type="button" class="primary" id="upd-apply" ${busy ? 'disabled' : ''}>⬆ ${tr({ ko: '업데이트', en: 'Update' })}</button>`;
  dlg.innerHTML = `
    <div class="exp-head">
      <h2>⬆ ${tr({ ko: '버전', en: 'Version' })} <code>${esc(u.version ?? '—')}</code></h2>
      <span class="muted small">${checked}</span>
      <button type="button" id="upd-check" ${u.running ? 'disabled' : ''}>${tr({ ko: '다시 확인', en: 'Check again' })}</button>
      <button type="button" id="upd-close" title="Esc">✕</button>
    </div>
    <p>${status}</p>
    ${u.commits.length ? `<ul class="update-commits">${u.commits.map((c) => `<li>${esc(c)}</li>`).join('')}${u.behind > u.commits.length ? `<li class="muted">… +${u.behind - u.commits.length}</li>` : ''}</ul>` : ''}
    ${action}
    ${u.log.length ? `<pre class="update-log">${esc(u.log.join('\n'))}</pre>` : ''}`;
  dlg.querySelector('#upd-close')!.addEventListener('click', () => dlg!.close());
  dlg.querySelector('#upd-check')!.addEventListener('click', () => send({ t: 'checkUpdate' }));
  dlg.querySelector('#upd-apply')?.addEventListener('click', () => {
    if (confirm(tr({ ko: '지금 업데이트하고 서버를 다시 시작할까요?', en: 'Update now and restart the backend?' }))) send({ t: 'applyUpdate' });
  });
  const log = dlg.querySelector<HTMLElement>('.update-log');
  if (log) log.scrollTop = log.scrollHeight;
}
