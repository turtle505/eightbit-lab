// ✅ 오늘 할 일: checkbox items of today's Obsidian daily note — check, edit, add, delete in place.
import type { TodayTodos, TodoItem, TodoOp, TodoProject } from '../../../shared/protocol.ts';
import { renderInline } from './markdown.ts';
import { $, type Send, type UIState, changed, esc, ico } from './panels.ts';

const HIDE_KEY = 'eightbit-lab:todos-hide-done';

// line + raw text: if the note changes underneath (Obsidian, an agent), a moved line is detected instead of editing the wrong one
type Editing = { kind: 'edit'; line: number; raw: string } | { kind: 'add'; header: number; headerRaw: string; parent?: number; parentRaw?: string } | null;
let editing: Editing = null;
let hideDone = (() => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
})();
/** items whose descriptions are expanded, by text (line numbers shift as the note changes) */
const openNotes = new Set<string>();
let items = new Map<number, TodoItem>();
let headers = new Map<number, TodoProject>();
let pending = false;

const count = (list: TodoItem[]): [number, number] =>
  list.reduce<[number, number]>(
    ([d, t], it) => {
      const [cd, ct] = count(it.children);
      return [d + (it.checked ? 1 : 0) + cd, t + 1 + ct];
    },
    [0, 0],
  );

const visible = (it: TodoItem): boolean => !hideDone || !it.checked || it.children.some(visible);

function editor(value: string, placeholder: string): string {
  return `<form class="td-edit"><input name="t" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />
    <button class="primary" type="submit">저장</button><button type="button" data-act="cancel">취소</button></form>`;
}

function itemHtml(it: TodoItem): string {
  items.set(it.line, it);
  const isEditing = editing?.kind === 'edit' && editing.line === it.line;
  const notesOpen = openNotes.has(it.text);
  const kids = it.children.filter(visible);
  const addingChild = editing?.kind === 'add' && editing.parent === it.line;
  return `<li class="td-item ${it.checked ? 'done' : ''}" data-line="${it.line}">
    <div class="td-row">
      <input type="checkbox" data-act="toggle" ${it.checked ? 'checked' : ''} ${pending ? 'disabled' : ''} title="완료 체크" />
      ${
        isEditing
          ? editor(it.text, '할 일')
          : `<span class="td-text" data-act="edit" title="더블클릭해서 수정">${renderInline(it.text)}</span>
        ${it.carry ? `<span class="td-carry ${it.carry >= 3 ? 'late' : ''}" title="${it.carry}번 이월됨">↻${it.carry}</span>` : ''}
        ${it.notes.length ? `<button class="link small td-notes-btn" data-act="notes">${notesOpen ? '▾' : '▸'} 설명 ${it.notes.length}</button>` : ''}
        <span class="td-actions"><button data-act="edit" title="수정">✏️</button><button data-act="sub" title="하위 할 일 추가">↳</button><button data-act="del" title="삭제">🗑️</button></span>`
      }
    </div>
    ${notesOpen && it.notes.length ? `<ul class="td-notes">${it.notes.map((n) => `<li style="margin-left:${n.depth * 14}px">${renderInline(n.text)}</li>`).join('')}</ul>` : ''}
    ${kids.length || addingChild ? `<ul class="td-list">${kids.map(itemHtml).join('')}${addingChild ? `<li class="td-item">${editor('', '하위 할 일')}</li>` : ''}</ul>` : ''}
  </li>`;
}

function projectHtml(p: TodoProject, vault: string, fallbackTitle: string): string {
  headers.set(p.line, p);
  const shown = p.items.filter(visible);
  const [d, t] = count(p.items);
  const adding = editing?.kind === 'add' && editing.header === p.line && editing.parent == null;
  const name = p.name || fallbackTitle;
  const title = p.link
    ? `<a href="obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(p.link)}" title="Obsidian에서 열기">${esc(name)}</a>`
    : esc(name);
  return `<div class="td-proj" data-header="${p.line}">
    <div class="td-proj-head"><b>${title}</b> <span class="muted small">${d}/${t}</span><button class="link small" data-act="add" title="할 일 추가">＋ 추가</button></div>
    ${p.memo.filter((m) => !/^\[\[.*\]\]$/.test(m)).map((m) => `<div class="muted small td-memo">${renderInline(m)}</div>`).join('')}
    <ul class="td-list">${shown.map(itemHtml).join('')}${adding ? `<li class="td-item">${editor('', '새 할 일')}</li>` : ''}</ul>
    ${t && !shown.length && !adding ? '<div class="muted small">✓ 모두 완료</div>' : ''}
  </div>`;
}

export function renderTodos(st: UIState, send: Send) {
  const td = st.snap.todos;
  const box = $('todos');
  box.hidden = !td?.enabled;
  if (!td?.enabled) return;
  if (!box.dataset.bound) bind(box, st, send);

  const form = box.querySelector<HTMLInputElement>('.td-edit input');
  const draft = form ? { value: form.value, focused: document.activeElement === form } : null;
  if (!changed('todos', [td, editing, hideDone, [...openNotes], pending])) return;

  items = new Map();
  headers = new Map();
  const d = new Date(`${td.date}T00:00:00`);
  const dateLabel = td.date ? d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }) : '';
  const all = td.sections.flatMap((s) => s.projects.flatMap((p) => p.items));
  const [done, total] = count(all);
  const openHref = `obsidian://open?vault=${encodeURIComponent(td.vaultName)}&file=${encodeURIComponent(td.relPath.replace(/\.md$/, ''))}`;
  const head = `<div class="row space td-head">
      <h2>${ico('✅')}오늘 할 일 <span class="muted small">${esc(dateLabel)}</span></h2>
      <div class="row">
        ${td.exists ? `<span class="small td-progress" title="완료/전체">${done}/${total}</span>` : ''}
        <label class="switch small"><input type="checkbox" data-act="hide" ${hideDone ? 'checked' : ''}/> 완료 숨기기</label>
        ${td.exists ? `<a class="small" href="${openHref}" title="${esc(td.relPath)}">Obsidian ↗</a>` : ''}
      </div>
    </div>`;

  let body: string;
  if (td.error) body = `<p class="small bad">${esc(td.error)}</p>`;
  else if (!td.exists)
    body = `<p class="muted small">오늘 노트(<code>${esc(td.relPath)}</code>)가 아직 없습니다.</p>
      ${td.canCreate ? '<button data-act="create">오늘 노트 만들기</button>' : ''}`;
  else {
    const parts: string[] = [];
    const idle: string[] = [];
    for (const s of td.sections) {
      for (const p of s.projects) {
        const fallback = s.kind === 'schedule' ? '⏰ 일정' : s.title.replace(/^[^\p{L}\p{N}]+/u, '');
        const hasContent = p.items.length > 0 || (s.kind === 'schedule' && p.memo.length > 0);
        const isAddTarget = editing?.kind === 'add' && editing.header === p.line;
        // section-level blocks without content (e.g. "Study" heading links) are noise
        if (!p.name && !hasContent && !isAddTarget) continue;
        (hasContent || isAddTarget ? parts : idle).push(projectHtml(p, td.vaultName, fallback));
      }
    }
    body =
      (parts.join('') || '<p class="muted small">오늘 노트에 할 일이 없습니다. 프로젝트의 ＋ 로 추가하세요.</p>') +
      (idle.length ? `<details class="td-idle"><summary class="muted small">할 일 없는 프로젝트 ${idle.length}개</summary>${idle.join('')}</details>` : '');
  }
  const idleOpen = box.querySelector<HTMLDetailsElement>('.td-idle')?.open;
  box.innerHTML = head + `<div class="td-body">${body}</div>`;
  if (idleOpen) box.querySelector<HTMLDetailsElement>('.td-idle')?.setAttribute('open', '');

  const input = box.querySelector<HTMLInputElement>('.td-edit input');
  if (input) {
    if (draft) input.value = draft.value;
    if (!draft || draft.focused) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function bind(box: HTMLElement, st: UIState, send: Send) {
  box.dataset.bound = '1';
  const op = (o: TodoOp) => {
    pending = true;
    send({ t: 'todoOp', op: o });
  };
  const rerender = () => renderTodos(st, send);

  box.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.act === 'hide') {
      hideDone = t.checked;
      try {
        localStorage.setItem(HIDE_KEY, hideDone ? '1' : '0');
      } catch {
        /* ignore */
      }
      return rerender();
    }
    if (t.dataset.act === 'toggle') {
      const it = items.get(Number(t.closest<HTMLElement>('.td-item')!.dataset.line));
      if (it) op({ op: 'toggle', line: it.line, raw: it.raw });
    }
  });

  const act = (el: HTMLElement, a: string) => {
    const li = el.closest<HTMLElement>('.td-item[data-line]');
    const it = li ? items.get(Number(li.dataset.line)) : undefined;
    const proj = headers.get(Number(el.closest<HTMLElement>('.td-proj')?.dataset.header));
    if (a === 'create') return send({ t: 'createTodayNote' });
    if (a === 'notes' && it) {
      if (openNotes.has(it.text)) openNotes.delete(it.text);
      else openNotes.add(it.text);
    } else if (a === 'edit' && it) editing = { kind: 'edit', line: it.line, raw: it.raw };
    else if (a === 'sub' && it && proj) editing = { kind: 'add', header: proj.line, headerRaw: proj.raw, parent: it.line, parentRaw: it.raw };
    else if (a === 'add' && proj) editing = { kind: 'add', header: proj.line, headerRaw: proj.raw };
    else if (a === 'cancel') editing = null;
    else if (a === 'del' && it) {
      const kids = count(it.children)[1];
      if (!confirm(`할 일을 삭제할까요?\n\n${it.text}${kids ? `\n(하위 항목 ${kids}개와 설명도 함께 삭제)` : ''}`)) return;
      op({ op: 'delete', line: it.line, raw: it.raw });
    } else return;
    rerender();
  };
  box.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el || el.tagName === 'INPUT' || el.classList.contains('td-text')) return;
    act(el, el.dataset.act!);
  });
  box.addEventListener('dblclick', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.td-text');
    if (el) act(el, 'edit');
  });
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (ev.target as HTMLElement).closest('.td-edit')) {
      editing = null;
      rerender();
    }
  });
  box.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = ((ev.target as HTMLFormElement).elements.namedItem('t') as HTMLInputElement).value.trim();
    const e = editing;
    if (!e) return;
    // ops carry the raw text captured when editing started; the server refuses them if that line changed
    if (e.kind === 'edit') {
      const it = items.get(e.line);
      if (!text) {
        if (!confirm(`내용을 비웠습니다. 이 할 일을 삭제할까요?\n\n${it?.text ?? ''}`)) return;
        op({ op: 'delete', line: e.line, raw: e.raw });
      } else if (text !== it?.text) op({ op: 'edit', line: e.line, raw: e.raw, text });
    } else {
      if (!text) return;
      op({ op: 'add', headerLine: e.header, headerRaw: e.headerRaw, text, ...(e.parent != null ? { parentLine: e.parent, parentRaw: e.parentRaw } : {}) });
    }
    editing = null;
    rerender();
  });
}

function lineRaw(td: TodayTodos, line: number): string | undefined {
  for (const s of td.sections)
    for (const p of s.projects) {
      if (p.line === line) return p.raw;
      const walk = (list: TodoItem[]): string | undefined => {
        for (const it of list) {
          if (it.line === line) return it.raw;
          const r = walk(it.children);
          if (r !== undefined) return r;
        }
        return undefined;
      };
      const r = walk(p.items);
      if (r !== undefined) return r;
    }
  return undefined;
}

/** Called when fresh todos arrive from the server (after an edit or a file change). */
export function todosUpdated(td: TodayTodos) {
  pending = false;
  // the line being edited moved or vanished: close the editor rather than point it at another line
  const e = editing;
  if (!e) return;
  const stale =
    e.kind === 'edit'
      ? lineRaw(td, e.line) !== e.raw
      : lineRaw(td, e.header) !== e.headerRaw || (e.parent != null && lineRaw(td, e.parent) !== e.parentRaw);
  if (stale) editing = null;
}
