import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { EmployeeView, Job, LogLine, RoutineView, ServerView, Task } from '../../../shared/protocol.ts';

/** What the office exposes to the secretary. Wired up in index.ts. */
export interface OfficeApi {
  employees(): EmployeeView[];
  tasks(): Task[];
  jobs(): Job[];
  servers(): ServerView[];
  routines(): RoutineView[];
  logsSince(ts: number): LogLine[];
  createTask(title: string, detail: string, assignee: string | null): Task;
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], isError });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** In-process MCP server: tools appear as mcp__office__<name>. */
export function officeToolsServer(selfId: string, api: OfficeApi) {
  return createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    instructions:
      'Tools to see and manage the AI office: staff status, the task board, remote jobs, servers and routines. ' +
      'create_task with an assignee immediately puts that employee to work, so delegate only when the manager asked for it or a routine says so.',
    tools: [
      tool('office_status', 'Snapshot of every employee (status, current activity, task) plus open approvals count, jobs and servers.', {}, async () => {
        const emps = api.employees().map((e) => ({ id: e.id, name: e.name, title: e.title, status: e.status, activity: e.activity, taskId: e.taskId }));
        const jobs = api.jobs().slice(-20).map((j) => ({ id: j.id, name: j.name, server: j.server, state: j.state, by: j.submittedBy, updated: new Date(j.updatedAt).toLocaleString('ko-KR') }));
        const servers = api.servers().map((s) => ({ name: s.name, online: s.online, gpus: s.gpus.map((g) => `${g.util}%`).join(' '), note: s.note }));
        return text(JSON.stringify({ employees: emps, jobs, servers }, null, 2));
      }),
      tool(
        'list_tasks',
        'List tasks on the board, optionally filtered by state.',
        { state: z.enum(['todo', 'doing', 'review', 'done']).optional() },
        async ({ state }) => {
          const ts = api.tasks().filter((t) => !state || t.state === state);
          return text(
            JSON.stringify(
              ts.map((t) => ({ id: t.id, title: t.title, state: t.state, assignee: t.assignee, result: t.result ? clip(t.result, 600) : null, updated: new Date(t.updatedAt).toLocaleString('ko-KR') })),
              null,
              2,
            ),
          );
        },
      ),
      tool(
        'office_activity',
        'What each employee did in the last N hours (instructions, tool calls, results, errors), grouped by employee.',
        { hours: z.number().min(0.5).max(72).optional().describe('default 24') },
        async ({ hours }) => {
          const since = Date.now() - (hours ?? 24) * 3600_000;
          const by = new Map<string, string[]>();
          for (const l of api.logsSince(since)) {
            if (l.employeeId === selfId) continue;
            const arr = by.get(l.employeeId) ?? [];
            arr.push(`${new Date(l.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} [${l.kind}] ${clip(l.text.replace(/\s+/g, ' '), 300)}`);
            by.set(l.employeeId, arr);
          }
          if (!by.size) return text('해당 기간에 다른 직원의 활동이 없습니다.');
          return text([...by].map(([id, lines]) => `## ${id}\n${lines.slice(-60).join('\n')}`).join('\n\n'));
        },
      ),
      tool('list_routines', 'List scheduled routines with next/last run times.', {}, async () =>
        text(JSON.stringify(api.routines().map((r) => ({ ...r, lastRun: r.lastRun && new Date(r.lastRun).toLocaleString('ko-KR'), nextRun: r.nextRun && new Date(r.nextRun).toLocaleString('ko-KR') })), null, 2)),
      ),
      tool(
        'create_task',
        'Add a task to the board. With `assignee` (employee id) the employee starts on it right away.',
        {
          title: z.string(),
          detail: z.string().optional(),
          assignee: z.string().optional().describe('employee id, e.g. lit, model, data, eval'),
        },
        async ({ title, detail, assignee }) => {
          if (assignee && !api.employees().some((e) => e.id === assignee)) return text(`unknown employee ${assignee}`, true);
          if (assignee === selfId) return text('자기 자신에게는 위임할 수 없습니다.', true);
          const t = api.createTask(title, detail ?? '', assignee ?? null);
          return text(`created task #${t.id}${assignee ? ` and assigned to ${assignee}` : ''}`);
        },
      ),
    ],
  });
}
