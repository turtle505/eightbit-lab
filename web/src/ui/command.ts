import { getLang, tr } from '../../../shared/i18n.ts';
import { noteCommand } from '../../../shared/note.ts';
import { bindAttach } from './attach.ts';
import { commandTargets, isProjectSession } from './targets.ts';
import { $, type Send, type UIState, changed, esc, plain, short, statusLabel } from './panels.ts';

const MAX_ROWS = 5;
const BUSY = new Set(['thinking', 'typing', 'running', 'researching', 'remote', 'waiting_permission']);

let built = false;
/** read at send time, so the handlers built once always see the latest state */
let current: UIState;

/**
 * The command bar: one input that instructs whoever is selected (click a character, a staff row, 1–n, or
 * the picker). A shared panel, so it sits under the office in the game view and under the staff table in
 * the console. Built once; renders only touch the picker and the hints, never the text being typed.
 */
export function renderCommandBar(st: UIState, send: Send, select: (id: string | null) => void) {
  current = st;
  if (!built) build(send, select);
  // the staff, plus project sessions that have a desk in the office
  const emps = commandTargets(st.snap.employees, st.selected);
  const target = emps.find((e) => e.id === st.selected) ?? null;
  if (!changed('cmd', [emps.map((e) => [e.id, e.name, e.status, e.activity]), st.selected, st.view, getLang()])) return;

  // labels are set here, not in build(), so a language switch reaches them
  $('cmd-send').textContent = tr({ ko: '보내기', en: 'Send' });
  $('cmd-attach').title = tr({ ko: '파일 첨부', en: 'Attach files' });
  $('cmd-target').setAttribute('aria-label', tr({ ko: '지시받을 직원', en: 'Who gets the instruction' }));

  const pick = $('cmd-target') as HTMLSelectElement;
  pick.innerHTML =
    `<option value="">${tr({ ko: '직원 선택…', en: 'Pick someone…' })}</option>` +
    emps.map((e) => `<option value="${esc(e.id)}">${BUSY.has(e.status) ? '●' : '○'} ${isProjectSession(e) ? `📁 ${esc(plain(e.name))}` : esc(short(e.name))}</option>`).join('');
  pick.value = target?.id ?? '';

  const input = $('cmd-input') as HTMLTextAreaElement;
  input.placeholder = target
    ? tr({
        ko: `${short(target.name)}에게 지시… (Enter 전송 · Shift+Enter 줄바꿈 · 파일은 끌어다 놓기)`,
        en: `Instruct ${short(target.name)}… (Enter to send · Shift+Enter for a new line · drop files here)`,
      })
    : st.view === 'console'
      ? tr({ ko: '직원 표에서 행을 클릭하거나 직원을 고르세요 (단축키 /)', en: 'Click a row in the staff table or pick someone (shortcut /)' })
      : tr({ ko: '캐릭터를 클릭하거나 직원을 고르세요 (단축키 /)', en: 'Click a character or pick someone (shortcut /)' });

  const hint = $('cmd-hint');
  // the activity line already says what they're doing ("✅ Done: …"); the bare status is the fallback
  hint.textContent = target ? `${short(target.name)} · ${plain(target.activity) || statusLabel(target.status)}` : '';
  hint.hidden = !target;
}

function build(send: Send, select: (id: string | null) => void) {
  built = true;
  const box = $('command');
  box.innerHTML = `
    <form id="cmd-form" class="cmd-form">
      <select id="cmd-target"></select>
      <textarea id="cmd-input" rows="1" autocomplete="off"></textarea>
      <button type="button" id="cmd-attach" class="icon-btn attach-btn">📎</button>
      <button class="primary" type="submit" id="cmd-send"></button>
    </form>
    <div id="cmd-chips" class="att-chips" hidden></div>
    <div id="cmd-hint" class="muted small cmd-hint" hidden></div>`;
  const form = $('cmd-form') as HTMLFormElement;
  const input = $('cmd-input') as HTMLTextAreaElement;
  const att = bindAttach(box, $('cmd-attach'), $('cmd-chips'));

  const grow = () => {
    input.style.height = 'auto';
    const line = parseFloat(getComputedStyle(input).lineHeight) || 18;
    const max = line * MAX_ROWS + 10;
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden'; // a scrollbar only once it stops growing
  };
  input.addEventListener('input', grow);
  // the manager in the office types along
  input.addEventListener('input', () => window.dispatchEvent(new CustomEvent('office-manager', { detail: { kind: 'typing' } })));
  requestAnimationFrame(grow);

  ($('cmd-target') as HTMLSelectElement).addEventListener('change', (ev) => {
    select((ev.target as HTMLSelectElement).value || null);
    input.focus();
  });

  const submit = () => {
    const st = current;
    const target = commandTargets(st.snap.employees, st.selected).find((e) => e.id === st.selected);
    const text = input.value.trim();
    // "/note …" is the manager's own line for the lab notebook; nobody is instructed
    const note = noteCommand(text);
    if (note !== null) {
      if (!note) return toast(tr({ ko: '/note 뒤에 적을 내용을 쓰세요.', en: 'Write the note after /note.' }), 'warn');
      send({ t: 'addNote', text: note });
      input.value = '';
      grow();
      input.focus();
      return toast(tr({ ko: '📝 연구 노트에 적었습니다', en: '📝 Added to the notebook' }));
    }
    if (!target) {
      ($('cmd-target') as HTMLSelectElement).focus();
      return toast(tr({ ko: '먼저 지시받을 직원을 고르세요.', en: 'Pick who should get it first.' }), 'warn');
    }
    if (att.busy()) return toast(tr({ ko: '첨부 파일을 올리는 중입니다. 잠시 후 다시 보내 주세요.', en: 'Attachments are still uploading. Please send again in a moment.' }), 'warn');
    const attachmentIds = att.take();
    if (!text && !attachmentIds.length) return;
    send({ t: 'instruct', employeeId: target.id, text, attachmentIds });
    window.dispatchEvent(new CustomEvent('office-manager', { detail: { kind: 'instruct', id: target.id } }));
    input.value = '';
    grow();
    input.focus();
    const name = short(target.name);
    toast(
      BUSY.has(target.status)
        ? tr({ ko: `→ ${name}에게 보냄 (일하는 중이라 바로 전달됨)`, en: `→ Sent to ${name} (mid-task, delivered right away)` })
        : tr({ ko: `→ ${name}에게 보냄`, en: `→ Sent to ${name}` }),
    );
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') input.blur();
  });
}

const toast = (text: string, level: 'info' | 'warn' = 'info') => window.dispatchEvent(new CustomEvent('office-toast', { detail: { text, level } }));
