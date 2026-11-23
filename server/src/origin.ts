/** vite dev server (npm run dev) proxies /ws and /api to the backend, so pages it serves are same-office */
export const VITE_DEV_PORT = 5173;

/**
 * Browser-only surface: reject cross-site requests. Any page the manager opens could otherwise reach
 * 127.0.0.1 and drive the office — WebSockets are not covered by CORS, so this is the only check there.
 * No Origin header means a local script or curl, which is allowed; the loopback bind is the guard for those.
 */
export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
  const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return p === port || p === VITE_DEV_PORT;
}
