import { tr } from '../../../shared/i18n.ts';

/** What makes an approval request worth a second look; shown as chips and a red edge on the card. */
export interface Risk {
  high: boolean;
  reasons: string[];
}

const LAB_TOOLS = new Set(['mcp__lab__submit_job', 'mcp__lab__cancel_job', 'mcp__lab__fetch_results']);
/** words that only wrap the real command */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'xargs', 'exec', 'command', 'builtin']);

/** Each simple command as its words, with leading VAR=… and wrappers (sudo, env, xargs …) dropped. */
export function commandParts(cmd: string): { words: string[]; sudo: boolean }[] {
  return cmd
    .split(/\|\||&&|[;|\n&]|\$\(|`/)
    .map((seg) => {
      const words = seg.trim().replace(/^[({\s]+/, '').split(/\s+/).filter(Boolean);
      let sudo = false;
      while (words.length && (WRAPPERS.has(base(words[0])) || /^\w+=/.test(words[0]) || (words[0].startsWith('-') && sudo))) {
        if (base(words[0]) === 'sudo') sudo = true;
        words.shift();
      }
      return { words, sudo };
    })
    .filter((p) => p.words.length || p.sudo);
}

const base = (w: string) => w.replace(/^.*\//, '');

/** a path that holds keys or secrets */
const SECRET_PATH = /(^|\/)(\.ssh\/|\.env(\.|$)|id_(rsa|ed25519|ecdsa)|[^/]*\.pem$|\.aws\/|\.netrc$)/;

export function approvalRisk(toolName: string, input: Record<string, unknown>): Risk {
  const reasons = new Set<string>();
  const remote = tr({ ko: '🌐 원격 서버', en: '🌐 remote server' });
  const del = tr({ ko: '🗑 파일 삭제', en: '🗑 deletes files' });
  if (LAB_TOOLS.has(toolName)) reasons.add(remote);
  if (toolName === 'mcp__office__delete_routine') reasons.add(tr({ ko: '🗑 루틴 삭제', en: '🗑 deletes a routine' }));

  const path = String(input.file_path ?? input.notebook_path ?? '');
  if (path && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) && SECRET_PATH.test(path))
    reasons.add(tr({ ko: '🔐 비밀 파일', en: '🔐 secrets file' }));

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    for (const { words, sudo } of commandParts(cmd)) {
      if (sudo) reasons.add('🔑 sudo');
      const [w0 = '', w1 = ''] = words.map(base);
      const args = words.slice(1);
      if (['ssh', 'scp', 'rsync', 'sftp', 'sshfs'].includes(w0)) reasons.add(remote);
      if (['rm', 'rmdir', 'shred', 'mkfs', 'unlink'].includes(w0) || w0.startsWith('mkfs.')) reasons.add(del);
      if (w0 === 'find' && args.includes('-delete')) reasons.add(del);
      if (w0 === 'dd' && args.some((a) => a.startsWith('of='))) reasons.add(del);
      if (w0 === 'git') {
        const force = args.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-'));
        if (w1 === 'push') reasons.add(force ? tr({ ko: '⬆️ git 강제 push', en: '⬆️ git force-push' }) : '⬆️ git push');
        if (w1 === 'clean' || w1 === 'rm') reasons.add(del);
        if ((w1 === 'reset' && args.includes('--hard')) || w1 === 'restore' || (w1 === 'checkout' && (args.includes('--') || force)) || (w1 === 'branch' && args.includes('-D')))
          reasons.add(tr({ ko: '⏪ 변경 사항 버림', en: '⏪ discards changes' }));
      }
    }
    // a download piped straight into a shell
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)) reasons.add(tr({ ko: '📥 내려받은 코드 실행', en: '📥 runs downloaded code' }));
  }
  return { high: reasons.size > 0, reasons: [...reasons] };
}
