import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { tr } from '../../shared/i18n.ts';
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
    // a PDF read as a PDF costs several times its text (every page goes in as an image too): text first, pages on demand
    if (r.textPath && /\.pdf$/i.test(r.name))
      return (
        `- #${r.id} ${r.name} (${humanSize(r.size)}, ${r.mime}): read the extracted text first: ${r.textPath}\n` +
        `  Its "--- page N ---" lines tell you which PDF page you are on. Open the PDF itself (${r.path}) only for the pages where you need a figure, table or equation, with the Read tool's page range; do not read the whole PDF.`
      );
    const extra = r.textPath ? `  (extracted text: ${r.textPath})` : /\.xlsx?$/i.test(r.name) ? '  (Excel: read it with pandas/openpyxl from Bash)' : '';
    return `- #${r.id} ${r.name} (${humanSize(r.size)}, ${r.mime}): ${r.path}${extra}`;
  });
  return `\n\n## Attachments (read-only originals: copy into your working folder to edit)\n${lines.join('\n')}`;
}

/** pdftotext separates pages with a form feed: turn each into a line that says which page starts. */
export function markPages(text: string): string {
  const pages = text.replace(/\f\s*$/, '').split('\f');
  return pages.map((p, i) => `--- page ${i + 1} ---\n${p.trim()}\n`).join('\n');
}

/**
 * Is the text taken out of a PDF worth reading instead of the PDF? A scan has next to none: under
 * 200 characters in all, or under 100 per page on average, and the original is passed as before.
 */
export function pdfTextUsable(text: string): boolean {
  const chars = text.replace(/\s+/g, '').length;
  const pages = text.split('\f').filter((p) => p.trim()).length || 1;
  return chars >= 200 && chars / pages >= 100;
}

/**
 * The text of a PDF next to it, with page markers, by poppler's pdftotext (reading order, not -layout:
 * that would set the two columns of a paper side by side). False when the tool is missing or the PDF has no text layer.
 */
async function pdfToText(src: string, out: string): Promise<boolean> {
  const raw = `${out}.raw`;
  try {
    if (!(await run('pdftotext', ['-enc', 'UTF-8', src, raw], 60_000)) || !existsSync(raw)) return false;
    const text = readFileSync(raw, 'utf8');
    if (!pdfTextUsable(text)) return false;
    writeFileSync(out, markPages(text));
    return true;
  } finally {
    rmSync(raw, { force: true });
  }
}

/** Can PDFs be turned into text here? (poppler's pdftotext on the PATH) */
export const hasPdfToText = (): Promise<boolean> => run('pdftotext', ['-v'], 5_000);

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
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(
        tr({
          ko: `파일이 너무 큽니다 (${humanSize(data.length)} > ${humanSize(MAX_ATTACHMENT_BYTES)})`,
          en: `File too large (${humanSize(data.length)} > ${humanSize(MAX_ATTACHMENT_BYTES)})`,
        }),
      );
    const name = safeName(rawName);
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const id = this.store.addAttachment({ name, path: '', textPath: null, size: data.length, mime: mimeFor(name), createdAt: Date.now() });
    const dayDir = resolve(this.dir, day);
    mkdirSync(dayDir, { recursive: true });
    const path = resolve(dayDir, `${id}-${name}`);
    writeFileSync(path, data);
    let textPath: string | null = null;
    const ext = extname(name).toLowerCase();
    if (ext === '.pdf' ? await pdfToText(path, `${path}.txt`) : CONVERTIBLE_EXT.has(ext) && (await toPlainText(path, `${path}.txt`))) textPath = `${path}.txt`;
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
