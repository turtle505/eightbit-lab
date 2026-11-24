import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RoutineInput } from '../routines.ts';
import { fmtWhen, parseStartAt } from '../schedule.ts';
import type { EmployeeView, Job, LogLine, RoutineView, ServerView, SkillView, Task } from '../../../shared/protocol.ts';

/** What the office exposes to the secretary. Wired up in index.ts. */
export interface OfficeApi {
  employees(): EmployeeView[];
  tasks(): Task[];
  jobs(): Job[];
  servers(): ServerView[];
  routines(): RoutineView[];
  logsSince(ts: number): LogLine[];
  createTask(title: string, detail: string, assignee: string | null, createdBy: string | null, requireApproval?: boolean, attachmentIds?: number[], startAt?: number | null): Task;
  createRoutine(input: RoutineInput): RoutineView;
  updateRoutine(id: string, patch: Partial<RoutineInput>): RoutineView;
  deleteRoutine(id: string): RoutineView;
  skills(): SkillView[];
  saveSkill(name: string, description: string, body: string, allow: string[]): SkillView;
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], isError });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const CRON_HELP = '5-field cron "minute hour day-of-month month day-of-week" in local time, e.g. "0 9 * * 1-5" = weekdays 09:00 (0=Sun … 6=Sat)';
const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString('en-US') : null);
const routineOut = (r: RoutineView) => ({ ...r, prompt: clip(r.prompt, 300), lastRun: when(r.lastRun), nextRun: when(r.nextRun) });

/** In-process MCP server: tools appear as mcp__office__<name>. */
export function officeToolsServer(selfId: string, api: OfficeApi) {
  return createSdkMcpServer({
    name: 'office',
    alwaysLoad: true,
    version: '1.0.0',
    instructions:
      'Tools to see and manage the AI office: staff status, the task board, remote jobs, servers and routines. ' +
      'create_task with an assignee immediately puts that employee to work, so delegate only when the manager asked for it or a routine says so. ' +
      'For a one-off "do X at time T" (tomorrow 9am, in 2 hours), use create_task with `startAt`; routines are for work that repeats. ' +
      'Routines (create_routine / update_routine / delete_routine) change the office schedule: use them only when the manager asked; every call waits for the manager\'s approval. ' +
      'A routine should normally run an office skill (save_skill → create_routine with `skill`) instead of carrying a long prompt.',
    tools: [
      tool('office_status', 'Snapshot of every employee (status, current activity, task) plus open approvals count, jobs and servers.', {}, async () => {
        const emps = api.employees().map((e) => ({ id: e.id, name: e.name, title: e.title, status: e.status, activity: e.activity, taskId: e.taskId }));
        const jobs = api.jobs().slice(-20).map((j) => ({ id: j.id, name: j.name, server: j.server, state: j.state, by: j.submittedBy, updated: new Date(j.updatedAt).toLocaleString('en-US') }));
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
              ts.map((t) => ({ id: t.id, title: t.title, state: t.state, assignee: t.assignee, createdBy: t.createdBy, result: t.result ? clip(t.result, 600) : null, updated: new Date(t.updatedAt).toLocaleString('en-US') })),
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
            arr.push(`${new Date(l.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} [${l.kind}] ${clip(l.text.replace(/\s+/g, ' '), 300)}`);
            by.set(l.employeeId, arr);
          }
          if (!by.size) return text('No activity from other employees in that period.');
          return text([...by].map(([id, lines]) => `## ${id}\n${lines.slice(-60).join('\n')}`).join('\n\n'));
        },
      ),
      tool('list_routines', 'List scheduled routines (id, schedule, employee, prompt excerpt) with next/last run times.', {}, async () =>
        text(JSON.stringify(api.routines().map(routineOut), null, 2)),
      ),
      tool('list_skills', 'List office skills (invoked as office:<name>) with description, office-allow rules and whether the manager-approved version is current.', {}, async () =>
        text(JSON.stringify(api.skills(), null, 2)),
      ),
      tool(
        'save_skill',
        'Create or overwrite an office skill (workspaces/office-skills/skills/<name>/SKILL.md, invoked as office:<name>). ' +
          'Waits for the manager\'s approval; once approved, a routine running this skill gets the `allow` rules auto-allowed.',
        {
          name: z.string().describe('lowercase-kebab id, e.g. "weekly-job-report"'),
          description: z.string().describe("one sentence in the manager's language: what it does and when to use it"),
          body: z.string().describe('markdown instructions (no frontmatter): goal, exact steps/commands, output paths, unattended rules, what to report'),
          allow: z
            .array(z.string())
            .optional()
            .describe(
              'minimal tool rules auto-allowed during routine runs: exact tool names (e.g. "mcp__office__list_tasks") or "Bash(<exact command prefix>*)". ' +
                'Bash rules never match commands containing ; & | > < ` $( or newlines, so keep commands single and use Edit/Write for file changes.',
            ),
        },
        async ({ name, description, body, allow }) => {
          try {
            const v = api.saveSkill(name, description, body, allow ?? []);
            return text(`saved skill office:${v.name} (approved, auto-allow: ${v.allow.join(', ') || 'none'})`);
          } catch (e) {
            return text((e as Error).message, true);
          }
        },
      ),
      tool(
        'create_routine',
        'Register a new scheduled routine. With `skill`, the employee runs office:<skill> at each cron match (preferred); otherwise `prompt` is sent as-is. Only when the manager asked for it.',
        {
          name: z.string().describe('short display name in the manager\'s language, e.g. "Pre-lunch job check"'),
          schedule: z.string().describe(CRON_HELP),
          employee: z.string().describe('employee id who runs it (may be yourself)'),
          skill: z.string().optional().describe('office skill name (from list_skills / save_skill)'),
          prompt: z.string().optional().describe('with skill: optional extra notes; without skill: the full standalone instruction'),
          enabled: z.boolean().optional().describe('default true'),
        },
        async (input) => {
          try {
            return text(`created routine ${JSON.stringify(routineOut(api.createRoutine(input)))}`);
          } catch (e) {
            return text((e as Error).message, true);
          }
        },
      ),
      tool(
        'update_routine',
        'Change fields of an existing routine (id from list_routines). Omitted fields stay the same.',
        {
          id: z.string(),
          name: z.string().optional(),
          schedule: z.string().optional().describe(CRON_HELP),
          employee: z.string().optional(),
          skill: z.string().optional().describe('office skill name; empty string = no skill'),
          prompt: z.string().optional(),
          enabled: z.boolean().optional(),
        },
        async ({ id, ...patch }) => {
          try {
            return text(`updated routine ${JSON.stringify(routineOut(api.updateRoutine(id, patch)))}`);
          } catch (e) {
            return text((e as Error).message, true);
          }
        },
      ),
      tool(
        'delete_routine',
        'Permanently delete a routine (id from list_routines). The manager must confirm; only when the manager asked for it.',
        { id: z.string(), name: z.string().optional().describe('the routine name, shown to the manager in the approval card') },
        async ({ id }) => {
          try {
            return text(`deleted routine ${api.deleteRoutine(id).name} (${id})`);
          } catch (e) {
            return text((e as Error).message, true);
          }
        },
      ),
      tool(
        'create_task',
        'Add a task to the board. With `assignee` (employee id) the employee starts on it right away, or at `startAt` if given.',
        {
          title: z.string(),
          detail: z.string().optional(),
          assignee: z.string().optional().describe('employee id, e.g. lit, model, data, eval'),
          requireApproval: z
            .boolean()
            .optional()
            .describe(
              'true = the assignee must get the manager\'s approval for every non-whitelisted tool call on this task, even if they are on auto mode. ' +
                'Use it for risky or hard-to-undo work: deleting/overwriting files or data, git push/merge, cancelling or submitting large GPU jobs, anything sent outside the lab.',
            ),
          startAt: z
            .string()
            .optional()
            .describe(
              'one-off scheduled start, local time "YYYY-MM-DDTHH:mm" (e.g. "2026-01-31T09:00"); needs `assignee`. ' +
                'The card waits on the board until then. If unsure of the current date/time, run `date` first.',
            ),
          attachments: z
            .array(z.number().int())
            .optional()
            .describe('attachment ids (#N in the "Attachments" section of your instructions) to hand to the assignee; they get the file paths in their task'),
        },
        async ({ title, detail, assignee, requireApproval, startAt, attachments }) => {
          if (assignee && !api.employees().some((e) => e.id === assignee)) return text(`unknown employee ${assignee}`, true);
          if (assignee === selfId) return text('You cannot delegate a task to yourself.', true);
          let at: number | null = null;
          if (startAt) {
            if (!assignee) return text('startAt needs an assignee: who should start it at that time?', true);
            const p = parseStartAt(startAt);
            if ('error' in p) return text(p.error, true);
            at = p.ms;
          }
          const t = api.createTask(title, detail ?? '', assignee ?? null, selfId, !!requireApproval, attachments ?? [], at);
          const missing = (attachments ?? []).filter((id) => !t.attachments.some((a) => a.id === id));
          return text(
            `created task #${t.id}${t.startAt ? `, scheduled: ${assignee} starts it ${fmtWhen(t.startAt)}` : assignee ? ` and assigned to ${assignee}` : ''}${requireApproval ? ' (🔒 every tool call needs approval)' : ''}` +
              (t.attachments.length ? `, attachments ${t.attachments.map((a) => `#${a.id}`).join(' ')}` : '') +
              (missing.length ? ` (ignored unknown attachment ids: ${missing.join(', ')})` : ''),
          );
        },
      ),
    ],
  });
}
