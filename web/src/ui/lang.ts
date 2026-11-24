import { getLang, isLang, setLang, type Lang } from '../../../shared/i18n.ts';

export { getLang };

const KEY = 'office.lang';

/** Static text in index.html, keyed by its data-i18n attribute (data-i18n-title / -placeholder / -aria for attributes). */
const STATIC: Record<string, { ko: string; en: string }> = {
  'h.reports': { ko: '보고서', en: 'reports' },
  notify: { ko: '알림 켜기', en: 'Notify' },
  'notify.title': { ko: '완료·승인 요청을 데스크톱 알림으로 받기', en: 'Get desktop notifications for finished runs and approval requests' },
  'view.toggle': { ko: '화면 전환 (단축키 `)', en: 'Switch view (shortcut `)' },
  'view.game': { ko: '게임', en: 'Game' },
  'view.console': { ko: '콘솔', en: 'Console' },
  'view.reports': { ko: '보고서', en: 'Reports' },
  'view.projects': { ko: '프로젝트', en: 'Projects' },
  board: { ko: '📋 작업 보드', en: '📋 Task board' },
  'task.title.long': { ko: '새 작업 제목 (예: 첨부한 논문 요약)', en: 'New task title (e.g. Summarize the attached paper)' },
  'task.title': { ko: '새 작업 제목', en: 'New task title' },
  'task.detail': { ko: '세부 지시 (선택)', en: 'Details (optional)' },
  'attach.form': { ko: '파일 첨부 (폼에 끌어다 놓아도 됨)', en: 'Attach files (or drop them on the form)' },
  'attach.line': { ko: '파일 첨부 (입력줄에 끌어다 놓아도 됨)', en: 'Attach files (or drop them on the input row)' },
  attach: { ko: '첨부', en: 'Attach' },
  'lock.title': {
    ko: '🔒 승인 받기: 담당 직원이 자동 모드여도 이 작업에서는 화이트리스트 밖 도구마다 매니저 승인을 받음',
    en: '🔒 Require approval: even if the assignee is in auto mode, every tool outside the allowlist needs the manager\'s approval for this task',
  },
  'lock.short': { ko: '🔒 승인', en: '🔒 Approve' },
  'lock.long': { ko: '승인 받기', en: 'Require approval' },
  add: { ko: '추가', en: 'Add' },
  'c.staff': { ko: '직원', en: 'Staff' },
  'c.tasks': { ko: '작업', en: 'Tasks' },
  'c.feed': { ko: '활동 피드', en: 'Activity feed' },
  'k.select': { ko: '선택', en: 'select' },
  'k.move': { ko: '이동', en: 'move' },
  'k.instruct': { ko: '지시', en: 'instruct' },
  'k.clear': { ko: '해제', en: 'clear' },
  'k.view': { ko: '화면 전환', en: 'switch view' },
};

/** Before the first snapshot: the last language this browser saw, so the page doesn't flash the other one. */
export function initLang() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  setLang(isLang(saved) ? saved : navigator.language.startsWith('ko') ? 'ko' : 'en');
  applyStatic();
}

/** The office language from the server (snapshot). */
export function applyLang(lang: Lang | undefined) {
  if (!isLang(lang)) return;
  setLang(lang);
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* storage blocked */
  }
  applyStatic();
}

function applyStatic() {
  const lang = getLang();
  document.documentElement.lang = lang;
  const btn = document.getElementById('lang-btn');
  if (btn) btn.textContent = lang === 'ko' ? 'EN' : '한국어';
  const pick = (key: string | undefined) => (key && STATIC[key] ? STATIC[key][lang] : null);
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const t = pick(el.dataset.i18n);
    if (t != null) el.textContent = t;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const t = pick(el.dataset.i18nTitle);
    if (t != null) el.title = t;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const t = pick(el.dataset.i18nAria);
    if (t != null) el.setAttribute('aria-label', t);
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach((el) => {
    const t = pick(el.dataset.i18nPlaceholder);
    if (t != null) el.placeholder = t;
  });
}
