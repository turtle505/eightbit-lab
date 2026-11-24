import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getLang, tr } from '../../shared/i18n.ts';

export const COOKIE = 'office_token';
/** the browser keeps it for half a year; this is a personal tool, not a shared service */
const COOKIE_MAX_AGE = 180 * 24 * 3600;

/** Compare without leaking length or position through timing. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Is this request allowed in? Browsers carry the cookie set at login; scripts and curl send the
 * header instead. With no token configured the office is open, as it was before (loopback only).
 */
export function isAuthorized(req: Pick<IncomingMessage, 'headers'>, token: string): boolean {
  if (!token) return true;
  const header = req.headers['x-office-token'];
  if (tokenMatches(Array.isArray(header) ? header[0] : header, token)) return true;
  return tokenMatches(parseCookies(req.headers.cookie)[COOKIE], token);
}

export const cookieHeader = (token: string) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict`;

export const clearCookieHeader = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;

/** Suggest a token for the manager to paste into office.local.yaml. */
export const suggestToken = () => randomBytes(24).toString('base64url');

/** Tiny page that asks for the token and stores it as a cookie. */
export const loginPage = (wrong: boolean) => `<!doctype html>
<html lang="${getLang()}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>8-bit Lab · ${tr({ ko: '잠김', en: 'Locked' })}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; display: grid; place-items: center;
         min-height: 100dvh; margin: 0; background: #f3efe6; color: #2b2a27; }
  @media (prefers-color-scheme: dark) { body { background: #1d1f24; color: #e6e3dc; } }
  form { border: 2px solid currentColor; padding: 24px; max-width: 360px; width: calc(100% - 48px); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { font-size: 13px; opacity: .75; margin: 0 0 16px; line-height: 1.5; }
  input, button { font: inherit; width: 100%; box-sizing: border-box; padding: 8px; }
  input { border: 1px solid currentColor; background: transparent; color: inherit; }
  button { margin-top: 10px; cursor: pointer; border: 2px solid currentColor; background: transparent; color: inherit; }
  .bad { color: #c0392b; font-size: 13px; margin: 8px 0 0; }
  @media (prefers-color-scheme: dark) { .bad { color: #ff7b6b; } }
</style></head>
<body><form method="POST" action="/api/login">
  <h1>🧬 8-bit Lab</h1>
  <p>${tr({
    ko: '사무실 토큰을 입력하세요. 이 브라우저에 저장됩니다.<br />토큰은 서버의 <code>config/office.local.yaml</code> 에 있습니다.',
    en: 'Enter the office token. This browser will remember it.<br />The token is in <code>config/office.local.yaml</code> on the server.',
  })}</p>
  <input type="password" name="token" autofocus autocomplete="current-password" placeholder="office token" />
  ${wrong ? `<p class="bad">${tr({ ko: '토큰이 올바르지 않습니다.', en: 'Wrong token.' })}</p>` : ''}
  <button type="submit">${tr({ ko: '들어가기', en: 'Enter' })}</button>
</form></body></html>`;
