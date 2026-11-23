// Today's to-dos from an Obsidian daily note (format of research_notebook/.scripts/daily_note.py):
//   ## ⏰ Schedule / Appointments | ## 🧬 Active Project | ## 📚 Study   (a section ends at "---" or the next "## ")
//   **[[Link|Project]]**            project header
//   xxx_log:: ...                   log field (skipped)
//   - [ ] task ↻2                   checkbox, "↻N" = carried over N times; tab-indented children
//   	- description                 non-checkbox sub-bullet = description of the item above
import type { TodoItem, TodoOp, TodoProject, TodoSection } from '../../shared/protocol.ts';

const SEC_RE = /^##\s+(.*)$/;
const HEAD_RE = /^\s*\*\*(.+?)\*\*\s*$/;
const LOG_RE = /^\s*[A-Za-z0-9_]+_log::/;
const BOX_RE = /^(\s*)-\s*\[([ xX])\]\s?(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const CARRY_RE = /\s*↻(\d+)\s*$/;

const indentOf = (ln: string) => (ln.match(/^\s*/)![0].replace(/\t/g, '    ').length);
const isBoundary = (ln: string) => SEC_RE.test(ln) || HEAD_RE.test(ln) || ln.trim() === '---';

function sectionKind(title: string): TodoSection['kind'] | null {
  if (/Schedule/i.test(title)) return 'schedule';
  if (/Active Project/i.test(title)) return 'project';
  if (/Study/i.test(title)) return 'study';
  return null;
}

/** "[[a/b|c]]" → c, "[[x]]" → x */
export const wikiText = (s: string) => s.replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2');

function splitCarry(text: string): { text: string; carry: number } {
  const m = text.match(CARRY_RE);
  return m ? { text: text.replace(CARRY_RE, ''), carry: Number(m[1]) } : { text: text.trimEnd(), carry: 0 };
}

export function parseDaily(src: string): TodoSection[] {
  const lines = src.split(/\r?\n/);
  const sections: TodoSection[] = [];
  let sec: TodoSection | null = null;
  let proj: TodoProject | null = null;
  // open checkbox items by indentation, for nesting
  let stack: Array<{ item: TodoItem; indent: number }> = [];

  lines.forEach((ln, i) => {
    const sm = ln.match(SEC_RE);
    if (sm) {
      const kind = sectionKind(sm[1]);
      sec = kind ? { kind, title: sm[1].trim(), line: i, projects: [] } : null;
      if (sec) {
        sections.push(sec);
        proj = { name: '', link: null, line: i, raw: ln, memo: [], items: [] };
        sec.projects.push(proj);
      } else proj = null;
      stack = [];
      return;
    }
    if (!sec || !proj) return;
    if (ln.trim() === '---') {
      sec = null;
      proj = null;
      stack = [];
      return;
    }
    const hm = ln.match(HEAD_RE);
    if (hm) {
      const inner = hm[1].trim();
      const lm = inner.match(/^\[\[([^\]|]+)(\|[^\]]+)?\]\]$/);
      proj = { name: wikiText(inner), link: lm ? lm[1] : null, line: i, raw: ln, memo: [], items: [] };
      (sec as TodoSection).projects.push(proj);
      stack = [];
      return;
    }
    if (!ln.trim() || LOG_RE.test(ln)) return;

    const ind = indentOf(ln);
    const bm = ln.match(BOX_RE);
    if (bm) {
      const { text, carry } = splitCarry(bm[3]);
      const item: TodoItem = { line: i, raw: ln, checked: bm[2] !== ' ', text, carry, children: [], notes: [] };
      while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
      if (stack.length) stack[stack.length - 1].item.children.push(item);
      else proj.items.push(item);
      stack.push({ item, indent: ind });
      return;
    }
    // description under the nearest shallower checkbox, otherwise a memo line of the block
    while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
    const owner = stack[stack.length - 1];
    if (owner) {
      const bl = ln.match(BULLET_RE);
      const depth = Math.max(0, Math.round((ind - owner.indent) / 4) - 1);
      owner.item.notes.push({ depth, text: (bl ? bl[2] : ln.trim()).trim() });
      return;
    }
    proj.memo.push(ln.trim());
  });
  return sections;
}

// ---------------------------------------------------------------- edits

const STALE = '노트가 그새 바뀌었습니다. 다시 불러온 뒤 시도하세요.';

function check(lines: string[], line: number, raw: string) {
  if (line < 0 || line >= lines.length || lines[line] !== raw) throw new Error(STALE);
}

/** Last line of an item including its deeper-indented children/descriptions. */
function subtreeEnd(lines: string[], idx: number): number {
  const base = indentOf(lines[idx]);
  let last = idx;
  for (let j = idx + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (!ln.trim()) continue;
    if (isBoundary(ln) || indentOf(ln) <= base) break;
    last = j;
  }
  return last;
}

/** Last non-empty line of the block that starts at a project header / section heading. */
function blockEnd(lines: string[], header: number): number {
  let last = header;
  for (let j = header + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (isBoundary(ln)) break;
    if (ln.trim()) last = j;
  }
  return last;
}

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();

/** Apply one edit to the note text; throws (Korean message) when the target line no longer matches. */
export function applyTodoOp(src: string, op: TodoOp): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  switch (op.op) {
    case 'toggle': {
      check(lines, op.line, op.raw);
      const m = op.raw.match(BOX_RE);
      if (!m) throw new Error('체크박스 줄이 아닙니다.');
      lines[op.line] = op.raw.replace(/\[([ xX])\]/, m[2] === ' ' ? '[x]' : '[ ]');
      break;
    }
    case 'edit': {
      check(lines, op.line, op.raw);
      const m = op.raw.match(/^(\s*-\s*\[[ xX]\]\s?)(.*)$/);
      if (!m) throw new Error('체크박스 줄이 아닙니다.');
      const text = oneLine(op.text);
      if (!text) throw new Error('내용이 비어 있습니다. 지우려면 삭제를 쓰세요.');
      const carry = m[2].match(CARRY_RE);
      lines[op.line] = m[1] + text + (carry ? ` ↻${carry[1]}` : '');
      break;
    }
    case 'delete': {
      check(lines, op.line, op.raw);
      if (!BOX_RE.test(op.raw)) throw new Error('체크박스 줄이 아닙니다.');
      lines.splice(op.line, subtreeEnd(lines, op.line) - op.line + 1);
      break;
    }
    case 'add': {
      check(lines, op.headerLine, op.headerRaw);
      const text = oneLine(op.text);
      if (!text) throw new Error('내용이 비어 있습니다.');
      if (op.parentLine != null) {
        check(lines, op.parentLine, op.parentRaw ?? '');
        const lead = lines[op.parentLine].match(/^\s*/)![0];
        lines.splice(subtreeEnd(lines, op.parentLine) + 1, 0, `${lead}\t- [ ] ${text}`);
      } else {
        lines.splice(blockEnd(lines, op.headerLine) + 1, 0, `- [ ] ${text}`);
      }
      break;
    }
  }
  return lines.join(eol);
}

// ---------------------------------------------------------------- paths

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md" for a local date. */
export function dailyPath(template: string, d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return template
    .replace(/\{YYYY\}/g, String(d.getFullYear()))
    .replace(/\{MM\}/g, p2(d.getMonth() + 1))
    .replace(/\{DD\}/g, p2(d.getDate()))
    .replace(/\{ddd\}/g, DOW[d.getDay()]);
}

export const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
