// Search across reports, logs, task cards and the report feed (server/src/search.ts does the looking).
// One box in the top bar (Ctrl/⌘+K), results in a panel under it, grouped by kind.
import { hhmm, tr } from '../../../shared/i18n.ts';
import type { SearchHit } from '../../../shared/protocol.ts';
import { renderMd } from './markdown.ts';
import { esc, short, type Send, type UIState } from './panels.ts';

const $ = (id: string) => document.getElementById(id)!;

interface Hooks {
  send: Send;
  openReport: (path: string) => void;
  openTask: (taskId: number) => void;
  selectEmployee: (employeeId: string) => void;
}
let hooks: Hooks;
/** the query the panel is showing (or waiting for), and what came back */
let asked = '';
let hits: SearchHit[] | null = null;
/** hits opened to read in place, by index */
const open = new Set<number>();

const KINDS: SearchHit['kind'][] = ['report', 'task', 'experiment', 'log', 'feed'];
const kindLabel = (k: SearchHit['kind']) =>
  k === 'report' ? tr({ ko: '보고서', en: 'Reports' }) : k === 'task' ? tr({ ko: '작업', en: 'Tasks' }) : k === 'log' ? tr({ ko: '로그', en: 'Logs' }) : k === 'experiment' ? tr({ ko: '실험', en: 'Experiments' }) : tr({ ko: '보고 피드', en: 'Report feed' });
const logKindLabel = (k?: string) =>
  k === 'user' ? tr({ ko: '지시', en: 'instruction' }) : k === 'assistant' ? tr({ ko: '답변', en: 'reply' }) : k === 'tool' ? tr({ ko: '도구', en: 'tool' }) : k === 'error' ? tr({ ko: '오류', en: 'error' }) : (k ?? '');

/** Same rule as the server (search.ts `searchTokens`): lower-cased words; a single ASCII character is not one, a single Hangul syllable is. */
const wordsOf = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2 || (w.length === 1 && w.charCodeAt(0) > 0x7f)))].slice(0, 6);

/** The snippet as HTML: escaped, with the matched words in bold. */
export function highlight(text: string, words: string[]): string {
  const safe = esc(text);
  if (!words.length) return safe;
  const re = new RegExp(words.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return safe.replace(re, (m) => `<b>${m}</b>`);
}

const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
};

export function initSearch(h: Hooks) {
  hooks = h;
  const input = $('search-input') as HTMLInputElement;
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      const q = input.value.trim();
      if (wordsOf(q).length === 0) {
        asked = q;
        hits = [];
        open.clear();
        return render();
      }
      asked = q;
      hits = null;
      open.clear();
      hooks.send({ t: 'search', q });
      render();
    } else if (ev.key === 'Escape') {
      close();
      input.blur();
    }
  });
  // Ctrl/⌘+K from anywhere
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      input.focus();
      input.select();
      if (asked) render();
    }
  });
  // a click elsewhere closes the panel; the query stays in the box
  document.addEventListener('mousedown', (ev) => {
    if (!(ev.target as HTMLElement).closest('#search-box')) close();
  });
  input.addEventListener('focus', () => {
    if (asked) render();
  });
  $('search-panel').addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-hit]');
    if (!row || !hits) return;
    const i = Number(row.dataset.hit);
    const h = hits[i];
    if ((ev.target as HTMLElement).closest('[data-go]')) {
      // jump to where it lives
      if (h.kind === 'report' && h.path) hooks.openReport(h.path);
      else if (h.kind === 'task' && h.taskId != null) hooks.openTask(h.taskId);
      else if (h.kind === 'feed' && h.path) hooks.openReport(h.path);
      else if (h.employeeId) hooks.selectEmployee(h.employeeId);
      return close();
    }
    if (h.kind === 'report' && h.path) {
      hooks.openReport(h.path);
      return close();
    }
    // logs, tasks and feed items are read in place
    if (open.has(i)) open.delete(i);
    else open.add(i);
    render();
  });
  renderSearch();
}

function close() {
  $('search-panel').hidden = true;
}

export function onSearchResults(q: string, found: SearchHit[]) {
  if (q !== asked) return; // an answer to an older query
  hits = found;
  render();
}

/** Static labels (called on every render pass, so a language switch reaches them). */
export function renderSearch(_st?: UIState) {
  const input = $('search-input') as HTMLInputElement;
  const ph = tr({ ko: '기록 검색 (Ctrl/⌘+K)', en: 'Search the records (Ctrl/⌘+K)' });
  if (input.placeholder !== ph) {
    input.placeholder = ph;
    input.title = tr({ ko: '보고서 본문, 대화 로그, 작업, 보고 피드에서 찾기. 여러 낱말은 모두 들어 있는 것만.', en: 'Find in report text, logs, tasks and the report feed. Several words: all must occur.' });
    if (!$('search-panel').hidden) render();
  }
}

function render() {
  const panel = $('search-panel');
  panel.hidden = false;
  const words = wordsOf(asked);
  if (hits === null) {
    panel.innerHTML = `<p class="muted small">${tr({ ko: '찾는 중…', en: 'Searching…' })}</p>`;
    return;
  }
  if (!words.length) {
    panel.innerHTML = `<p class="muted small">${tr({ ko: '찾을 낱말을 넣어 주세요 (영문·숫자는 두 글자 이상).', en: 'Type a word to look for (at least two characters).' })}</p>`;
    return;
  }
  if (!hits.length) {
    panel.innerHTML = `<p class="muted small">${tr({ ko: `"${esc(asked)}"에 맞는 기록이 없습니다.`, en: `Nothing matches "${esc(asked)}".` })}</p>`;
    return;
  }
  const all = hits;
  panel.innerHTML = KINDS.map((kind) => {
    const rows = all.map((h, i) => ({ h, i })).filter((x) => x.h.kind === kind);
    if (!rows.length) return '';
    return `<section class="search-group"><h3>${kindLabel(kind)} <span class="muted">${rows.length}</span></h3>${rows
      .map(({ h, i }) => {
        const who = h.kind === 'log' ? `${esc(short(h.title))} · ${esc(logKindLabel(h.logKind))}` : esc(h.title);
        const go =
          h.kind === 'task'
            ? tr({ ko: '콘솔에서 보기', en: 'Show in console' })
            : h.kind === 'log'
              ? tr({ ko: '직원 보기', en: 'Show employee' })
              : h.kind === 'feed' && h.path
                ? tr({ ko: '보고서 열기', en: 'Open report' })
                : '';
        const body = open.has(i) && h.text ? `<div class="search-full md">${renderMd(h.text)}</div>` : '';
        return `<div class="search-hit" data-hit="${i}" role="button" tabindex="0">
          <div class="search-head"><b>${who}</b><span class="muted small">${day(h.ts)}</span>${go ? `<button type="button" class="link small" data-go="1">${go}</button>` : ''}</div>
          <div class="search-snippet">${highlight(h.snippet, words)}</div>${body}
        </div>`;
      })
      .join('')}</section>`;
  }).join('');
}
