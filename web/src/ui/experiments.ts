import { tr } from '../../../shared/i18n.ts';
import { type ExperimentSort, experimentCsv, experimentTable, experimentTopics, fmtNum, isExperiment, lowerIsBetter } from '../../../shared/experiments.ts';
import type { Job } from '../../../shared/protocol.ts';
import { type UIState, ago, esc, short } from './panels.ts';

const toast = (text: string, level: 'info' | 'warn' = 'info') => window.dispatchEvent(new CustomEvent('office-toast', { detail: { text, level } }));

/**
 * The experiment comparison table: one row per run that has params or metrics written down, one column per
 * param and metric any of them has. Opened from the jobs panel as a dialog; kept up to date while open.
 */
let dlg: HTMLDialogElement | null = null;
let topic: string | null = null;
let sort: ExperimentSort = { col: 'date', kind: 'field', desc: true };
/** metric → "lower is better", once the manager has flipped it (otherwise guessed from the name) */
const lower: Record<string, boolean> = {};
let openRow: number | null = null;
let lastKey = '';

export const experimentCount = (jobs: Job[]): number => jobs.filter(isExperiment).length;

export function openExperiments(st: UIState) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'exp-dialog';
    document.body.appendChild(dlg);
    // a click on the backdrop (the dialog element itself, outside its content box) closes it
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) dlg!.close();
    });
  }
  lastKey = '';
  renderExperiments(st);
  if (!dlg.open) dlg.showModal();
}

export function renderExperiments(st: UIState) {
  if (!dlg || (!dlg.open && lastKey)) return;
  const jobs = st.snap.jobs;
  const topics = experimentTopics(jobs);
  if (topic && !topics.includes(topic)) topic = null;
  const key = JSON.stringify([jobs.filter(isExperiment), topic, sort, lower, openRow, st.snap.language]);
  if (key === lastKey) return;
  lastKey = key;

  const t = experimentTable(jobs, { topic, sort, lower });
  const nameOf = (id: string | null) => (id ? short(st.snap.employees.find((e) => e.id === id)?.name ?? id) : tr({ ko: '나', en: 'me' }));
  const arrow = (col: string, kind: ExperimentSort['kind']) => (sort.col === col && sort.kind === kind ? (sort.desc ? ' ▼' : ' ▲') : '');
  const th = (label: string, col: string, kind: ExperimentSort['kind'], cls = '') =>
    `<th class="${cls}"><button type="button" class="link" data-sort="${esc(col)}" data-kind="${kind}">${esc(label)}${arrow(col, kind)}</button></th>`;
  const isLower = (m: string) => lower[m] ?? lowerIsBetter(m);
  const metricTh = (m: string) =>
    `<th class="num metric"><button type="button" class="link" data-sort="${esc(m)}" data-kind="metric">${esc(m)}${arrow(m, 'metric')}</button><button type="button" class="exp-dir" data-flip="${esc(m)}" title="${esc(
      tr({ ko: '굵게 표시할 값: 눌러서 큰 값 / 작은 값 바꾸기', en: 'Which value is shown in bold: click to switch between highest and lowest' }),
    )}">${isLower(m) ? '↓' : '↑'}</button></th>`;
  const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  const cols = 5 + t.params.length + t.metrics.length;
  const rows = t.rows
    .map((j) => {
      const main = `<tr data-id="${j.id}" class="exp-row${openRow === j.id ? ' open' : ''}">
        <td class="num muted">#${j.id}</td>
        <td class="name"><button type="button" class="link" data-open="${j.id}">${esc(j.name)}</button></td>
        <td>${j.topic ? `<span class="topic-badge">#${esc(j.topic)}</span>` : ''}</td>
        <td class="muted">${esc(j.state === 'recorded' ? tr({ ko: '기록', en: 'recorded' }) : j.state)}</td>
        <td class="muted" title="${esc(new Date(j.createdAt).toLocaleString())}">${day(j.createdAt)}</td>
        ${t.params.map((p) => `<td class="param">${j.params?.[p] == null ? '' : esc(String(j.params[p]))}</td>`).join('')}
        ${t.metrics
          .map((m) => {
            const v = j.metrics?.[m];
            return `<td class="num metric${v != null && t.best[m] === v ? ' best' : ''}"${v == null ? '' : ` title="${v}"`}>${v == null ? '' : fmtNum(v)}</td>`;
          })
          .join('')}
      </tr>`;
      const detail =
        openRow === j.id
          ? `<tr class="exp-detail"><td></td><td colspan="${cols - 1}">
              <div>${esc(nameOf(j.submittedBy))}${j.server ? ` · ${esc(j.server)}` : ''} · ${ago(j.updatedAt)}</div>
              ${j.note ? `<div>📝 ${esc(j.note)}</div>` : ''}
              ${j.command ? `<pre>${esc(j.command)}</pre>` : ''}
              ${j.logPath ? `<div class="muted">log: <code>${esc(j.logPath)}</code></div>` : ''}
            </td></tr>`
          : '';
      return main + detail;
    })
    .join('');

  dlg.innerHTML = `
    <div class="exp-head">
      <h2>📊 ${tr({ ko: '실험 비교', en: 'Experiments' })} <span class="muted">${t.rows.length}</span></h2>
      <select id="exp-topic" title="${esc(tr({ ko: '주제로 거르기', en: 'Filter by topic' }))}">
        <option value="">${tr({ ko: '모든 주제', en: 'All topics' })}</option>
        ${topics.map((x) => `<option value="${esc(x)}" ${x === topic ? 'selected' : ''}>#${esc(x)}</option>`).join('')}
      </select>
      <button type="button" id="exp-csv" ${t.rows.length ? '' : 'disabled'}>${tr({ ko: 'CSV 복사', en: 'Copy CSV' })}</button>
      <button type="button" id="exp-close" title="Esc">✕</button>
    </div>
    ${
      t.rows.length
        ? `<div class="exp-scroll"><table class="exp-table"><thead><tr>
            <th></th>${th(tr({ ko: '이름', en: 'Name' }), 'name', 'field')}${th(tr({ ko: '주제', en: 'Topic' }), 'topic', 'field')}${th(tr({ ko: '상태', en: 'State' }), 'state', 'field')}${th(tr({ ko: '날짜', en: 'Date' }), 'date', 'field')}
            ${t.params.map((p) => th(p, p, 'param', 'param')).join('')}${t.metrics.map(metricTh).join('')}
          </tr></thead><tbody>${rows}</tbody></table></div>
          <p class="muted small">${tr({
            ko: '열 이름을 누르면 정렬됩니다. 지표마다 가장 좋은 값이 굵게 표시되고, ↑↓로 큰 값과 작은 값 중 어느 쪽이 좋은지 바꿉니다.',
            en: 'Click a column name to sort. The best value of each metric is bold; ↑↓ switches whether higher or lower is better.',
          })}</p>`
        : `<p class="muted">${tr({
            ko: '아직 기록된 실험이 없습니다. 직원이 실험을 돌리고 결과 지표를 기록하면 (<code>record_result</code>) 여기에 한 줄씩 쌓입니다. GPU 작업은 끝날 때 자동으로 기록을 요청받습니다.',
            en: 'No experiments recorded yet. When an employee runs one and records its metrics (<code>record_result</code>), it appears here as a row. For GPU jobs they are asked to do so when the job ends.',
          })}</p>`
    }`;

  dlg.querySelector('#exp-close')!.addEventListener('click', () => dlg!.close());
  dlg.querySelector<HTMLSelectElement>('#exp-topic')!.addEventListener('change', (ev) => {
    topic = (ev.target as HTMLSelectElement).value || null;
    renderExperiments(st);
  });
  dlg.querySelector('#exp-csv')!.addEventListener('click', () => {
    const csv = experimentCsv(t);
    void navigator.clipboard.writeText(csv).then(
      () => toast(tr({ ko: `표를 CSV로 복사했습니다 (${t.rows.length}행)`, en: `Copied the table as CSV (${t.rows.length} rows)` })),
      () => toast(tr({ ko: '클립보드에 복사하지 못했습니다', en: 'Could not copy to the clipboard' }), 'warn'),
    );
  });
  dlg.querySelectorAll<HTMLButtonElement>('button[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      const col = b.dataset.sort!;
      const kind = b.dataset.kind as ExperimentSort['kind'];
      // first click on a metric puts its best value on top; a second click turns it round
      sort = sort.col === col && sort.kind === kind ? { ...sort, desc: !sort.desc } : { col, kind, desc: kind === 'metric' ? !isLower(col) : kind === 'field' && col === 'date' };
      renderExperiments(st);
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>('button[data-flip]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.flip!;
      lower[m] = !isLower(m);
      renderExperiments(st);
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>('button[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.open);
      openRow = openRow === id ? null : id;
      renderExperiments(st);
    }),
  );
}
