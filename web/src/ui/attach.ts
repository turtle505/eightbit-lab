// Attachments: upload files (picker or drag & drop) to /api/upload before sending a task / instruction,
// then pass the returned ids along with the message.
import type { AttachmentView } from '../../../shared/protocol.ts';
import { esc } from './panels.ts';

export const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** "📎 a.csv · b.png" links for a task card / table */
export const attachmentLinks = (list: AttachmentView[]) =>
  list
    .map(
      (a) =>
        `<a class="att-link" href="/api/attachments/${a.id}" target="_blank" rel="noopener" title="${esc(a.mime)} · ${sizeText(a.size)}${a.hasText ? ' · 텍스트 변환본 있음' : ''}">${esc(a.name)}</a>`,
    )
    .join(' ');

async function upload(file: File): Promise<AttachmentView> {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'X-Office-Upload': '1', 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `업로드 실패 (HTTP ${r.status})`);
  return body as AttachmentView;
}

export interface Attacher {
  /** ids of finished uploads; clears the list */
  take(): number[];
  /** true while an upload is still running (the form should wait) */
  busy(): boolean;
}

/** main.ts turns this event into an error toast */
const onError = (msg: string) => window.dispatchEvent(new CustomEvent('office-toast', { detail: { text: msg, level: 'error' } }));

/** Wire a 📎 button + hidden file input + chip list into a form; files dropped anywhere on `dropZone` are added too. */
export function bindAttach(dropZone: HTMLElement, button: HTMLElement, chips: HTMLElement): Attacher {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  dropZone.append(input);
  let items: { key: number; name: string; size: number; att: AttachmentView | null }[] = [];
  let seq = 0;

  const render = () => {
    chips.hidden = items.length === 0;
    chips.innerHTML = items
      .map(
        (it) =>
          `<span class="chip${it.att ? '' : ' uploading'}" data-key="${it.key}">📎 ${esc(it.name)} <span class="muted">${it.att ? sizeText(it.size) : '올리는 중…'}</span>${
            it.att ? ` <button type="button" class="chip-x" title="첨부 빼기">✕</button>` : ''
          }</span>`,
      )
      .join('');
    chips.querySelectorAll<HTMLButtonElement>('.chip-x').forEach((b) =>
      b.addEventListener('click', () => {
        const key = Number(b.closest<HTMLElement>('.chip')!.dataset.key);
        items = items.filter((i) => i.key !== key);
        render();
      }),
    );
  };

  const add = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const it = { key: ++seq, name: f.name, size: f.size, att: null as AttachmentView | null };
      items.push(it);
      upload(f)
        .then((att) => {
          it.att = att;
          render();
        })
        .catch((e) => {
          items = items.filter((i) => i !== it);
          onError(`${f.name}: ${(e as Error).message}`);
          render();
        });
    }
    render();
  };

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) add(input.files);
    input.value = '';
  });
  dropZone.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return; // task cards are dragged too; ignore those
    ev.preventDefault();
    dropZone.classList.add('drop-hover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-hover'));
  dropZone.addEventListener('drop', (ev) => {
    dropZone.classList.remove('drop-hover');
    if (!ev.dataTransfer?.files.length) return;
    ev.preventDefault();
    add(ev.dataTransfer.files);
  });
  render();

  return {
    take() {
      const ids = items.filter((i) => i.att).map((i) => i.att!.id);
      items = [];
      render();
      return ids;
    },
    busy: () => items.some((i) => !i.att),
  };
}
