import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import type { AttachmentView } from '../../shared/protocol.ts';
import type { Store } from './db.ts';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** uploads never tied to a task or an instruction are removed after this */
export const PENDING_TTL_MS = 24 * 3600_000;

const MIME: Record<string, string> = {
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.py': 'text/x-python', '.pdb': 'chemical/x-pdb', '.cif': 'chemical/x-cif',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword',
  '.rtf': 'application/rtf', '.odt': 'application/vnd.oasis.opendocument.text', '.html': 'text/html', '.htm': 'text/html',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip',
};
/** converted to plain text next to the original (textutil on macOS, LibreOffice elsewhere) */
const CONVERTIBLE_EXT = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm']);

export const mimeFor = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** basename only, no control chars or path separators, ≤120 chars (extension kept) */
export function safeName(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  let s = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '').replace(/^\.+/, '').trim();
  if (!s) s = 'file';
  if (s.length > 120) {
    const ext = extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface AttachmentRow {
  id: number;
  name: string;
  /** absolute, resolved against the current workspaceRoot (the DB stores it relative) */
  path: string;
  textPath: string | null;
  size: number;
  mime: string;
  createdAt: number;
  usedAt: number | null;
}

export const toView = (r: AttachmentRow): AttachmentView => ({ id: r.id, name: r.name, size: r.size, mime: r.mime, hasText: !!r.textPath });

/** Prompt section listing attachments with absolute paths (empty string when none). */
export function attachmentBlock(rows: AttachmentRow[]): string {
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const extra = r.textPath ? `  (본문 텍스트: ${r.textPath})` : /\.xlsx?$/i.test(r.name) ? '  (엑셀: Bash에서 pandas/openpyxl로 읽기)' : '';
    return `- #${r.id} ${r.name} (${humanSize(r.size)}, ${r.mime}): ${r.path}${extra}`;
  });
  return `\n\n## 첨부 파일 (읽기 전용 원본 — 고치려면 작업 폴더에 복사해서)\n${lines.join('\n')}`;
}

const run = (cmd: string, args: string[], ms = 120_000) =>
  new Promise<boolean>((res) => execFile(cmd, args, { timeout: ms }, (err) => res(!err)));

/**
 * Plain text next to the original so an agent can just Read it. macOS has `textutil`; elsewhere
 * LibreOffice does the same job (it writes <basename>.txt into the output directory).
 * Neither available → no conversion, the original is still attached.
 */
async function toPlainText(src: string, out: string): Promise<boolean> {
  if (process.platform === 'darwin') return (await run('textutil', ['-convert', 'txt', '-output', out, src])) && existsSync(out);
  const dir = dirname(out);
  for (const soffice of ['soffice', 'libreoffice']) {
    if (!(await run(soffice, ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, src]))) continue;
    // LibreOffice names it <basename-without-ext>.txt; our `out` is <file>.txt
    const produced = resolve(dir, basename(src).replace(/\.[^.]+$/, '') + '.txt');
    if (produced !== out && existsSync(produced)) renameSync(produced, out);
    if (existsSync(out)) return true;
  }
  return false;
}

/** Files the manager attached, stored under <workspaceRoot>/attachments/<date>/<id>-<name>. */
export class AttachmentLibrary {
  readonly dir: string;

  constructor(readonly workspaceRoot: string, private store: Store) {
    this.dir = resolve(workspaceRoot, 'attachments');
    // paths written by an older version (or on another machine) are absolute; re-root them once
    this.store.rerootAttachments(workspaceRoot);
  }

  async save(rawName: string, data: Buffer): Promise<AttachmentView> {
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`파일이 너무 큽니다 (${humanSize(data.length)} > ${humanSize(MAX_ATTACHMENT_BYTES)})`);
    const name = safeName(rawName);
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const id = this.store.addAttachment({ name, path: '', textPath: null, size: data.length, mime: mimeFor(name), createdAt: Date.now() });
    const dayDir = resolve(this.dir, day);
    mkdirSync(dayDir, { recursive: true });
    const path = resolve(dayDir, `${id}-${name}`);
    writeFileSync(path, data);
    let textPath: string | null = null;
    if (CONVERTIBLE_EXT.has(extname(name).toLowerCase()) && (await toPlainText(path, `${path}.txt`))) textPath = `${path}.txt`;
    this.store.updateAttachmentPaths(id, path, textPath);
    return toView(this.store.getAttachments([id])[0]);
  }

  /** rows for ids that exist (unknown ids dropped, order kept) */
  rows(ids: number[]): AttachmentRow[] {
    return this.store.getAttachments(ids);
  }

  /** remove uploads that were never attached to a task or sent with an instruction */
  cleanup(now = Date.now()): number {
    const stale = this.store.pendingAttachments(now - PENDING_TTL_MS);
    for (const r of stale) {
      for (const p of [r.path, r.textPath]) if (p && p.startsWith(this.dir)) rmSync(p, { force: true });
      this.store.deleteAttachment(r.id);
    }
    return stale.length;
  }
}
