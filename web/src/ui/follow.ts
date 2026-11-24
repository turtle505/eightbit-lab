import { tr } from '../../../shared/i18n.ts';

/**
 * Chat-style scrolling for a log or feed box: while the reader sits at the bottom, new lines are followed;
 * once they scroll up, their place is kept and a "↓" button (with the number of new lines) takes them back down.
 *
 * State is keyed by a string, not the element, so it survives a box being re-created (the projects tab redraws
 * everything; the employee panel is rebuilt when you switch people).
 */
interface Follow {
  /** at (or within NEAR px of) the bottom */
  pinned: boolean;
  top: number;
  /** item count at the last call, to tell how many arrived since */
  count: number;
  /** lines that arrived while scrolled up */
  unseen: number;
}

const NEAR = 40;
const state = new Map<string, Follow>();
const wired = new WeakMap<HTMLElement, { key: string; btn: HTMLButtonElement }>();

const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;

function toBottom(el: HTMLElement, smooth = false) {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function paintButton(btn: HTMLButtonElement, s: Follow) {
  btn.hidden = s.pinned;
  btn.textContent = s.unseen > 0 ? tr({ ko: `↓ 새 메시지 ${s.unseen}개`, en: `↓ ${s.unseen} new` }) : tr({ ko: '↓ 맨 아래로', en: '↓ Latest' });
}

/** Wire an element once: track the reader's position, add the ↓ button, re-stick when images finish loading. */
function wire(key: string, el: HTMLElement): HTMLButtonElement {
  const w = wired.get(el);
  if (w) {
    w.key = key; // the feed box keeps its element when the employee filter (and so the key) changes
    return w.btn;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jump-bottom';
  btn.hidden = true;
  el.after(btn);
  const entry = { key, btn };
  wired.set(el, entry);
  const current = () => state.get(entry.key);
  el.addEventListener('scroll', () => {
    const s = current();
    if (!s) return;
    s.pinned = atBottom(el);
    s.top = el.scrollTop;
    if (s.pinned) s.unseen = 0;
    paintButton(btn, s);
  });
  // a markdown image that loads late grows the box; stay at the bottom if that's where the reader was
  el.addEventListener('load', () => current()?.pinned && toBottom(el), true);
  btn.addEventListener('click', () => toBottom(el, true));
  return btn;
}

/** Call right after (re)drawing the box's contents; `count` is how many items it now holds in total. */
export function followBottom(key: string, el: HTMLElement, count: number): void {
  const btn = wire(key, el);
  // a hidden box (the other view) has no size yet; leave it until it's on screen
  if (el.offsetParent === null) return;
  let s = state.get(key);
  if (!s) {
    s = { pinned: true, top: 0, count, unseen: 0 };
    state.set(key, s);
  }
  const added = Math.max(0, count - s.count);
  s.count = count;
  if (s.pinned) {
    toBottom(el);
    s.unseen = 0;
  } else {
    el.scrollTop = s.top;
    s.unseen += added;
  }
  paintButton(btn, s);
}
