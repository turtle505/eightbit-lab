// Reports tab: a file-browser view over the .md reports employees saved, rendered as markdown.
import type { ReportFile } from '../../../shared/protocol.ts';
import { getLang, locale, tr } from '../../../shared/i18n.ts';
import { renderMd, resolveMdLink } from './markdown.ts';
import { $, type Send, type UIState, changed, esc, short } from './panels.ts';

const SEEN_KEY = 'eightbit-lab:reports-seen';

let openPath: string | null = null;
let loaded: { path: string; content: string; mtime: number } | null = null;
let requested: { path: string; mtime: number } | null = null;
let raw = false;
let filter = '';
const collapsed = new Set<string>();
let seenVersion = 0;
let renderedPath: string | null = null;

// ---- read state (per browser; a convenience, so failures just mean "everything looks read")
let seen: Record<string, number> | null = null;
function loadSeen(reports: ReportFile[]): Record<string, number> {
  if (seen) return seen;
  try {
    const s = localStorage.getItem(SEEN_KEY);
    if (s) return (seen = JSON.parse(s));
  } catch {
    /* storage unavailable */
  }
  // first visit: whatever exists now counts as read
  seen = Object.fromEntries(reports.map((r) => [r.path, r.mtime]));
  saveSeen();
  return seen;
}
function saveSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}
function markSeen(path: string, mtime: number) {
  if (!seen || seen[path] === mtime) return;
  seen[path] = mtime;
  seenVersion++;
  saveSeen();
}
const isUnread = (r: ReportFile, s: Record<string, number>) => s[r.path] !== r.mtime;

export function unreadReports(st: UIState): number {
  const s = loadSeen(st.snap.reports);
  return st.snap.reports.filter((r) => isUnread(r, s)).length;
}

// ---- opening files
let sendFn: Send = () => {};
let goReports: () => void = () => {};

/** Called once from main: how to talk to the server and how to switch to this tab. */
export function initReports(send: Send, showReportsView: () => void) {
  sendFn = send;
  goReports = showReportsView;
  const m = location.hash.match(/^#r=(.+)$/);
  if (m) openPath = decodeURIComponent(m[1]);
}

export function openReport(path: string) {
  openPath = path;
  history.replaceState(null, '', `${location.pathname}${location.search}#r=${encodeURIComponent(path)}`);
  goReports();
}

export function onReportContent(path: string, content: string, mtime: number) {
  loaded = { path, content, mtime };
  if (requested?.path === path) requested = null;
  if (path === openPath) markSeen(path, mtime);
}

const fmt = (ts: number) =>
  new Date(ts).toLocaleString(locale(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

interface Dir {
  name: string;
  key: string;
  dirs: Map<string, Dir>;
  files: ReportFile[];
  latest: number;
}

/** group by topic folder (whoever's desk it is on) instead of by desk */
let byTopic = false;
try {
  byTopic = localStorage.getItem('office.reports.byTopic') === '1';
} catch {
  /* storage unavailable: by desk */
}

function buildTree(reports: ReportFile[]): Dir {
  const root: Dir = { name: '', key: '', dirs: new Map(), files: [], latest: 0 };
  for (const r of reports) {
    // the root label ("secretary/reports") is one node; folders below it are nested
    const rest = r.path.slice(r.root.length + 1).split('/');
    // by topic: one node per topic with its sub-folders under it; everything without a topic under "(no topic)", by desk
    const noTopic = tr({ ko: '(주제 없음)', en: '(no topic)' });
    const segs = !byTopic ? [r.root, ...rest.slice(0, -1)] : r.topic ? [`# ${r.topic}`, ...rest.slice(rest.indexOf(r.topic) + 1, -1)] : [noTopic, r.root, ...rest.slice(0, -1)];
    let d = root;
    for (const seg of segs) {
      const key = d.key ? `${d.key}/${seg}` : seg;
      if (!d.dirs.has(seg)) d.dirs.set(seg, { name: seg, key, dirs: new Map(), files: [], latest: 0 });
      d = d.dirs.get(seg)!;
      d.latest = Math.max(d.latest, r.mtime);
    }
    d.files.push(r);
  }
  return root;
}

function fileRow(r: ReportFile, s: Record<string, number>, showDir: boolean): string {
  const name = r.path.split('/').pop()!;
  const dir = showDir ? r.path.slice(0, r.path.length - name.length - 1) : '';
  return `<button class="rp-file ${r.path === openPath ? 'sel' : ''} ${isUnread(r, s) ? 'unread' : ''}" data-path="${esc(r.path)}" title="${esc(r.path)}">
    <span class="rp-dot"></span>
    <span class="rp-name"><b>${esc(r.title)}</b><span class="muted small">${esc(showDir ? dir + '/' : '')}${esc(name)} · ${esc(fmt(r.mtime))}</span></span>
  </button>`;
}

function dirHtml(d: Dir, s: Record<string, number>): string {
  const dirs = [...d.dirs.values()].sort((a, b) => b.latest - a.latest);
  const files = [...d.files].sort((a, b) => b.mtime - a.mtime);
  return (
    dirs
      .map((c) => {
        const unread = countUnread(c, s);
        return `<details class="rp-dir" data-key="${esc(c.key)}" ${collapsed.has(c.key) ? '' : 'open'}>
          <summary>📁 ${esc(c.name)}${unread ? ` <span class="rp-badge">${unread}</span>` : ''}</summary>
          <div class="rp-children">${dirHtml(c, s)}</div>
        </details>`;
      })
      .join('') + files.map((f) => fileRow(f, s, false)).join('')
  );
}

function countUnread(d: Dir, s: Record<string, number>): number {
  let n = d.files.filter((f) => isUnread(f, s)).length;
  for (const c of d.dirs.values()) n += countUnread(c, s);
  return n;
}

/** language the side panel's labels were drawn in */
let shellLang = '';

export function renderReports(st: UIState) {
  const reports = st.snap.reports;
  const s = loadSeen(reports);
  const box = $('view-reports');
  if (!box.querySelector('#rp-tree')) {
    box.innerHTML = `<aside class="panel rp-side">
        <div class="row space"><h2 id="rp-h"></h2><a id="rp-newwin" class="small" href="?view=reports" target="_blank" rel="noopener"></a></div>
        <input id="rp-filter" autocomplete="off" />
        <label class="small rp-bytopic"><input type="checkbox" id="rp-bytopic" /> <span id="rp-bytopic-label"></span></label>
        <div id="rp-tree" class="rp-tree"></div>
      </aside>
      <section class="panel rp-main" id="rp-viewer"></section>`;
    const f = $('rp-filter') as HTMLInputElement;
    f.addEventListener('input', () => {
      filter = f.value.trim().toLowerCase();
      renderReports(st);
    });
    const bt = $('rp-bytopic') as HTMLInputElement;
    bt.checked = byTopic;
    bt.addEventListener('change', () => {
      byTopic = bt.checked;
      try {
        localStorage.setItem('office.reports.byTopic', byTopic ? '1' : '0');
      } catch {
        /* not remembered */
      }
      renderReports(st);
    });
    const tree = $('rp-tree');
    tree.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.rp-file');
      if (b) openReport(b.dataset.path!);
    });
    tree.addEventListener(
      'toggle',
      (ev) => {
        const d = ev.target as HTMLDetailsElement;
        if (!d.classList?.contains('rp-dir')) return;
        if (d.open) collapsed.delete(d.dataset.key!);
        else collapsed.add(d.dataset.key!);
      },
      true,
    );
    shellLang = '';
    $('rp-viewer').addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const a = t.closest<HTMLAnchorElement>('a[data-md-link]');
      if (a && openPath) {
        ev.preventDefault();
        const target = resolveMdLink(openPath, a.dataset.mdLink!);
        if (st.snap.reports.some((r) => r.path === target)) openReport(target);
        else alert(tr({ ko: `보고서 목록에 없는 파일입니다: ${target}`, en: `Not in the report list: ${target}` }));
        return;
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'raw') {
        raw = !raw;
        renderViewer(st, true);
      } else if (act === 'reload' && openPath) {
        requested = null;
        loaded = null;
        renderViewer(st, true);
      }
    });
  }

  if (shellLang !== getLang()) {
    shellLang = getLang();
    $('rp-h').textContent = tr({ ko: '보고서', en: 'Reports' });
    const a = $('rp-newwin');
    a.textContent = tr({ ko: '새 창 ↗', en: 'New window ↗' });
    a.title = tr({ ko: '보고서 창을 새 브라우저 창으로 열기', en: 'Open the reports in a new browser window' });
    ($('rp-filter') as HTMLInputElement).placeholder = tr({ ko: '제목·파일명 검색', en: 'Search titles and file names' });
    $('rp-bytopic-label').textContent = tr({ ko: '주제별로 보기', en: 'Group by topic' });
  }

  if (changed('rp-tree', [reports, filter, openPath, seenVersion, [...collapsed], byTopic])) {
    const q = filter;
    const tree = $('rp-tree');
    if (!reports.length) {
      tree.innerHTML = `<p class="muted small">${tr({
        ko: '아직 보고서가 없습니다. 직원들이 <code>workspaces/&lt;직원 폴더&gt;/reports/</code> 아래에 .md 파일을 저장하면 여기에 나타납니다.',
        en: 'No reports yet. They appear here when employees save .md files under <code>workspaces/&lt;desk folder&gt;/reports/</code>.',
      })}</p>`;
    } else if (q) {
      const hits = reports.filter((r) => r.title.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
      tree.innerHTML = hits.length ? hits.map((r) => fileRow(r, s, true)).join('') : `<p class="muted small">${tr({ ko: '검색 결과가 없습니다.', en: 'No matches.' })}</p>`;
    } else {
      tree.innerHTML = dirHtml(buildTree(reports), s);
    }
  }
  renderViewer(st, false);
}

function renderViewer(st: UIState, force: boolean) {
  const view = $('rp-viewer');
  const file = openPath ? st.snap.reports.find((r) => r.path === openPath) : undefined;
  // fetch when nothing is loaded for this file or it changed on disk
  if (file && (!loaded || loaded.path !== file.path || loaded.mtime !== file.mtime) && !(requested?.path === file.path && requested.mtime === file.mtime)) {
    requested = { path: file.path, mtime: file.mtime };
    sendFn({ t: 'getReport', path: file.path });
  }
  const content = loaded && file && loaded.path === file.path ? loaded : null;
  if (!force && !changed('rp-viewer', [openPath, !!file, content?.mtime, content?.content.length, raw, st.snap.employees.length])) return;
  if (!openPath) {
    view.innerHTML = `<p class="muted">${tr({ ko: '왼쪽에서 보고서를 고르세요.', en: 'Pick a report on the left.' })}</p>`;
    return;
  }
  if (!file) {
    view.innerHTML = `<p class="muted">${esc(openPath)} — ${tr({ ko: '목록에 없는 파일입니다 (삭제되었거나 아직 스캔되지 않음).', en: 'not in the list (deleted, or not scanned yet).' })}</p>`;
    return;
  }
  const who = file.employeeId ? st.snap.employees.find((e) => e.id === file.employeeId) : undefined;
  const head = `<div class="rp-head">
      <div><b>${esc(file.title)}</b><div class="muted small">${esc(file.path)} · ${esc(fmt(file.mtime))}${who ? ` · ${esc(short(who.name))}` : ''}</div></div>
      <div class="row"><button data-act="raw">${raw ? tr({ ko: '렌더링 보기', en: 'Rendered' }) : tr({ ko: '원문 보기', en: 'Source' })}</button><button data-act="reload">${tr({ ko: '새로고침', en: 'Reload' })}</button></div>
    </div>`;
  if (!content) {
    view.innerHTML = head + `<p class="muted">${tr({ ko: '불러오는 중…', en: 'Loading…' })}</p>`;
    return;
  }
  // keep the reading position when the same file re-renders (e.g. it changed on disk)
  const scroll = renderedPath === file.path ? (view.querySelector('.rp-body')?.scrollTop ?? 0) : 0;
  renderedPath = file.path;
  view.innerHTML = head + (raw ? `<pre class="rp-body rp-raw">${esc(content.content)}</pre>` : `<article class="rp-body md-body">${renderMd(content.content)}</article>`);
  const body = view.querySelector('.rp-body');
  if (body) body.scrollTop = scroll;
}
