// 📨 Report box: report files and finished-run results, appended like a chat (newest at the bottom), in markdown.
import type { FeedItem } from '../../../shared/protocol.ts';
import { getLang, locale, tr } from '../../../shared/i18n.ts';
import { renderMd } from './markdown.ts';
import { $, type UIState, changed, esc, ico, short } from './panels.ts';
import { openReport } from './reports.ts';

let who = '';
const expanded = new Set<number>();
const SHOWN = 60;

const hhmm = (ts: number) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(locale(), today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const moreLabel = (open: boolean) => (open ? tr({ ko: '접기', en: 'Less' }) : tr({ ko: '더 보기', en: 'More' }));
/** language the box's header was drawn in */
let shellLang = '';

function card(f: FeedItem, st: UIState): string {
  const emp = f.employeeId ? st.snap.employees.find((e) => e.id === f.employeeId) : undefined;
  const name = emp ? short(emp.name) : (f.employeeId ?? '');
  const isReport = f.kind === 'report';
  const label = isReport ? `${ico('📄')}${esc(f.title)}` : esc(f.title);
  const open = expanded.has(f.id);
  return `<div class="rf-item ${isReport ? 'rf-report' : 'rf-result'} ${f.ok ? '' : 'rf-fail'}" data-id="${f.id}">
    <div class="rf-head">
      <span><b>${esc(name)}</b> <span class="muted small">${esc(hhmm(f.ts))}</span>${f.ok ? '' : ` <span class="small bad">${tr({ ko: '⚠️ 실패', en: '⚠️ Failed' })}</span>`}</span>
      ${isReport && f.path ? `<button class="rf-open" data-path="${esc(f.path)}" title="${esc(f.path)}">${tr({ ko: '보고서 탭에서 열기', en: 'Open in Reports' })}</button>` : ''}
    </div>
    <div class="rf-title small">${label}${isReport && f.path ? ` <span class="muted">· ${esc(f.path)}</span>` : ''}</div>
    <div class="rf-body md-body ${open ? 'open' : ''}">${renderMd(f.body)}</div>
    <button class="rf-more link small" data-act="more" hidden>${moreLabel(open)}</button>
  </div>`;
}

export function renderReportFeed(st: UIState) {
  const box = $('report-feed');
  if (!box.querySelector('#rf-list')) {
    box.innerHTML = `<div class="row space"><h2>${ico('📨')}<span id="rf-h"></span></h2><select id="rf-who"></select></div>
      <div id="rf-list" class="rf-list"></div>`;
    shellLang = '';
    ($('rf-who') as HTMLSelectElement).addEventListener('change', (ev) => {
      who = (ev.target as HTMLSelectElement).value;
      renderReportFeed(st);
    });
    $('rf-list').addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const openBtn = t.closest<HTMLElement>('.rf-open');
      if (openBtn) return openReport(openBtn.dataset.path!);
      if (t.closest('[data-act="more"]')) {
        const item = t.closest<HTMLElement>('.rf-item')!;
        const id = Number(item.dataset.id);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        item.querySelector('.rf-body')!.classList.toggle('open', expanded.has(id));
        t.textContent = moreLabel(expanded.has(id));
      }
    });
  }
  if (shellLang !== getLang()) {
    shellLang = getLang();
    $('rf-h').textContent = tr({ ko: '보고', en: 'Reports' });
    $('rf-who').title = tr({ ko: '직원별로 보기', en: 'Filter by employee' });
  }
  const emps = st.snap.employees;
  if (changed('rf-who', emps.map((e) => [e.id, e.name]))) {
    const sel = $('rf-who') as HTMLSelectElement;
    sel.innerHTML = `<option value="">${tr({ ko: '전체', en: 'Everyone' })}</option>` + [...emps].sort((a, b) => a.desk - b.desk).map((e) => `<option value="${esc(e.id)}">${esc(short(e.name))}</option>`).join('');
    sel.value = who;
  }
  const items = st.snap.feed.filter((f) => !who || f.employeeId === who).slice(-SHOWN);
  const list = $('rf-list');
  const visible = list.offsetParent !== null;
  if (changed('rf-list', [items.map((f) => [f.id, f.ts]), emps.map((e) => e.name)])) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = items.length
      ? items.map((f) => card(f, st)).join('')
      : `<p class="muted small">${tr({ ko: '보고서 파일이 저장되거나 직원의 실행이 끝나면 여기에 차례로 올라옵니다.', en: 'Saved report files and finished runs show up here in order.' })}</p>`;
    list.dataset.measured = '';
    if (visible && (atBottom || !list.dataset.init)) list.scrollTop = list.scrollHeight;
  }
  // sizes are only known while the box is on screen (it lives in the game or console view)
  if (visible && !list.dataset.measured) {
    // "More" only where the body is actually clipped
    list.querySelectorAll<HTMLElement>('.rf-item').forEach((el) => {
      const body = el.querySelector<HTMLElement>('.rf-body')!;
      const more = el.querySelector<HTMLElement>('[data-act="more"]')!;
      more.hidden = !body.classList.contains('open') && body.scrollHeight <= body.clientHeight + 4;
    });
    list.dataset.measured = '1';
    if (!list.dataset.init) {
      list.scrollTop = list.scrollHeight;
      list.dataset.init = '1';
    }
  }
}
