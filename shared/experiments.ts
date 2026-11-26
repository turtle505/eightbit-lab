// Experiments: what a job was run with (params) and what came out (metrics), so runs can be compared in one
// table. A row is a remote job, or a result recorded by name for something run elsewhere. Shared by the server
// (validation, search) and the browser (the comparison table).
import type { Job } from './protocol.ts';

export type ParamValue = string | number | boolean;
export const KEY_MAX = 40;
export const KEYS_MAX = 40;
export const VALUE_MAX = 200;

const cleanKey = (k: string) => k.trim().replace(/\s+/g, '_').slice(0, KEY_MAX);

/** Metrics as given by an agent: names → finite numbers. Anything else is refused, naming the offender. */
export function cleanMetrics(input: unknown): { metrics: Record<string, number> } | { error: string } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { error: 'metrics must be an object of name → number' };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = cleanKey(k);
    if (!key) return { error: 'a metric needs a name' };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `metric "${key}" must be a finite number (got ${JSON.stringify(v)}); put text in note` };
    out[key] = v;
  }
  if (!Object.keys(out).length) return { error: 'give at least one metric' };
  if (Object.keys(out).length > KEYS_MAX) return { error: `at most ${KEYS_MAX} metrics` };
  return { metrics: out };
}

/** Params (the setup of a run): names → string, number or boolean; long strings are cut. */
export function cleanParams(input: unknown): { params: Record<string, ParamValue> | null } | { error: string } {
  if (input == null) return { params: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'params must be an object of name → value' };
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = cleanKey(k);
    if (!key) return { error: 'a param needs a name' };
    if (typeof v === 'string') out[key] = v.slice(0, VALUE_MAX);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[key] = v;
    else return { error: `param "${key}" must be a string, number or boolean` };
  }
  if (Object.keys(out).length > KEYS_MAX) return { error: `at most ${KEYS_MAX} params` };
  return { params: Object.keys(out).length ? out : null };
}

/** Is this job a row of the comparison table? Only once something was written down about it. */
export const isExperiment = (j: Job): boolean => !!(j.metrics && Object.keys(j.metrics).length) || !!(j.params && Object.keys(j.params).length);

/** Lower is better for metrics named like an error or a cost; everything else counts up. A guess the table lets you flip. */
export const lowerIsBetter = (metric: string): boolean => /(loss|err|error|rmsd|rmse|mse|mae|dist|distance|time|latency|perplexity|ppl|fid|clash|violation|energy)/i.test(metric);

export interface ExperimentTable {
  /** param names, then metric names, each in order of first appearance */
  params: string[];
  metrics: string[];
  rows: Job[];
  /** metric name → the best value in the rows shown (per `lower`) */
  best: Record<string, number>;
}

export type ExperimentSort = { col: string; kind: 'field' | 'param' | 'metric'; desc: boolean };

const cell = (j: Job, s: ExperimentSort): ParamValue | null => {
  if (s.kind === 'metric') return j.metrics?.[s.col] ?? null;
  if (s.kind === 'param') return j.params?.[s.col] ?? null;
  if (s.col === 'name') return j.name;
  if (s.col === 'topic') return j.topic ?? null;
  if (s.col === 'state') return j.state;
  return j.createdAt;
};

/**
 * The comparison table: the experiments of one topic (or all), their columns as the union of what any row has,
 * sorted by one column (rows without a value for it go last), and the best value of each metric.
 * `lower` says, per metric, whether a smaller number is better; missing = `lowerIsBetter(name)`.
 */
export function experimentTable(jobs: Job[], opts: { topic?: string | null; sort?: ExperimentSort; lower?: Record<string, boolean> } = {}): ExperimentTable {
  const rows = jobs.filter((j) => isExperiment(j) && (opts.topic == null || j.topic === opts.topic));
  const params: string[] = [];
  const metrics: string[] = [];
  for (const j of rows) {
    for (const k of Object.keys(j.params ?? {})) if (!params.includes(k)) params.push(k);
    for (const k of Object.keys(j.metrics ?? {})) if (!metrics.includes(k)) metrics.push(k);
  }
  const s = opts.sort ?? { col: 'date', kind: 'field', desc: true };
  rows.sort((a, b) => {
    const x = cell(a, s);
    const y = cell(b, s);
    if (x == null || y == null) return x == null && y == null ? b.id - a.id : x == null ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return (s.desc ? -d : d) || b.id - a.id;
  });
  const best: Record<string, number> = {};
  for (const m of metrics) {
    const vals = rows.map((j) => j.metrics?.[m]).filter((v): v is number => typeof v === 'number');
    if (vals.length < 2) continue; // nothing to compare against
    best[m] = (opts.lower?.[m] ?? lowerIsBetter(m)) ? Math.min(...vals) : Math.max(...vals);
  }
  return { params, metrics, rows, best };
}

/** Topics that have experiments, most recent first. */
export function experimentTopics(jobs: Job[]): string[] {
  const out: string[] = [];
  for (const j of [...jobs].filter(isExperiment).sort((a, b) => b.updatedAt - a.updatedAt)) if (j.topic && !out.includes(j.topic)) out.push(j.topic);
  return out;
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The table as CSV text (what "copy" puts on the clipboard), dates as local YYYY-MM-DD. */
export function experimentCsv(t: ExperimentTable): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const head = ['id', 'name', 'topic', 'state', 'date', ...t.params, ...t.metrics];
  const lines = t.rows.map((j) => [j.id, j.name, j.topic ?? '', j.state, day(j.createdAt), ...t.params.map((p) => j.params?.[p]), ...t.metrics.map((m) => j.metrics?.[m])].map(csvCell).join(','));
  return [head.map(csvCell).join(','), ...lines].join('\n') + '\n';
}

/** A number as the table shows it: four significant digits (one decimal from 1000 up), no trailing zeros. */
export const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 1000 ? String(Math.round(v * 10) / 10) : String(Number(v.toPrecision(4))));

/** Text of an experiment for search: name, topic, note, and its param and metric names with values. */
export const experimentText = (j: Job): string =>
  [
    j.name,
    j.topic ? `topic: ${j.topic}` : '',
    Object.entries(j.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
    Object.entries(j.metrics ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
    j.note ?? '',
    j.command,
  ]
    .filter(Boolean)
    .join('\n');
