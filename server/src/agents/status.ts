import type { AgentStatus } from '../../../shared/protocol.ts';

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const base = (p: unknown) => String(p ?? '').split('/').pop() ?? '';

/** Map one tool call to the character's animation state and speech-bubble text. */
export function statusForTool(name: string, input: Record<string, any>): { status: AgentStatus; activity: string } {
  switch (name) {
    case 'Read':
      return { status: 'typing', activity: `📖 ${base(input.file_path)} 읽는 중` };
    case 'Write':
      return { status: 'typing', activity: `✍️ ${base(input.file_path)} 작성 중` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { status: 'typing', activity: `✏️ ${base(input.file_path ?? input.notebook_path)} 수정 중` };
    case 'Glob':
    case 'Grep':
      return { status: 'typing', activity: `🔎 ${clip(String(input.pattern ?? ''), 40)} 찾는 중` };
    case 'Bash':
      return { status: 'running', activity: `💻 ${clip(String(input.description ?? input.command ?? ''), 50)}` };
    case 'WebSearch':
      return { status: 'researching', activity: `🌐 "${clip(String(input.query ?? ''), 45)}" 검색` };
    case 'WebFetch':
      return { status: 'researching', activity: `🌐 ${clip(String(input.url ?? ''), 45)} 읽는 중` };
    case 'TodoWrite':
      return { status: 'thinking', activity: '📝 할 일 정리 중' };
    case 'Task':
    case 'Agent':
      return { status: 'thinking', activity: `👥 보조 작업: ${clip(String(input.description ?? ''), 40)}` };
  }
  if (name.startsWith('mcp__office__')) {
    const labels: Record<string, string> = {
      office_status: '📋 사무실 현황 확인 중',
      list_tasks: '📋 작업 보드 확인 중',
      office_activity: '🗂️ 직원 활동 기록 정리 중',
      list_routines: '⏰ 루틴 확인 중',
      list_skills: '🧩 스킬 목록 확인 중',
      save_skill: `🧩 스킬 작성: ${clip(String(input.name ?? ''), 30)}`,
      create_routine: `⏰ 루틴 등록: ${clip(String(input.name ?? ''), 30)}`,
      update_routine: `⏰ 루틴 수정: ${clip(String(input.name ?? input.id ?? ''), 30)}`,
      delete_routine: `🗑️ 루틴 삭제 요청: ${clip(String(input.name ?? input.id ?? ''), 30)}`,
      create_task: `📨 ${input.assignee ?? ''}에게 작업 전달: ${clip(String(input.title ?? ''), 30)}`,
    };
    return { status: 'typing', activity: labels[name.slice('mcp__office__'.length)] ?? '📋 사무실 업무' };
  }
  if (name.startsWith('mcp__plugin_bio-research_') || name.startsWith('mcp__plugin_research-desk_')) {
    return { status: 'researching', activity: `📚 ${name.split('__')[1]?.replace(/^plugin_[^_]+_/, '')} 검색 중` };
  }
  if (name === 'ToolSearch') return { status: 'thinking', activity: '🧰 도구 준비 중' };
  if (name.startsWith('mcp__lab__')) {
    const tool = name.slice('mcp__lab__'.length);
    if (tool === 'submit_job') return { status: 'remote', activity: `🖥️ ${input.server ?? ''}에 job 제출: ${clip(String(input.name ?? ''), 30)}` };
    return { status: 'remote', activity: `🖥️ 서버실: ${tool}` };
  }
  return { status: 'typing', activity: `🔧 ${clip(name, 40)}` };
}

/** Compact one-line description of a tool call for the log panel. */
export function describeToolCall(name: string, input: Record<string, any>): string {
  const keys = ['command', 'file_path', 'pattern', 'query', 'url', 'server', 'name', 'description'];
  for (const k of keys) if (input?.[k]) return `${name}(${clip(String(input[k]), 160)})`;
  return `${name}(${clip(JSON.stringify(input ?? {}), 160)})`;
}
