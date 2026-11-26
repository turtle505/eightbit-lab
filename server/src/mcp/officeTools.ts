import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RoutineInput } from '../routines.ts';
import { fmtWhen, parseStartAt } from '../schedule.ts';
import { normalizeTopic } from '../../../shared/topics.ts';
import type { EmployeeView, Engine, Job, LogLine, RoutineView, ServerView, SkillView, Task, UsageView } from '../../../shared/protocol.ts';

/** What the office exposes to the secretary. Wired up in index.ts. */
export interface OfficeApi {
  employees(): EmployeeView[];
  tasks(): Task[];
  jobs(): Job[];
  servers(): ServerView[];
  routines(): RoutineView[];
  logsSince(ts: number): LogLine[];
  /** subscription quota per engine (the lead routes work away from one that's nearly spent) */
  usage(): { claude: UsageView; codex: UsageView };
  createTask(
    title: string,
    detail: string,
    assignee: string | null,
    createdBy: string | null,
    requireApproval?: boolean,
    attachmentIds?: number[],
    startAt?: number | null,
    engine?: Engine | null,
    afterTask?: number | null,
    topic?: string | null,
  ): Task;
  createRoutine(input: RoutineInput): RoutineView;
  updateRoutine(id: string, patch: Partial<RoutineInput>): RoutineView;
  deleteRoutine(id: string): RoutineView;
  skills(): SkillView[];
  saveSkill(name: string, description: string, body: string, allow: string[]): SkillView;
}

const REVIEW_CLIP = 4000;
const otherEngine = (e: Engine): Engine => (e === 'claude' ? 'codex' : 'claude');

/**
 * `create_task` engine choice and detail: an explicit engine wins; a review of task #N defaults to the engine
 * that did *not* do #N (an independent second opinion), and carries #N's result so the reviewer sees it.
 */
export function planTaskEngine(
  input: { engine?: Engine; reviewOf?: number; detail?: string },
  tasks: Task[],
  employees: Pick<EmployeeView, 'id' | 'engine'>[],
): { engine: Engine | null; detail: string } | { error: string } {
  let detail = input.detail ?? '';
  let engine: Engine | null = input.engine ?? null;
  if (input.reviewOf != null) {
    const r = tasks.find((t) => t.id === input.reviewOf);
    if (!r) return { error: `reviewOf: there is no task #${input.reviewOf}.` };
    const ranOn: Engine = r.engine ?? employees.find((e) => e.id === r.assignee)?.engine ?? 'claude';
    engine ??= otherEngine(ranOn);
    const result = r.result?.trim() ? clip(r.result.trim(), REVIEW_CLIP) : '(no result recorded; look at the files it changed)';
    detail =
      `${detail ? `${detail}\n\n` : ''}Review the work of task #${r.id} "${r.title}" (done by ${r.assignee ?? 'someone'} on ${ranOn}). ` +
      `Check it independently: correctness, missing cases, and whether it does what was asked. Report concrete problems with where they are, or say it holds up.\n\n` +
      `Task #${r.id} instruction:\n${clip(r.detail || '(none)', 1500)}\n\nIts result:\n${result}`;
  }
  return { engine, detail };
}

const usageRows = (u: UsageView) => (u.available ? u.rows.map((r) => ({ window: r.label, usedPercent: r.percent, resets: r.resetsAt ? new Date(r.resetsAt).toLocaleString('en-US') : null })) : u.note || 'unavailable');

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
      'Each employee runs on Claude or Codex by default (office_status shows it and both quotas); create_task `engine` runs one task on the other, ' +
      'and `reviewOf` makes a review task that by default goes to the engine that did not do the work. Prefer the other engine when one quota is above ~85%. ' +
      'Routines (create_routine / update_routine / delete_routine) change the office schedule: use them only when the manager asked; every call waits for the manager\'s approval. ' +
      'A routine should normally run an office skill (save_skill → create_routine with `skill`) instead of carrying a long prompt.',
    tools: [
      tool('office_status', 'Snapshot of every employee (default engine, status, current activity, task), Claude and Codex quota, jobs and servers.', {}, async () => {
        const emps = api.employees().map((e) => ({ id: e.id, name: e.name, title: e.title, engine: e.engine, status: e.status, activity: e.activity, taskId: e.taskId }));
        const jobs = api.jobs().slice(-20).map((j) => ({ id: j.id, name: j.name, server: j.server, state: j.state, by: j.submittedBy, updated: new Date(j.updatedAt).toLocaleString('en-US') }));
        const servers = api.servers().map((s) => ({ name: s.name, online: s.online, gpus: s.gpus.map((g) => `${g.util}%`).join(' '), note: s.note }));
        const u = api.usage();
        const quota = { claude: usageRows(u.claude), codex: usageRows(u.codex) };
        return text(JSON.stringify({ employees: emps, quota, jobs, servers }, null, 2));
      }),
      tool(
        'list_tasks',
        'List tasks on the board, optionally filtered by state.',
        { state: z.enum(['todo', 'doing', 'review', 'done']).optional() },
        async ({ state }) => {
          const ts = api.tasks().filter((t) => !state || t.state === state);
          return text(
            JSON.stringify(
              ts.map((t) => ({ id: t.id, title: t.title, state: t.state, assignee: t.assignee, topic: t.topic, createdBy: t.createdBy, result: t.result ? clip(t.result, 600) : null, updated: new Date(t.updatedAt).toLocaleString('en-US') })),
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
        'Add a task to the board. With `assignee` (employee id) the employee starts on it right away, or at `startAt` if given, or when task `after` finishes. ' +
          '`engine` runs this one task on Claude or Codex instead of the assignee\'s default; `reviewOf` turns it into a review of another task.',
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
          engine: z
            .enum(['claude', 'codex'])
            .optional()
            .describe(
              'Run this one task on this engine instead of the assignee\'s default (office_status shows defaults and quota). ' +
                'claude for anything that needs the web (Codex has no network); codex suits in-repo code work; ' +
                'for a second opinion use the engine that did not do the work (reviewOf does this by default); switch away from an engine whose quota is nearly spent. Omit to use the default.',
            ),
          reviewOf: z
            .number()
            .int()
            .optional()
            .describe('task id to review: its instruction and result are added to this task, and `engine` defaults to the other engine than the one that did it'),
          topic: z
            .string()
            .optional()
            .describe(
              'the research subject this task belongs to, as a short folder name (a-z, 0-9, hyphens), e.g. "design-survey". ' +
                'The assignee saves its reports under reports/<topic>/. Reuse a topic that list_tasks already shows when the work continues it; a task with `after` inherits that task\'s topic.',
            ),
          after: z
            .number()
            .int()
            .optional()
            .describe(
              'task id this one follows: it waits (with its assignee) until that task has finished, then starts by itself with that task\'s result in its instructions. ' +
                'Use it for a step that needs an earlier step\'s output, instead of waiting and assigning it yourself. Needs `assignee`; not together with `startAt`.',
            ),
          attachments: z
            .array(z.number().int())
            .optional()
            .describe('attachment ids (#N in the "Attachments" section of your instructions) to hand to the assignee; they get the file paths in their task'),
        },
        async ({ title, detail, assignee, requireApproval, startAt, engine, reviewOf, after, topic, attachments }) => {
          const subject = normalizeTopic(topic);
          if ('error' in subject) return text(`topic: ${subject.error}.`, true);
          if (assignee && !api.employees().some((e) => e.id === assignee)) return text(`unknown employee ${assignee}`, true);
          if (assignee === selfId) return text('You cannot delegate a task to yourself.', true);
          let at: number | null = null;
          if (startAt) {
            if (!assignee) return text('startAt needs an assignee: who should start it at that time?', true);
            const p = parseStartAt(startAt);
            if ('error' in p) return text(p.error, true);
            at = p.ms;
          }
          if (after != null) {
            if (!assignee) return text('after needs an assignee: who should start it when that task finishes?', true);
            if (startAt) return text('Use either after or startAt, not both: a task that follows another starts when that one finishes.', true);
            if (!api.tasks().some((t) => t.id === after)) return text(`after: there is no task #${after}.`, true);
          }
          const plan = planTaskEngine({ engine, reviewOf, detail }, api.tasks(), api.employees());
          if ('error' in plan) return text(plan.error, true);
          const codex = api.usage().codex;
          const codexWarn = plan.engine === 'codex' && !codex.available ? ` (warning: Codex looks unavailable on this machine: ${codex.note || 'no quota info'}; the task may fail)` : '';
          const t = api.createTask(title, plan.detail, assignee ?? null, selfId, !!requireApproval, attachments ?? [], at, plan.engine, after ?? null, subject.topic);
          const waiting = t.afterTask != null && t.state === 'todo';
          const missing = (attachments ?? []).filter((id) => !t.attachments.some((a) => a.id === id));
          return text(
            `created task #${t.id}${waiting ? `, waiting: ${assignee} starts it when task #${t.afterTask} finishes` : t.startAt ? `, scheduled: ${assignee} starts it ${fmtWhen(t.startAt)}` : assignee ? ` and assigned to ${assignee}` : ''}${requireApproval ? ' (🔒 every tool call needs approval)' : ''}` +
              (t.topic ? `, topic ${t.topic}` : '') +
              (t.attachments.length ? `, attachments ${t.attachments.map((a) => `#${a.id}`).join(' ')}` : '') +
              (missing.length ? ` (ignored unknown attachment ids: ${missing.join(', ')})` : '') +
              (t.engine ? `, runs on ${t.engine} (this task only)${reviewOf != null ? `, reviewing #${reviewOf}` : ''}` : '') +
              codexWarn,
          );
        },
      ),
    ],
  });
}
