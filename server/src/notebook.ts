import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The lab notebook: one Markdown file a day (workspaces/notebook/<YYYY-MM-DD>.md) that the server itself
// appends to when a task ends, a remote job ends, a result is recorded or the manager types "/note …".
// No model is called. Entries are only ever appended.

export type NoteItem =
  | { kind: 'task'; ts: number; taskId: number; title: string; who: string; ok: boolean; topic: string | null; text: string; error?: string }
  | { kind: 'job'; ts: number; jobId: number; name: string; server: string; state: string; topic?: string | null; metrics?: Record<string, number> | null; note?: string }
  | { kind: 'result'; ts: number; jobId: number; name: string; who: string; topic: string | null; metrics: Record<string, number>; params?: Record<string, string | number | boolean> | null; note?: string | null }
  | { kind: 'memo'; ts: number; text: string };

const RESULT_MAX = 600;
const PATHS_MAX = 12;
const pad = (n: number) => String(n).padStart(2, '0');

/** Local date of a timestamp as YYYY-MM-DD: the notebook file it belongs in. */
export function noteDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * File paths mentioned in a result text, in order, without repeats: anything under reports/, work/, figures/,
 * data/ or notes/ (with or without folders in front), and absolute or ~/ paths that end in a file extension.
 * URLs never match, since a path has to start after a space, a quote or a bracket.
 */
export function extractPaths(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s`'"(\[<*])((?:~\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+)/g;
  for (const m of text.matchAll(re)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    const rooted = p.startsWith('/') || p.startsWith('~/');
    const filed = /(^|\/)(reports|work|figures|data|notes)\//.test(p);
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(p);
    if (!(filed || (rooted && hasExt))) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= PATHS_MAX) break;
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A result text cut to its first RESULT_MAX characters and set as a quote block. */
function quote(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const cut = t.length > RESULT_MAX ? `${t.slice(0, RESULT_MAX).trimEnd()}…` : t;
  return cut
    .split('\n')
    .map((l) => `  > ${l}`.trimEnd())
    .join('\n');
}

/** One notebook entry as Markdown, ending in a blank line. */
export function noteEntry(item: NoteItem): string {
  const at = clock(item.ts);
  if (item.kind === 'memo') return `## ${at} · 📝\n${item.text.trim()}\n\n`;
  if (item.kind === 'result') {
    const lines = [`## ${at} · 📊 #${item.jobId} ${oneLine(item.name)} · ${item.who}`];
    if (item.topic) lines.push(`- Topic: ${item.topic}`);
    lines.push(`- Metrics: ${Object.entries(item.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const p = Object.entries(item.params ?? {});
    if (p.length) lines.push(`- Params: ${p.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (item.note?.trim()) lines.push(`- Note: ${oneLine(item.note)}`);
    return `${lines.join('\n')}\n\n`;
  }
  if (item.kind === 'job') {
    const lines = [`## ${at} · 🖥 Job #${item.jobId} ${oneLine(item.name)} · ${item.server} · ${item.state}`];
    if (item.topic) lines.push(`- Topic: ${item.topic}`);
    const m = Object.entries(item.metrics ?? {});
    if (m.length) lines.push(`- Metrics: ${m.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (item.note?.trim()) lines.push(`- Note: ${oneLine(item.note)}`);
    return `${lines.join('\n')}\n\n`;
  }
  const lines = [`## ${at} · #${item.taskId} ${oneLine(item.title)} · ${item.who} · ${item.ok ? '✅' : '⚠ failed'}`];
  if (item.topic) lines.push(`- Topic: ${item.topic}`);
  if (!item.ok && item.error) lines.push(`- Error: ${oneLine(item.error)}`);
  const q = quote(item.text);
  if (q) lines.push(`- ${item.ok ? 'Result' : 'Last words'}:\n${q}`);
  const paths = extractPaths(item.text);
  if (paths.length) lines.push(`- Files: ${paths.map((p) => `\`${p}\``).join(', ')}`);
  return `${lines.join('\n')}\n\n`;
}

export class Notebook {
  private warned = false;
  constructor(
    readonly dir: string,
    private enabled: boolean,
    private warn: (text: string) => void = () => {},
  ) {}

  get on(): boolean {
    return this.enabled;
  }

  fileFor(ts: number): string {
    return join(this.dir, `${noteDay(ts)}.md`);
  }

  /** Append one entry to its day's file. Never throws: a notebook that cannot be written must not stop the office. */
  add(item: NoteItem): boolean {
    if (!this.enabled) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(item.ts);
      const head = existsSync(file) ? '' : `# Notebook ${noteDay(item.ts)}\n\n`;
      appendFileSync(file, head + noteEntry(item));
      return true;
    } catch (err) {
      if (!this.warned) this.warn(`notebook: ${err instanceof Error ? err.message : String(err)}`);
      this.warned = true;
      return false;
    }
  }
}
