import type { AgentStatus } from '../../../shared/protocol.ts';
import { tr } from '../../../shared/i18n.ts';

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const base = (p: unknown) => String(p ?? '').split('/').pop() ?? '';

/** Speech-bubble text for an mcp__office__* tool, or null for an unknown one. Built per call so it follows the language. */
function officeLabel(tool: string, input: Record<string, any>): string | null {
  const name = (v: unknown) => clip(String(v ?? ''), 30);
  switch (tool) {
    case 'office_status':
      return tr({ ko: '📋 사무실 현황 확인 중', en: '📋 Checking office status' });
    case 'list_tasks':
      return tr({ ko: '📋 작업 보드 확인 중', en: '📋 Checking the task board' });
    case 'office_activity':
      return tr({ ko: '🗂️ 직원 활동 기록 정리 중', en: '🗂️ Summarizing staff activity' });
    case 'list_routines':
      return tr({ ko: '⏰ 루틴 확인 중', en: '⏰ Checking routines' });
    case 'list_skills':
      return tr({ ko: '🧩 스킬 목록 확인 중', en: '🧩 Checking skills' });
    case 'save_skill':
      return tr({ ko: `🧩 스킬 작성: ${name(input.name)}`, en: `🧩 Writing skill: ${name(input.name)}` });
    case 'create_routine':
      return tr({ ko: `⏰ 루틴 등록: ${name(input.name)}`, en: `⏰ Adding routine: ${name(input.name)}` });
    case 'update_routine':
      return tr({ ko: `⏰ 루틴 수정: ${name(input.name ?? input.id)}`, en: `⏰ Editing routine: ${name(input.name ?? input.id)}` });
    case 'delete_routine':
      return tr({ ko: `🗑️ 루틴 삭제 요청: ${name(input.name ?? input.id)}`, en: `🗑️ Asking to delete routine: ${name(input.name ?? input.id)}` });
    case 'create_task':
      return tr({
        ko: `📨 ${input.assignee ?? ''}에게 작업 전달: ${name(input.title)}`,
        en: `📨 Handing a task to ${input.assignee ?? ''}: ${name(input.title)}`,
      });
  }
  return null;
}

/** Map one tool call to the character's animation state and speech-bubble text. */
export function statusForTool(name: string, input: Record<string, any>): { status: AgentStatus; activity: string } {
  switch (name) {
    case 'Read': {
      const f = base(input.file_path);
      return { status: 'typing', activity: tr({ ko: `📖 ${f} 읽는 중`, en: `📖 Reading ${f}` }) };
    }
    case 'Write': {
      const f = base(input.file_path);
      return { status: 'typing', activity: tr({ ko: `✍️ ${f} 작성 중`, en: `✍️ Writing ${f}` }) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const f = base(input.file_path ?? input.notebook_path);
      return { status: 'typing', activity: tr({ ko: `✏️ ${f} 수정 중`, en: `✏️ Editing ${f}` }) };
    }
    case 'Glob':
    case 'Grep': {
      const p = clip(String(input.pattern ?? ''), 40);
      return { status: 'typing', activity: tr({ ko: `🔎 ${p} 찾는 중`, en: `🔎 Searching for ${p}` }) };
    }
    case 'Bash':
      return { status: 'running', activity: `💻 ${clip(String(input.description ?? input.command ?? ''), 50)}` };
    case 'WebSearch': {
      const q = clip(String(input.query ?? ''), 45);
      return { status: 'researching', activity: tr({ ko: `🌐 "${q}" 검색`, en: `🌐 Searching "${q}"` }) };
    }
    case 'WebFetch': {
      const u = clip(String(input.url ?? ''), 45);
      return { status: 'researching', activity: tr({ ko: `🌐 ${u} 읽는 중`, en: `🌐 Reading ${u}` }) };
    }
    case 'TodoWrite':
      return { status: 'thinking', activity: tr({ ko: '📝 할 일 정리 중', en: '📝 Sorting out to-dos' }) };
    case 'Task':
    case 'Agent': {
      const d = clip(String(input.description ?? ''), 40);
      return { status: 'thinking', activity: tr({ ko: `👥 보조 작업: ${d}`, en: `👥 Subtask: ${d}` }) };
    }
  }
  if (name.startsWith('mcp__office__')) {
    const label = officeLabel(name.slice('mcp__office__'.length), input);
    return { status: 'typing', activity: label ?? tr({ ko: '📋 사무실 업무', en: '📋 Office work' }) };
  }
  if (name.startsWith('mcp__plugin_bio-research_') || name.startsWith('mcp__plugin_research-desk_')) {
    const src = name.split('__')[1]?.replace(/^plugin_[^_]+_/, '');
    return { status: 'researching', activity: tr({ ko: `📚 ${src} 검색 중`, en: `📚 Searching ${src}` }) };
  }
  if (name === 'ToolSearch') return { status: 'thinking', activity: tr({ ko: '🧰 도구 준비 중', en: '🧰 Getting tools ready' }) };
  if (name.startsWith('mcp__lab__')) {
    const tool = name.slice('mcp__lab__'.length);
    if (tool === 'submit_job') {
      const server = input.server ?? '';
      const job = clip(String(input.name ?? ''), 30);
      return { status: 'remote', activity: tr({ ko: `🖥️ ${server}에 job 제출: ${job}`, en: `🖥️ Submitting job to ${server}: ${job}` }) };
    }
    return { status: 'remote', activity: tr({ ko: `🖥️ 서버실: ${tool}`, en: `🖥️ Server room: ${tool}` }) };
  }
  return { status: 'typing', activity: `🔧 ${clip(name, 40)}` };
}

/** Compact one-line description of a tool call for the log panel. */
export function describeToolCall(name: string, input: Record<string, any>): string {
  const keys = ['command', 'file_path', 'pattern', 'query', 'url', 'server', 'name', 'description'];
  for (const k of keys) if (input?.[k]) return `${name}(${clip(String(input[k]), 160)})`;
  return `${name}(${clip(JSON.stringify(input ?? {}), 160)})`;
}
