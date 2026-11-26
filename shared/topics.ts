// A topic is the research subject a task belongs to ("design-survey"). It names the folder its reports go in
// (reports/<topic>/), and groups notebook entries and experiments. Shared by the server and the browser.

export const TOPIC_MAX = 40;
/** folders directly under reports/ that are not topics */
export const NOT_TOPICS = new Set(['daily', 'misc', 'figures', 'data']);

/**
 * A topic as typed, tidied into a folder name: lower case, spaces and underscores to hyphens.
 * Empty input is "no topic" (null). Anything that would not make a plain folder name is refused.
 */
export function normalizeTopic(input: string | null | undefined): { topic: string | null } | { error: string } {
  const t = (input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!t) return { topic: null };
  if (t.length > TOPIC_MAX) return { error: `a topic is at most ${TOPIC_MAX} characters` };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t)) return { error: 'a topic uses only a-z, 0-9 and hyphens (it becomes a folder name)' };
  if (NOT_TOPICS.has(t)) return { error: `"${t}" is a reserved folder name, not a topic` };
  return { topic: t };
}

/**
 * The topic a report file belongs to, from its path as the report index knows it
 * ("shared/reports/design-survey/2026-11-26-x.md" → "design-survey"). A file directly in reports/, or in
 * daily/ or misc/, has none.
 */
export function topicOfReport(path: string): string | null {
  const parts = path.split('/');
  const at = parts.indexOf('reports');
  // the folder right after "reports", but only if the file is inside it (not a file named like a folder)
  const name = at >= 0 ? parts[at + 1] : undefined;
  if (!name || parts.length < at + 3) return null;
  return NOT_TOPICS.has(name) || name.startsWith('.') ? null : name;
}

/** Topics in use, most recently used first: from the tasks and from the report folders. */
export function knownTopics(tasks: { topic?: string | null; updatedAt: number }[], reports: { topic?: string | null; mtime: number }[]): string[] {
  const last = new Map<string, number>();
  for (const t of tasks) if (t.topic) last.set(t.topic, Math.max(last.get(t.topic) ?? 0, t.updatedAt));
  for (const r of reports) if (r.topic) last.set(r.topic, Math.max(last.get(r.topic) ?? 0, r.mtime));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** What a task's instructions say about its topic: where its files belong (agent-facing, English). */
export const topicLine = (topic: string | null): string =>
  topic ? `\nTopic: ${topic} (report files for this task go in reports/${topic}/, figures in reports/${topic}/figures/, scratch work in work/${topic}/)` : '';
