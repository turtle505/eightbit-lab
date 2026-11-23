// Switching between the pixel "game" view and the plain "console" view.
import type { ViewMode } from './panels.ts';

const KEY = 'eightbit-lab:view';
/** Panels that exist once and move into whichever view is active. */
const SHARED = ['approvals', 'employee', 'routines', 'jobs'];

export function initialView(): ViewMode {
  const q = new URLSearchParams(location.search).get('view');
  if (q === 'console' || q === 'game') return q;
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'console' || v === 'game') return v;
  } catch {
    /* storage unavailable */
  }
  return 'game';
}

export function applyView(view: ViewMode) {
  document.body.classList.toggle('view-console', view === 'console');
  document.body.classList.toggle('view-game', view === 'game');
  const root = document.getElementById(view === 'console' ? 'view-console' : 'view-game')!;
  document.getElementById('view-game')!.hidden = view !== 'game';
  document.getElementById('view-console')!.hidden = view !== 'console';
  for (const id of SHARED) {
    const el = document.getElementById(id);
    const slot = root.querySelector(`[data-slot="${id}"]`);
    if (el && slot && el.parentElement !== slot) slot.append(el);
  }
  document.querySelectorAll<HTMLButtonElement>('.view-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  document.title = view === 'console' ? '8-bit Lab · Console' : '8-bit Lab';
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  if (url.searchParams.has('view')) {
    url.searchParams.set('view', view);
    history.replaceState(null, '', url);
  }
}
