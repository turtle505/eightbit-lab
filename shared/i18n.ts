/**
 * Language of everything a person reads (UI, statuses, logs, notices). Agent-facing prompts are English
 * regardless; only the line telling agents which language to report in follows this.
 *
 * The server and the browser each hold their own copy of this module state: the server sets it from the
 * DB / office.language, the browser from the snapshot and `language` messages, so call sites never pass it.
 */
export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];

let current: Lang = 'en';

export const getLang = (): Lang => current;
export function setLang(l: Lang) {
  current = l;
}
export const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en';

/** Pick the current language's version. Whole sentences per language, since Korean particles don't swap word for word. */
export const tr = (s: { ko: string; en: string }): string => s[current];

/** BCP 47 locale for Intl / toLocale*String. */
export const locale = (): string => (current === 'ko' ? 'ko-KR' : 'en-US');

/** short weekday names, Sunday first */
export const dowShort = (): readonly string[] =>
  current === 'ko' ? ['일', '월', '화', '수', '목', '금', '토'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "HH:MM", 24-hour, in the current locale */
export const hhmm = (ts: number | Date): string =>
  new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });

/** language name as written in an English instruction to an agent */
export const LANG_NAME_EN: Record<Lang, string> = { ko: 'Korean', en: 'English' };
