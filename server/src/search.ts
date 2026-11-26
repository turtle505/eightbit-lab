// Search across what the office has kept: report files, employee logs, task cards, the report feed and experiments.
// There is no index: a few thousand log lines and a few dozen reports are scanned on each query (SQL LIKE,
// and reading the report files). If that ever gets slow, this is the place to put an index.
import { experimentText } from '../../shared/experiments.ts';
import type { SearchHit } from '../../shared/protocol.ts';
import type { Store } from './db.ts';
import type { ReportLibrary } from './reports.ts';

export const MAX_TOKENS = 6;
export const PER_KIND = 30;
/** full text sent along with a hit, so it can be read in place */
const MAX_TEXT = 4000;

/** A word worth searching for: two characters, or a single one outside ASCII (표, 값: one Hangul syllable is a word). */
export const isSearchWord = (w: string): boolean => w.length >= 2 || (w.length === 1 && w.charCodeAt(0) > 0x7f);

/** The words of a query: lower-cased, no repeats, at most six, single ASCII characters dropped. All must match (AND). */
export function searchTokens(q: string): string[] {
  const out: string[] = [];
  for (const w of q.toLowerCase().split(/\s+/)) {
    if (isSearchWord(w) && !out.includes(w)) out.push(w);
    if (out.length === MAX_TOKENS) break;
  }
  return out;
}

/** A LIKE pattern that finds `token` literally: `%` and `_` in it are not wildcards (use with `ESCAPE '\'`). */
export const likePattern = (token: string): string => `%${token.replace(/[\\%_]/g, '\\$&')}%`;

export const matchesAll = (text: string, tokens: string[]): boolean => {
  const t = text.toLowerCase();
  return tokens.every((k) => t.includes(k));
};

/** The text around the first place any token occurs, on one line, with … where it was cut. */
export function snippet(text: string, tokens: string[], radius = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const k of tokens) {
    const i = low.indexOf(k);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, at + radius);
  return (from > 0 ? '…' : '') + flat.slice(from, to) + (to < flat.length ? '…' : '');
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…' : s);

/** Everything that matches, newest first within each kind. `nameOf` turns an employee id into what to show. */
export function searchAll(q: string, store: Store, reports: ReportLibrary, nameOf: (employeeId: string) => string): SearchHit[] {
  const tokens = searchTokens(q);
  if (!tokens.length) return [];
  const hits: SearchHit[] = [];
  for (const r of reports.search(tokens, PER_KIND))
    hits.push({ kind: 'report', ts: r.mtime, title: r.title, snippet: snippet(r.text, tokens), path: r.path, employeeId: r.employeeId ?? undefined });
  for (const t of store.searchTasks(tokens, PER_KIND)) {
    const body = [t.detail, t.result ?? ''].filter(Boolean).join('\n\n');
    hits.push({ kind: 'task', ts: t.updatedAt, title: `#${t.id} ${t.title}`, snippet: snippet(`${t.title} ${body}`, tokens), text: clip(body), taskId: t.id, employeeId: t.assignee ?? undefined });
  }
  for (const l of store.searchLogs(tokens, PER_KIND))
    hits.push({ kind: 'log', ts: l.ts, title: nameOf(l.employeeId), snippet: snippet(l.text, tokens), text: clip(l.text), employeeId: l.employeeId, logKind: l.kind });
  for (const f of store.searchFeed(tokens, PER_KIND))
    hits.push({ kind: 'feed', ts: f.ts, title: f.title, snippet: snippet(`${f.title} ${f.body}`, tokens), text: clip(f.body), path: f.path ?? undefined, employeeId: f.employeeId ?? undefined });
  for (const j of store.searchExperiments(tokens, PER_KIND, experimentText))
    hits.push({ kind: 'experiment', ts: j.updatedAt, title: `#${j.id} ${j.name}`, snippet: snippet(experimentText(j), tokens), text: clip(experimentText(j)), employeeId: j.submittedBy ?? undefined });
  return hits;
}
