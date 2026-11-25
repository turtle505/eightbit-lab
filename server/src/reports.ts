import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { tr } from '../../shared/i18n.ts';
import type { ReportFile } from '../../shared/protocol.ts';

export interface ReportRoot {
  /** display prefix, e.g. "secretary/reports" */
  label: string;
  dir: string;
  employeeId: string | null;
}

const MAX_READ = 1_000_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'office-skills']);

/**
 * Report folders: every `<workspaceRoot>/<name>/reports` (employee desks) plus extra dirs from config.
 * `employeeFor(dir)` maps a workspace folder back to the employee whose cwd it is.
 */
export function reportRoots(workspaceRoot: string, extra: string[], employeeFor: (dir: string) => string | null): ReportRoot[] {
  const roots: ReportRoot[] = [];
  if (existsSync(workspaceRoot)) {
    for (const d of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      const ws = join(workspaceRoot, d.name);
      roots.push({ label: `${d.name}/reports`, dir: join(ws, 'reports'), employeeId: employeeFor(ws) });
    }
  }
  for (const dir of extra) {
    let label = basename(dir) || dir;
    while (roots.some((r) => r.label === label)) label += '_';
    roots.push({ label, dir, employeeId: null });
  }
  return roots;
}

function titleOf(file: string): string {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4000);
    const m = head.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* unreadable → fall back to the name */
  }
  return basename(file, '.md');
}

/** Scans report folders for .md files and tracks what changed between scans. */
export class ReportLibrary {
  private files = new Map<string, ReportFile & { abs: string }>();
  private titles = new Map<string, { mtime: number; title: string }>();
  /** file text for search, lower-cased, re-read only when the file changed */
  private texts = new Map<string, { mtime: number; text: string; low: string }>();

  constructor(private roots: () => ReportRoot[]) {}

  scan(): ReportFile[] {
    const next = new Map<string, ReportFile & { abs: string }>();
    for (const root of this.roots()) {
      if (!existsSync(root.dir)) continue;
      const walk = (dir: string, depth: number) => {
        if (depth > 6) return;
        let ents;
        try {
          ents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of ents) {
          if (d.name.startsWith('.')) continue;
          const abs = join(dir, d.name);
          if (d.isDirectory()) {
            if (!SKIP_DIRS.has(d.name)) walk(abs, depth + 1);
          } else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) {
            const st = statSync(abs);
            const path = `${root.label}/${relative(root.dir, abs).split(sep).join('/')}`;
            const cached = this.titles.get(abs);
            const title = cached && cached.mtime === st.mtimeMs ? cached.title : titleOf(abs);
            this.titles.set(abs, { mtime: st.mtimeMs, title });
            next.set(path, { path, root: root.label, employeeId: root.employeeId, title, size: st.size, mtime: Math.round(st.mtimeMs), abs });
          }
        }
      };
      walk(root.dir, 0);
    }
    this.files = next;
    return this.list();
  }

  list(): ReportFile[] {
    return [...this.files.values()].map(({ abs: _abs, ...f }) => f).sort((a, b) => b.mtime - a.mtime);
  }

  /** Rescan and return files that are new or whose mtime changed since the previous scan. */
  changes(): { list: ReportFile[]; changed: ReportFile[]; any: boolean } {
    const prev = new Map([...this.files].map(([k, v]) => [k, v.mtime]));
    const list = this.scan();
    const changed = list.filter((f) => prev.get(f.path) !== f.mtime);
    const removed = [...prev.keys()].some((k) => !this.files.has(k));
    return { list, changed, any: changed.length > 0 || removed };
  }

  /**
   * Reports whose title or text contains every token (lower-case), newest first. Only files from the last scan
   * are read, each up to MAX_READ, and their text is cached until the file changes.
   */
  search(tokens: string[], limit: number): (ReportFile & { text: string })[] {
    if (!tokens.length) return [];
    const out: (ReportFile & { text: string })[] = [];
    for (const { abs, ...f } of [...this.files.values()].sort((a, b) => b.mtime - a.mtime)) {
      let c = this.texts.get(abs);
      if (!c || c.mtime !== f.mtime) {
        let text = '';
        try {
          text = readFileSync(abs).subarray(0, MAX_READ).toString('utf8');
        } catch {
          continue; // removed since the scan
        }
        c = { mtime: f.mtime, text, low: `${f.title}\n${text}`.toLowerCase() };
        this.texts.set(abs, c);
      }
      const low = c.low;
      if (!tokens.every((k) => low.includes(k))) continue;
      out.push({ ...f, text: c.text });
      if (out.length >= limit) break;
    }
    for (const abs of this.texts.keys()) if (![...this.files.values()].some((f) => f.abs === abs)) this.texts.delete(abs);
    return out;
  }

  /** Only paths from the last scan can be read (no arbitrary file access from the browser). */
  read(path: string): { content: string; mtime: number } {
    const f = this.files.get(path);
    if (!f) throw new Error(tr({ ko: `보고서를 찾을 수 없습니다: ${path}`, en: `Report not found: ${path}` }));
    const root = this.roots().find((r) => r.label === f.root);
    if (!root || !resolve(f.abs).startsWith(resolve(root.dir) + sep)) throw new Error(tr({ ko: '허용되지 않은 경로입니다.', en: 'Path not allowed.' }));
    const st = statSync(f.abs);
    const buf = readFileSync(f.abs);
    const content = buf.subarray(0, MAX_READ).toString('utf8') + (buf.length > MAX_READ ? tr({ ko: '\n\n…(1MB 넘는 부분은 생략)', en: '\n\n…(truncated after 1 MB)' }) : '');
    return { content, mtime: Math.round(st.mtimeMs) };
  }
}
