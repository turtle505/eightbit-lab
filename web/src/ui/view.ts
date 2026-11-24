// Switching between the pixel "game" view, the plain "console" view and the "reports" browser.
import type { ViewMode } from './panels.ts';
import { tr } from '../../../shared/i18n.ts';

const KEY = 'eightbit-lab:view';
/** Panels that exist once and move into whichever view is active. */
const SHARED = ['command', 'approvals', 'employee', 'routines', 'jobs', 'report-feed', 'todos'];
const VIEWS: ViewMode[] = ['game', 'console', 'reports', 'projects'];
const isView = (v: unknown): v is ViewMode => VIEWS.includes(v as ViewMode);

export function initialView(): ViewMode {
  const q = new URLSearchParams(location.search).get('view');
  if (isView(q)) return q;
  try {
    const v = localStorage.getItem(KEY);
    if (isView(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'game';
}

export function applyView(view: ViewMode) {
  // the reports browser reuses the console's plain styling
  document.body.classList.toggle('view-console', view !== 'game');
  document.body.classList.toggle('view-reports', view === 'reports' || view === 'projects');
  document.body.classList.toggle('view-game', view === 'game');
  for (const v of VIEWS) document.getElementById(`view-${v}`)!.hidden = v !== view;
  // shared panels stay where they were while reading reports (that view has no slots)
  // reports and projects are full-width browsers with no shared-panel slots
  const root = view === 'reports' || view === 'projects' ? null : document.getElementById(`view-${view}`)!;
  if (root)
    for (const id of SHARED) {
      const el = document.getElementById(id);
      const slot = root.querySelector(`[data-slot="${id}"]`);
      if (el && slot && el.parentElement !== slot) slot.append(el);
    }
  document.querySelectorAll<HTMLButtonElement>('.view-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  document.title = viewTitle(view);
  try {
    // a separate ?view=reports window should not change what the main window opens with
    if (new URLSearchParams(location.search).get('view') !== 'reports') localStorage.setItem(KEY, view);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  if (url.searchParams.has('view')) {
    url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  }
}

export const viewTitle = (view: ViewMode): string =>
  view === 'console'
    ? '8-bit Lab · Console'
    : view === 'reports'
      ? tr({ ko: '8-bit Lab · 보고서', en: '8-bit Lab · Reports' })
      : view === 'projects'
        ? tr({ ko: '8-bit Lab · 프로젝트', en: '8-bit Lab · Projects' })
        : '8-bit Lab';
