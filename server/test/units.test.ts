import { describe, expect, it } from 'vitest';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { CodexTools } from '../src/agents/codexTools.ts';
import { codexUsageRows } from '../src/codexUsage.ts';
import { statusForTool } from '../src/agents/status.ts';

describe('Codex office tool bridge', () => {
  it('exposes and calls existing MCP tools', async () => {
    const bridge = new CodexTools();
    try {
      const server = createSdkMcpServer({ name: 'office', version: '1.0.0', tools: [
        tool('ping', 'Return a marker', {}, async () => ({ content: [{ type: 'text', text: 'office-ready' }] })),
      ] });
      await bridge.add('office', server.instance);
      expect(bridge.specs[0].tools.map((t) => t.name)).toEqual(['ping']);
      await expect(bridge.call('office', 'ping', {})).resolves.toMatchObject({ success: true, contentItems: [{ text: 'office-ready' }] });
    } finally {
      await bridge.close();
    }
  });
});

describe('Codex subscription usage', () => {
  it('reads the Codex bucket and converts reset seconds to milliseconds', () => {
    const rows = codexUsageRows({ rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
    } } });
    expect(rows).toMatchObject([
      { kind: 'session', percent: 25, resetsAt: 1_800_000_000_000, severity: 'normal' },
      { kind: 'weekly_all', percent: 90, resetsAt: 1_800_100_000_000, severity: 'critical' },
    ]);
  });
  it('leaves missing limits unavailable', () => {
    expect(codexUsageRows({ rateLimits: {} })).toEqual([]);
  });
});
import { parseNvidiaSmi } from '../src/compute/adapter.ts';
import { SshAdapter, parseSshStatus } from '../src/compute/ssh.ts';
import { SlurmAdapter, parseSlurmState } from '../src/compute/slurm.ts';
import { PermissionBroker } from '../src/permissions/broker.ts';
import { Store } from '../src/db.ts';

describe('statusForTool', () => {
  it('maps tools to character states', () => {
    expect(statusForTool('Bash', { command: 'ls' }).status).toBe('running');
    expect(statusForTool('WebSearch', { query: 'diffusion models' }).status).toBe('researching');
    expect(statusForTool('Edit', { file_path: '/a/b/model.py' }).activity).toContain('model.py');
    const r = statusForTool('mcp__lab__submit_job', { server: 'gpu-a', name: 'train' });
    expect(r.status).toBe('remote');
    expect(r.activity).toContain('to gpu-a');
  });
});

describe('parsers', () => {
  it('nvidia-smi csv', () => {
    const g = parseNvidiaSmi('0, NVIDIA A100-SXM4-80GB, 97, 70000, 81920\n1, NVIDIA A100-SXM4-80GB, 0, 3, 81920\n');
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ index: 0, util: 97, memUsed: 70000, memTotal: 81920 });
  });
  it('slurm states', () => {
    expect(parseSlurmState('PENDING\n')).toBe('pending');
    expect(parseSlurmState('RUNNING')).toBe('running');
    expect(parseSlurmState('  COMPLETED ')).toBe('completed');
    expect(parseSlurmState('CANCELLED by 1234')).toBe('cancelled');
    expect(parseSlurmState('OUT_OF_MEMORY')).toBe('failed');
    expect(parseSlurmState('')).toBe('unknown');
  });
  it('ssh states', () => {
    expect(parseSshStatus('RUNNING\n')).toBe('running');
    expect(parseSshStatus('EXIT=0')).toBe('completed');
    expect(parseSshStatus('EXIT=1')).toBe('failed');
    expect(parseSshStatus('CANCELLED')).toBe('cancelled');
  });
});

describe('adapters (fake ssh)', () => {
  const cfg = { name: 'x', type: 'ssh' as const, ssh_host: 'x', workdir: '~/jobs', setup: 'conda activate p' };

  it('ssh submit builds a detached job and parses pid/dir', async () => {
    let script = '';
    const a = new SshAdapter(cfg, async (_h, s) => {
      script = s;
      return { code: 0, stdout: 'PID=4242\nJD=/home/me/jobs/1_train\n', stderr: '' };
    });
    const r = await a.submit({ name: 'train', command: 'python train.py' });
    expect(r.remoteId).toBe('4242:/home/me/jobs/1_train');
    expect(r.logPath).toBe('/home/me/jobs/1_train/out.log');
    expect(script).toContain('setsid nohup');
    expect(script).toContain('conda activate p');
    expect(script).toContain('python train.py');
  });

  it('slurm submit adds #SBATCH headers', async () => {
    let script = '';
    const a = new SlurmAdapter({ ...cfg, type: 'slurm', slurm: { partition: 'gpu', gres: 'gpu:1', time: '1:00:00' } }, async (_h, s) => {
      script = s;
      return { code: 0, stdout: 'JOBID=991\nJD=/home/me/jobs/2_x\n', stderr: '' };
    });
    const r = await a.submit({ name: 'x', command: 'echo hi', gpus: 2 });
    expect(r.remoteId).toBe('991');
    expect(script).toContain('#SBATCH --partition=gpu');
    expect(script).toContain('#SBATCH --gres=gpu:2');
    expect(script).toContain('sbatch --parsable');
  });

  it('ssh gpuStats surfaces errors when host is down', async () => {
    const a = new SshAdapter(cfg, async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host x port 22: Connection refused' }));
    await expect(a.gpuStats()).rejects.toThrow(/Connection refused/);
  });
});

describe('PermissionBroker', () => {
  it('resolves allow / deny and abort', async () => {
    const b = new PermissionBroker();
    const ac = new AbortController();
    const p1 = b.request('lit', 'Bash', { command: 'ls' }, ac.signal);
    const [a1] = b.list();
    b.answer(a1.id, true);
    expect((await p1).behavior).toBe('allow');

    const p2 = b.request('lit', 'Bash', { command: 'rm -rf x' }, ac.signal);
    b.answer(b.list()[0].id, false);
    expect((await p2).behavior).toBe('deny');

    const ac2 = new AbortController();
    const p3 = b.request('lit', 'Bash', {}, ac2.signal);
    ac2.abort();
    expect((await p3).behavior).toBe('deny');
    expect(b.list()).toHaveLength(0);
  });
});

describe('Store', () => {
  it('tasks and jobs roundtrip', () => {
    const s = new Store(':memory:');
    const t = s.createTask('요약', '', null);
    expect(s.updateTask(t.id, { assignee: 'lit', state: 'doing' })?.state).toBe('doing');
    const j = s.createJob({ server: 'a', remoteId: '1', name: 'n', command: 'c', submittedBy: 'model', state: 'pending', logPath: '/l' });
    expect(s.activeJobs()).toHaveLength(1);
    s.setJobState(j.id, 'completed');
    expect(s.activeJobs()).toHaveLength(0);
  });

  it('stores employee display names', () => {
    const s = new Store(':memory:');
    expect(s.getEmployeeName('lit')).toBeNull();
    s.setEmployeeName('lit', '문헌 리서처 "Bo"');
    expect(s.getEmployeeName('lit')).toBe('문헌 리서처 "Bo"');
    s.setEmployeeName('lit', null);
    expect(s.getEmployeeName('lit')).toBeNull();
  });

  it('records who delegated a task', () => {
    const s = new Store(':memory:');
    expect(s.createTask('직접', '', null).createdBy).toBeNull();
    const t = s.createTask('위임', '', null, 'lead');
    expect(s.getTask(t.id)?.createdBy).toBe('lead');
    expect(s.updateTask(t.id, { state: 'review' })?.createdBy).toBe('lead');
  });
});

import { cronMatches, nextRun, parseCron } from '../src/cron.ts';
import { isAutoAllowed } from '../src/agents/manager.ts';
import { RoutineScheduler } from '../src/routines.ts';

describe('cron', () => {
  it('weekday 09:00', () => {
    const c = parseCron('0 9 * * 1-5');
    expect(cronMatches(c, new Date(2026, 10, 23, 9, 0))).toBe(true); // Mon
    expect(cronMatches(c, new Date(2026, 10, 22, 9, 0))).toBe(false); // Sun
    expect(cronMatches(c, new Date(2026, 10, 23, 9, 1))).toBe(false);
    expect(nextRun(c, new Date(2026, 10, 21, 12, 0))?.getDate()).toBe(23); // Sat → Mon
  });
  it('steps, lists, sunday=7', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 8,20 * * 7').dow.has(0)).toBe(true);
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('0 9 * *')).toThrow();
  });
});

describe('isAutoAllowed', () => {
  it('exact and server-level rules', () => {
    const r = ['Read', 'mcp__plugin_acme_papers'];
    expect(isAutoAllowed(r, 'Read')).toBe(true);
    expect(isAutoAllowed(r, 'mcp__plugin_acme_papers__search_preprints')).toBe(true);
    expect(isAutoAllowed(r, 'mcp__plugin_acme_papers_evil__x')).toBe(false);
    expect(isAutoAllowed(r, 'Bash')).toBe(false);
  });
});

describe('RoutineScheduler', () => {
  it('fires once per matching minute, respects toggle', () => {
    const store = new Store(':memory:');
    const fired: string[] = [];
    const sch = new RoutineScheduler(
      [{ id: 'r', name: 'R', schedule: '0 9 * * *', employee: 'sec', prompt: 'p' }],
      store,
      (emp) => fired.push(emp),
      () => true,
    );
    const nine = new Date(2026, 10, 23, 9, 0, 5);
    sch.tick(nine);
    sch.tick(new Date(2026, 10, 23, 9, 0, 40)); // same minute → no refire
    expect(fired).toEqual(['sec']);
    sch.setEnabled('r', false);
    sch.tick(new Date(2026, 10, 24, 9, 0, 1));
    expect(fired).toHaveLength(1);
    expect(sch.list()[0].nextRun).toBeNull();
  });
  it('skips routines for unknown employees', () => {
    const sch = new RoutineScheduler([{ id: 'x', name: 'X', schedule: '0 9 * * *', employee: 'ghost', prompt: 'p' }], new Store(':memory:'), () => {}, () => false);
    expect(sch.list()).toHaveLength(0);
  });

  const seed = [{ id: 'y', name: 'Y', schedule: '0 9 * * *', employee: 'sec', prompt: 'p', enabled: false }];
  const isEmp = (id: string) => id === 'sec' || id === 'lit';

  it('seeds YAML routines into the DB once; DB wins afterwards', () => {
    const store = new Store(':memory:');
    const a = new RoutineScheduler(seed, store, () => {}, isEmp);
    expect(a.list().map((r) => [r.id, r.enabled])).toEqual([['y', false]]);
    a.update('y', { name: 'Y2' });
    const b = new RoutineScheduler(seed, store, () => {}, isEmp);
    expect(b.list().map((r) => r.name)).toEqual(['Y2']);
  });

  it('keeps a toggle saved before the DB migration', () => {
    const store = new Store(':memory:');
    store.setRoutineState('y', { enabled: true });
    expect(new RoutineScheduler(seed, store, () => {}, isEmp).list()[0].enabled).toBe(true);
  });

  it('creates, updates and fires routines without restart', () => {
    const fired: string[] = [];
    const sch = new RoutineScheduler([], new Store(':memory:'), (emp, prompt) => fired.push(`${emp}:${prompt.split('\n')[1]}`), isEmp);
    const r = sch.create({ name: '점심', schedule: '0 12 * * *', employee: 'lit', prompt: 'go' });
    expect(r.id).toMatch(/^r-/);
    const now = new Date(2026, 10, 23, 8, 0);
    expect(sch.view((sch as any).find(r.id), now).nextRun).toBe(new Date(2026, 10, 23, 12, 0).getTime());
    sch.update(r.id, { schedule: '30 10 * * *', prompt: 'go2' });
    expect(sch.view((sch as any).find(r.id), now).nextRun).toBe(new Date(2026, 10, 23, 10, 30).getTime());
    sch.tick(new Date(2026, 10, 23, 10, 30, 3));
    expect(fired).toEqual(['lit:go2']);
  });

  it('rejects bad cron / unknown employee / empty prompt', () => {
    const sch = new RoutineScheduler([], new Store(':memory:'), () => {}, isEmp);
    expect(() => sch.create({ name: 'a', schedule: '0 9 * *', employee: 'sec', prompt: 'p' })).toThrow(/cron/);
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'ghost', prompt: 'p' })).toThrow(/employee/);
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec', prompt: ' ' })).toThrow(/prompt/);
    expect(sch.list()).toHaveLength(0);
    const r = sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec', prompt: 'p' });
    expect(() => sch.update(r.id, { schedule: '99 9 * * *' })).toThrow(/cron/);
    expect(sch.list()[0].schedule).toBe('0 9 * * *');
  });

  it('deleted routines stay deleted even if still in the YAML', () => {
    const store = new Store(':memory:');
    const a = new RoutineScheduler(seed, store, () => {}, isEmp);
    a.remove('y');
    expect(a.list()).toHaveLength(0);
    expect(new RoutineScheduler(seed, store, () => {}, isEmp).list()).toHaveLength(0);
    expect(() => a.run('y')).toThrow();
  });
});

import { mergeByKey } from '../src/config.ts';

describe('mergeByKey (.local.yaml overrides)', () => {
  it('overrides same key, appends new', () => {
    const base = [
      { id: 'a', name: 'A', prompt: 'base' },
      { id: 'b', name: 'B', prompt: 'base' },
    ];
    const out = mergeByKey(base, [{ id: 'b', prompt: 'mine' } as any, { id: 'c', name: 'C', prompt: 'new' }], 'id');
    expect(out).toEqual([
      { id: 'a', name: 'A', prompt: 'base' },
      { id: 'b', name: 'B', prompt: 'mine' },
      { id: 'c', name: 'C', prompt: 'new' },
    ]);
    expect(base[1].prompt).toBe('base'); // base not mutated
  });
});

import { toUsageRows } from '../src/usage.ts';

describe('toUsageRows', () => {
  it('uses the server limits[] rows (session, weekly, model-scoped)', () => {
    const rows = toUsageRows({
      subscription_type: 'team',
      rate_limits_available: true,
      rate_limits: {
        limits: [
          { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: '2026-11-23T10:40:00+00:00', scope: null },
          { kind: 'weekly_all', group: 'weekly', percent: 41.6, severity: 'warning', resets_at: '2026-11-28T16:00:00+00:00', scope: null },
          { kind: 'weekly_scoped', group: 'weekly', percent: 1, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Fable' } } },
        ],
      },
    });
    expect(rows.map((r) => [r.kind, r.label, r.percent, r.severity])).toEqual([
      ['session', 'Session (5 h)', 5, 'normal'],
      ['weekly_all', 'Weekly (all)', 42, 'warning'],
      ['weekly_scoped', 'Weekly · Fable', 1, 'normal'],
    ]);
    expect(rows[0].resetsAt).toBe(Date.parse('2026-11-23T10:40:00+00:00'));
  });
  it('falls back to five_hour / seven_day when limits[] is missing', () => {
    const rows = toUsageRows({ rate_limits: { five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 10, resets_at: null } } });
    expect(rows.map((r) => [r.kind, r.percent, r.severity])).toEqual([
      ['session', 80, 'warning'],
      ['weekly_all', 10, 'normal'],
    ]);
  });
});

import { matchesRule } from '../src/agents/manager.ts';
import { SkillLibrary } from '../src/skills.ts';
import { routinePrompt } from '../src/routines.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('matchesRule (skill auto-allow)', () => {
  const rule = 'Bash(python3 "/v/.scripts/daily_note.py" --vault "/v"*)';
  it('Bash prefix rules match only plain commands with that prefix', () => {
    expect(matchesRule(rule, 'Bash', { command: 'python3 "/v/.scripts/daily_note.py" --vault "/v"' })).toBe(true);
    expect(matchesRule(rule, 'Bash', { command: 'python3 "/v/.scripts/daily_note.py" --vault "/v" --dry-run' })).toBe(true);
    expect(matchesRule(rule, 'Bash', { command: 'python3 "/v/.scripts/other.py"' })).toBe(false);
    expect(matchesRule(rule, 'Read', { command: 'python3 "/v/.scripts/daily_note.py" --vault "/v"' })).toBe(false);
  });
  it('rejects chaining, substitution and redirection', () => {
    for (const tail of [' ; rm -rf ~', ' && curl x', ' | sh', ' > /etc/x', ' $(id)', ' `id`', '\nrm x', ' & sleep 1'])
      expect(matchesRule(rule, 'Bash', { command: `python3 "/v/.scripts/daily_note.py" --vault "/v"${tail}` })).toBe(false);
  });
  it('plain rules behave like isAutoAllowed; other parenthesised forms are ignored', () => {
    expect(matchesRule('mcp__office__list_tasks', 'mcp__office__list_tasks', {})).toBe(true);
    expect(matchesRule('mcp__lab', 'mcp__lab__submit_job', {})).toBe(true);
    expect(matchesRule('Edit(/v/**)', 'Edit', { file_path: '/v/x' })).toBe(false);
  });
});

describe('SkillLibrary', () => {
  const setup = () => {
    const store = new Store(':memory:');
    const lib = new SkillLibrary(mkdtempSync(join(tmpdir(), 'office-skills-')), store);
    lib.ensure();
    return { store, lib };
  };
  it('writes a plugin manifest and lists saved skills as approved', () => {
    const { lib } = setup();
    expect(JSON.parse(readFileSync(join(lib.dir, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('office');
    const v = lib.save('daily-note', '데일리 노트', '# 본문', ['Bash(python3 x*)']);
    expect(v).toEqual({ name: 'daily-note', description: '데일리 노트', allow: ['Bash(python3 x*)'], approved: true });
    expect(lib.list().map((k) => k.name)).toEqual(['daily-note']);
    expect(lib.allowFor('daily-note')).toEqual(['Bash(python3 x*)']);
    expect(lib.has('daily-note')).toBe(true);
    expect(lib.has('nope')).toBe(false);
  });
  it('an edited skill loses its auto-allow until re-approved', () => {
    const { lib } = setup();
    lib.save('a-skill', 'd', 'body', ['Bash(ls*)']);
    const f = join(lib.dir, 'skills/a-skill/SKILL.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('Bash(ls*)', 'Bash(*)'));
    expect(lib.allowFor('a-skill')).toBeNull();
    expect(lib.view('a-skill')!.approved).toBe(false);
    lib.approve('a-skill');
    expect(lib.allowFor('a-skill')).toEqual(['Bash(*)']);
  });
  it('rejects bad names and empty content', () => {
    const { lib } = setup();
    expect(() => lib.save('../evil', 'd', 'b', [])).toThrow(/Skill names/);
    expect(() => lib.save('Bad Name', 'd', 'b', [])).toThrow(/Skill names/);
    expect(() => lib.save('ok-name', ' ', 'b', [])).toThrow(/description/);
    expect(lib.allowFor('missing')).toBeNull();
  });
});

describe('RoutineScheduler with skills', () => {
  const isEmp = () => true;
  it('requires an existing skill or a prompt, and builds a skill instruction', () => {
    const fired: Array<[string, string | null]> = [];
    const sch = new RoutineScheduler([], new Store(':memory:'), (_e, p, _n, sk) => fired.push([p, sk]), isEmp, (n) => n === 'daily-note');
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec', skill: 'ghost' })).toThrow(/skill/);
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec' })).toThrow(/prompt/);
    const r = sch.create({ name: '노트', schedule: '0 9 * * *', employee: 'sec', skill: 'daily-note' });
    expect(r.skill).toBe('daily-note');
    sch.run(r.id, new Date(2026, 10, 23, 9, 0));
    expect(fired[0][1]).toBe('daily-note');
    expect(fired[0][0]).toContain('`office:daily-note`');
    expect(fired[0][0]).not.toContain('Additional notes');
    sch.update(r.id, { skill: '', prompt: 'plain' });
    expect(sch.list()[0].skill).toBeNull();
  });
  it('routinePrompt appends notes for skill routines and passes plain prompts through', () => {
    const now = new Date(2026, 10, 23, 9, 0);
    expect(routinePrompt({ name: 'n', prompt: '오늘은 짧게', skill: 's' }, now)).toMatch(/office:s[\s\S]*Additional notes: 오늘은 짧게$/);
    expect(routinePrompt({ name: 'n', prompt: 'do it', skill: null }, now)).toMatch(/^\[Routine: n · .*\]\ndo it$/);
  });
  it('adds the skill column to a routines table from the previous version', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'office-db-')), 'office.db');
    const old = new DatabaseSync(f);
    old.exec(`CREATE TABLE routines (id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, employee TEXT NOT NULL,
      prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);
      INSERT INTO routines VALUES ('x', 'X', '0 9 * * *', 'sec', 'p', 1, 1, 1, NULL);`);
    old.close();
    const store = new Store(f);
    expect(store.listRoutines()[0]).toMatchObject({ id: 'x', skill: null });
  });
});

import { ReportLibrary, reportRoots } from '../src/reports.ts';
import { mkdirSync, utimesSync } from 'node:fs';

describe('ReportLibrary', () => {
  const setup = () => {
    const ws = mkdtempSync(join(tmpdir(), 'office-ws-'));
    const w = (rel: string, text: string) => {
      const p = join(ws, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text);
      return p;
    };
    w('secretary/reports/daily/2026-11-23-mail.md', '# 11/23 메일\n\n본문');
    w('secretary/reports/weekly/w47.md', '본문만 있고 제목 없음');
    w('secretary/reports/notes.txt', 'not markdown');
    w('secretary/reports/.hidden/x.md', '# hidden');
    w('secretary/other.md', '# outside reports');
    w('office-skills/reports/skill.md', '# skill');
    w('lit/reports/papers.md', '# 논문');
    const roots = () => reportRoots(ws, [], (dir) => (dir.endsWith('secretary') ? 'sec' : null));
    return { ws, w, lib: new ReportLibrary(roots) };
  };

  it('collects .md under <desk>/reports, with titles and employees', () => {
    const { lib } = setup();
    const list = lib.scan();
    expect(list.map((r) => r.path).sort()).toEqual([
      'lit/reports/papers.md',
      'secretary/reports/daily/2026-11-23-mail.md',
      'secretary/reports/weekly/w47.md',
    ]);
    const mail = list.find((r) => r.path.endsWith('mail.md'))!;
    expect(mail).toMatchObject({ root: 'secretary/reports', employeeId: 'sec', title: '11/23 메일' });
    expect(list.find((r) => r.path.endsWith('w47.md'))!.title).toBe('w47');
    expect(list.find((r) => r.path.startsWith('lit/'))!.employeeId).toBeNull();
  });

  it('reads only listed files', () => {
    const { lib } = setup();
    lib.scan();
    expect(lib.read('secretary/reports/daily/2026-11-23-mail.md').content).toContain('본문');
    expect(() => lib.read('secretary/other.md')).toThrow();
    expect(() => lib.read('secretary/reports/../other.md')).toThrow();
    expect(() => lib.read('/etc/passwd')).toThrow();
  });

  it('reports new and modified files on the next scan', () => {
    const { lib, w, ws } = setup();
    lib.scan();
    expect(lib.changes().any).toBe(false);
    w('secretary/reports/daily/new.md', '# 새 보고서');
    const touched = join(ws, 'lit/reports/papers.md');
    utimesSync(touched, new Date(), new Date(Date.now() + 5000));
    const c = lib.changes();
    expect(c.changed.map((f) => f.path).sort()).toEqual(['lit/reports/papers.md', 'secretary/reports/daily/new.md']);
    expect(c.list.find((f) => f.path.endsWith('new.md'))!.title).toBe('새 보고서');
    expect(lib.changes().changed).toEqual([]);
  });

  it('extra report dirs get a unique label', () => {
    const extra = mkdtempSync(join(tmpdir(), 'reports-'));
    const roots = reportRoots(mkdtempSync(join(tmpdir(), 'empty-ws-')), [extra], () => null);
    expect(roots).toEqual([{ label: extra.split('/').pop(), dir: extra, employeeId: null }]);
  });
});

describe('Store feed', () => {
  it('adds, updates, lists oldest-first and finds recent report cards by path', () => {
    const s = new Store(':memory:');
    const a = s.addFeed({ ts: 1000, kind: 'result', employeeId: 'sec', title: '⏰ 아침', body: '**ok**', path: null, ok: true });
    const b = s.addFeed({ ts: 2000, kind: 'report', employeeId: 'sec', title: 'R', body: '# R', path: 'secretary/reports/r.md', ok: true });
    expect(s.recentFeed().map((f) => f.id)).toEqual([a.id, b.id]);
    expect(s.lastFeedForPath('secretary/reports/r.md', 1500)?.id).toBe(b.id);
    expect(s.lastFeedForPath('secretary/reports/r.md', 2500)).toBeUndefined();
    expect(s.updateFeed(b.id, { ts: 3000, body: '# R2' })).toMatchObject({ id: b.id, ts: 3000, body: '# R2', title: 'R' });
    expect(s.recentFeed(1).map((f) => f.id)).toEqual([b.id]);
  });
});

import { applyTodoOp, dailyPath, parseDaily } from '../src/obsidian.ts';
import { TodayNote } from '../src/todos.ts';

const NOTE = [
  '#daily ', //                                    0
  '## ⏰ Schedule / Appointments', //               1
  '- 14:00 Team meeting', //                              2
  '', //                                            3
  '---', //                                         4
  '', //                                            5
  '## 🧬 Active Project', //                        6
  '**[[Weekly sync]]**', //                         7
  'sync_log:: ', //                                  8
  '', //                                            9
  '**[[Grant report]]**', //         10
  'grant_log::', //                                  11
  '- [ ] Outline the report ↻1', //                         12
  '- [x] Collect budget numbers ↻3', //               13
  '', //                                           14
  '**Paper draft**', //                          15
  'paper_log::', //                                 16
  'Due this week!', //                         17
  '- [ ] **Make the figures** ↻1', //              18
  '\t- Requested by the advisor.', //               19
  '\t  - Pipeline overview first', //                 20
  '\t- [ ] Results plot', //                         21
  '- [ ] Rewrite the methods', //                       22
  '', //                                           23
  '**Misc**', //                                    24
  '', //                                           25
  '', //                                           26
  '---', //                                        27
  '## 📚 Study', //                                28
  '[[Study/Study|Study]]', //                      29
  '**[[Statistics course]]**', //   30
  '', //                                           31
  '---', //                                        32
  '## 🏢 Office board', //            33
  '- [ ] should be ignored', //                             34
  '',
].join('\n');

describe('Obsidian daily note', () => {
  const PICKED = { sections: ['Schedule', 'Active Project', 'Study'], schedule: ['Schedule'] };

  it('parses picked sections, groups, carry markers, children and descriptions', () => {
    const secs = parseDaily(NOTE, PICKED);
    expect(secs.map((s) => s.kind)).toEqual(['schedule', 'tasks', 'tasks']);
    expect(secs[0].projects[0].memo).toEqual(['- 14:00 Team meeting']);
    const proj = secs[1].projects;
    expect(proj.map((p) => p.name)).toEqual(['', 'Weekly sync', 'Grant report', 'Paper draft', 'Misc']);
    expect(proj[1]).toMatchObject({ link: 'Weekly sync', items: [] });
    const grant = proj[2];
    expect(grant.items.map((i) => [i.text, i.checked, i.carry, i.line])).toEqual([
      ['Outline the report', false, 1, 12],
      ['Collect budget numbers', true, 3, 13],
    ]);
    const paper = proj[3];
    expect(paper.link).toBeNull();
    expect(paper.memo).toEqual(['Due this week!']);
    expect(paper.items.map((i) => i.text)).toEqual(['**Make the figures**', 'Rewrite the methods']);
    expect(paper.items[0].notes).toEqual([
      { depth: 0, text: 'Requested by the advisor.' },
      { depth: 1, text: 'Pipeline overview first' },
    ]);
    expect(paper.items[0].children.map((c) => [c.text, c.line])).toEqual([['Results plot', 21]]);
    expect(secs[2].projects.map((p) => p.name)).toEqual(['', 'Statistics course']);
    expect(JSON.stringify(secs)).not.toContain('should be ignored');
  });

  it('toggles and edits one line, keeping indentation and ↻N', () => {
    const t1 = applyTodoOp(NOTE, { op: 'toggle', line: 12, raw: '- [ ] Outline the report ↻1' });
    expect(t1.split('\n')[12]).toBe('- [x] Outline the report ↻1');
    expect(applyTodoOp(t1, { op: 'toggle', line: 12, raw: '- [x] Outline the report ↻1' })).toBe(NOTE);
    const t2 = applyTodoOp(NOTE, { op: 'edit', line: 21, raw: '\t- [ ] Results plot', text: ' Results\nplot v2 ' });
    expect(t2.split('\n')[21]).toBe('\t- [ ] Results plot v2');
    const t3 = applyTodoOp(NOTE, { op: 'edit', line: 18, raw: '- [ ] **Make the figures** ↻1', text: 'Three figures' });
    expect(t3.split('\n')[18]).toBe('- [ ] Three figures ↻1');
    expect(() => applyTodoOp(NOTE, { op: 'edit', line: 18, raw: '- [ ] **Make the figures** ↻1', text: '  ' })).toThrow(/empty/);
  });

  it('adds to the end of a block or under a parent, and deletes whole subtrees', () => {
    const a = applyTodoOp(NOTE, { op: 'add', headerLine: 10, headerRaw: '**[[Grant report]]**', text: 'New to-do' }).split('\n');
    expect(a.slice(12, 16)).toEqual(['- [ ] Outline the report ↻1', '- [x] Collect budget numbers ↻3', '- [ ] New to-do', '']);
    const empty = applyTodoOp(NOTE, { op: 'add', headerLine: 24, headerRaw: '**Misc**', text: 'Reply to email' }).split('\n');
    expect(empty.slice(24, 27)).toEqual(['**Misc**', '- [ ] Reply to email', '']);
    const lab = applyTodoOp(NOTE, { op: 'add', headerLine: 7, headerRaw: '**[[Weekly sync]]**', text: 'Prepare slides' }).split('\n');
    expect(lab.slice(7, 10)).toEqual(['**[[Weekly sync]]**', 'sync_log:: ', '- [ ] Prepare slides']);
    const sub = applyTodoOp(NOTE, {
      op: 'add', headerLine: 15, headerRaw: '**Paper draft**', text: 'Error bars', parentLine: 18, parentRaw: '- [ ] **Make the figures** ↻1',
    }).split('\n');
    expect(sub.slice(21, 24)).toEqual(['\t- [ ] Results plot', '\t- [ ] Error bars', '- [ ] Rewrite the methods']);
    const del = applyTodoOp(NOTE, { op: 'delete', line: 18, raw: '- [ ] **Make the figures** ↻1' }).split('\n');
    expect(del.slice(17, 20)).toEqual(['Due this week!', '- [ ] Rewrite the methods', '']);
  });

  it('refuses stale edits and keeps CRLF / trailing newline', () => {
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 12, raw: '- [ ] something else' })).toThrow(/changed/);
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 999, raw: 'x' })).toThrow(/changed/);
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 17, raw: 'Due this week!' })).toThrow(/checkbox/);
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const out = applyTodoOp(crlf, { op: 'toggle', line: 12, raw: '- [ ] Outline the report ↻1' });
    expect(out).toBe(crlf.replace('- [ ] Outline the report ↻1', '- [x] Outline the report ↻1'));
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('reads every section by default, and a note without headings as one block', () => {
    const secs = parseDaily(NOTE);
    expect(secs.map((s) => [s.kind, s.title])).toEqual([
      ['schedule', '⏰ Schedule / Appointments'],
      ['tasks', '🧬 Active Project'],
      ['tasks', '📚 Study'],
      ['tasks', '🏢 Office board'],
    ]);
    expect(secs[3].projects[0].items.map((i) => i.text)).toEqual(['should be ignored']);
    expect(parseDaily(NOTE, { sections: [], schedule: [] })[0].kind).toBe('tasks');

    const plain = ['---', 'tags: [daily]', '---', '# 2026-11-24', '- [ ] Buy milk', '- [x] Call Sam', '', 'Notes go here.'].join('\n');
    const [only] = parseDaily(plain);
    expect(only).toMatchObject({ kind: 'tasks', title: '', line: -1 });
    expect(only.projects[0].items.map((i) => [i.text, i.checked, i.line])).toEqual([['Buy milk', false, 4], ['Call Sam', true, 5]]);
    const added = applyTodoOp(plain, { op: 'add', headerLine: -1, headerRaw: '', text: 'Water plants' }).split('\n');
    expect(added.slice(-2)).toEqual(['Notes go here.', '- [ ] Water plants']);
    // an empty note still offers its block, so the first to-do can be added
    expect(parseDaily('')[0].projects[0].line).toBe(-1);
  });

  it('builds the daily path and reads/writes today\'s note', () => {
    expect(dailyPath('Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md', new Date(2026, 10, 23))).toBe('Daily/2026/2026.11.23.Mon.md');
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const note = new TodayNote({ vault, daily: 'Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md', createCommand: [], ...PICKED }, () => new Date(2026, 10, 23, 9));
    expect(note.load()).toMatchObject({ enabled: true, exists: false, relPath: 'Daily/2026/2026.11.23.Mon.md', vaultName: vault.split('/').pop(), canCreate: false });
    mkdirSync(join(vault, 'Daily/2026'), { recursive: true });
    writeFileSync(join(vault, 'Daily/2026/2026.11.23.Mon.md'), NOTE);
    expect(note.poll()?.exists).toBe(true);
    expect(note.poll()).toBeNull();
    const after = note.apply({ op: 'toggle', line: 22, raw: '- [ ] Rewrite the methods' });
    expect(after.sections[1].projects[3].items[1].checked).toBe(true);
    expect(readFileSync(join(vault, 'Daily/2026/2026.11.23.Mon.md'), 'utf8').split('\n')[22]).toBe('- [x] Rewrite the methods');
    expect(new TodayNote(null).load().enabled).toBe(false);
  });
});

describe('providers (local model)', async () => {
  const { ollamaEnv, OllamaLink } = await import('../src/providers.ts');
  const { nextRunnable } = await import('../src/agents/manager.ts');
  const { normalizeProviders, mergeByKey } = await import('../src/config.ts');

  it('ollamaEnv keeps the base env and points every model alias at the local model', () => {
    const env = ollamaEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', UNSET: undefined }, 11435, 'qwen3.5:9b');
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/h');
    expect('UNSET' in env).toBe(false);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11435');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'])
      expect(env[k]).toBe('qwen3.5:9b');
  });

  it('nextRunnable: provider employees bypass maxConcurrent, one slot per provider', () => {
    const w = [{}, { provider: 'desktop' }, {}];
    expect(nextRunnable(w, 3, 3, new Set())).toBe(1); // Claude slots full → the local one still starts
    expect(nextRunnable(w, 3, 3, new Set(['desktop']))).toBe(-1);
    expect(nextRunnable(w, 1, 3, new Set(['desktop']))).toBe(0); // FIFO among Claude employees
    expect(nextRunnable([{ provider: 'desktop' }, { provider: 'desktop' }], 0, 3, new Set(['desktop']))).toBe(-1);
  });

  it('providers merge by id and get defaults; invalid entries are dropped', () => {
    const merged = mergeByKey<any>([{ id: 'desktop', ssh_host: 'a', model: 'm1' }], [{ id: 'desktop', model: 'm2' }, { id: 'bad' }], 'id');
    const p = normalizeProviders(merged);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: 'desktop', name: 'desktop', kind: 'ollama', ssh_host: 'a', remotePort: 11434, localPort: 11435, model: 'm2' });
    expect(normalizeProviders([{ id: 'x', ssh_host: 'h', model: 'm', kind: 'codex' as any }])).toHaveLength(0);
  });

  it('model choice is validated against installed models and persisted', () => {
    const store = new Store(':memory:');
    const cfg = normalizeProviders([{ id: 'desktop', ssh_host: 'h', model: 'qwen3.5:9b' }])[0];
    const link = new OllamaLink(cfg, store);
    expect(link.view.model).toBe('qwen3.5:9b');
    expect(link.runtime()).toHaveProperty('error'); // not connected yet
    link.view = { ...link.view, ok: true, models: ['qwen3.5:35b-a3b', 'qwen3.5:9b'] };
    expect(() => link.setModel('llama-not-installed')).toThrow();
    link.setModel('qwen3.5:35b-a3b');
    expect(store.getProviderModel('desktop')).toBe('qwen3.5:35b-a3b');
    expect(new OllamaLink(cfg, store).view.model).toBe('qwen3.5:35b-a3b');
    const rt = link.runtime();
    expect(rt).toMatchObject({ model: 'qwen3.5:35b-a3b' });
  });
});

describe('permission mode', async () => {
  const { effectivePermission, codexAutoApproval } = await import('../src/agents/manager.ts');
  it('a 🔒 task only ever tightens', () => {
    expect(effectivePermission('auto', false)).toBe('auto');
    expect(effectivePermission('auto', true)).toBe('ask');
    expect(effectivePermission('ask', false)).toBe('ask');
    expect(effectivePermission('ask', true)).toBe('ask');
  });
  it('auto mode handles routine Codex approvals but keeps sensitive requests manual', () => {
    const command = 'item/commandExecution/requestApproval';
    const file = 'item/fileChange/requestApproval';
    expect(codexAutoApproval(command, { command: 'npm test' }, 'auto', [], [])).toBe(true);
    expect(codexAutoApproval(file, {}, 'auto', ['Edit'], [])).toBe(true);
    expect(codexAutoApproval(command, { command: 'npm test' }, 'ask', [], [])).toBe(false);
    expect(codexAutoApproval(command, { command: 'ssh desktop nvidia-smi' }, 'auto', [], [])).toBe(false);
    expect(codexAutoApproval(command, { command: 'rm -rf data' }, 'auto', [], [])).toBe(false);
    expect(codexAutoApproval(command, { command: 'npm test', additionalPermissions: { fileSystem: {} } }, 'auto', [], [])).toBe(false);
    expect(codexAutoApproval(file, { grantRoot: '/other' }, 'auto', ['Edit'], [])).toBe(false);
  });
  it('Store keeps the per-employee mode and task requireApproval', () => {
    const s = new Store(':memory:');
    expect(s.getEmployeePerm('lit')).toBeNull();
    s.setEmployeePerm('lit', 'ask');
    expect(s.getEmployeePerm('lit')).toBe('ask');
    s.setEmployeePerm('lit', 'auto');
    expect(s.getEmployeePerm('lit')).toBe('auto');
    const a = s.createTask('rm old ckpts', '', null, 'lead', true);
    const b = s.createTask('summarize', '', null);
    expect(a.requireApproval).toBe(true);
    expect(b.requireApproval).toBe(false);
    expect(s.listTasks().map((t) => t.requireApproval)).toEqual([true, false]);
    expect(s.updateTask(a.id, { state: 'doing' })!.requireApproval).toBe(true);
  });
});

describe('attachments', async () => {
  const { safeName, attachmentBlock, AttachmentLibrary, PENDING_TTL_MS } = await import('../src/attachments.ts');
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  it('safeName keeps only a harmless basename', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\me\\data.csv')).toBe('data.csv');
    expect(safeName('..hidden')).toBe('hidden');
    expect(safeName('a\u0000b:c?.png')).toBe('abc.png');
    expect(safeName('')).toBe('file');
    const long = safeName('x'.repeat(300) + '.xlsx');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.xlsx')).toBe(true);
  });

  it('saves files, links them to tasks (shared), lists them in the prompt and cleans up stale uploads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-att-'));
    const store = new Store(':memory:');
    const lib = new AttachmentLibrary(root, store);
    const a = await lib.save('../data.csv', Buffer.from('a,b\n1,2\n'));
    const b = await lib.save('fig.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(a).toMatchObject({ name: 'data.csv', size: 8, mime: 'text/csv', hasText: false });
    const [ra] = lib.rows([a.id]);
    expect(ra.path.startsWith(join(root, 'attachments'))).toBe(true);
    expect(readFileSync(ra.path, 'utf8')).toBe('a,b\n1,2\n');

    const t1 = store.createTask('t1', '', null);
    const t2 = store.createTask('t2', '', null);
    store.bindAttachments(t1.id, [a.id, b.id, 999]);
    store.bindAttachments(t2.id, [a.id]);
    expect(store.getTask(t1.id)!.attachments.map((x) => x.name)).toEqual(['data.csv', 'fig.png']);
    expect(store.listTasks().find((t) => t.id === t2.id)!.attachments.map((x) => x.id)).toEqual([a.id]);

    const block = attachmentBlock(store.attachmentsForTask(t1.id));
    expect(block).toContain(`#${a.id} data.csv (8 B, text/csv): ${ra.path}`);
    expect(attachmentBlock([])).toBe('');

    const c = await lib.save('stray.txt', Buffer.from('x'));
    const cPath = lib.rows([c.id])[0].path;
    expect(lib.cleanup(Date.now())).toBe(0); // fresh uploads stay
    expect(lib.cleanup(Date.now() + PENDING_TTL_MS + 1000)).toBe(1); // only the unlinked one goes
    expect(existsSync(cPath)).toBe(false);
    expect(lib.rows([a.id, b.id, c.id]).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it.runIf(process.platform === 'darwin')('docx gets a plain-text conversion via textutil', async () => {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'office-att-'));
    const src = join(root, 'src.txt');
    writeFileSync(src, '회의 메모');
    execFileSync('textutil', ['-convert', 'docx', '-output', join(root, 'memo.docx'), src]);
    const store = new Store(':memory:');
    const lib = new AttachmentLibrary(root, store);
    const v = await lib.save('memo.docx', readFileSync(join(root, 'memo.docx')));
    expect(v.hasText).toBe(true);
    const r = lib.rows([v.id])[0];
    expect(readFileSync(r.textPath!, 'utf8')).toContain('회의 메모');
    expect(attachmentBlock([r])).toContain('extracted text');
  });
});

describe('lab server guard', async () => {
  const { needsLabApproval } = await import('../src/agents/manager.ts');

  it('flags remote job tools and shell commands that open a remote session', () => {
    for (const t of ['mcp__lab__submit_job', 'mcp__lab__cancel_job', 'mcp__lab__fetch_results']) expect(needsLabApproval(t, {})).toBe(true);
    // a job aimed at a shared server still asks, whoever is driving
    expect(needsLabApproval('mcp__lab__submit_job', { server: 'gpu1' }, (s) => s === 'gpu1')).toBe(true);
    for (const cmd of [
      'ssh desktop hostname',
      'cd /tmp && ssh master nvidia-smi',
      '/usr/bin/ssh desktop ls',
      'scp a.txt desktop:~/',
      'rsync -a ./out desktop:~/out',
      'sftp desktop',
      'echo hi; ssh desktop rm -rf data',
      'x=$(ssh desktop hostname)',
    ])
      expect(needsLabApproval('Bash', { command: cmd }), cmd).toBe(true);
  });

  it('does not ask for a job on the backend\'s own machine', () => {
    // `ssh_host: local` means no network and no shared server — auto mode can judge it like any Bash
    const localOnly = (name: string) => name !== 'desktop';
    expect(needsLabApproval('mcp__lab__submit_job', { server: 'desktop' }, localOnly)).toBe(false);
    expect(needsLabApproval('mcp__lab__fetch_results', { server: 'desktop' }, localOnly)).toBe(false);
    expect(needsLabApproval('mcp__lab__submit_job', { server: 'elsewhere' }, localOnly)).toBe(true);
    expect(needsLabApproval('mcp__lab__submit_job', {}, localOnly)).toBe(true); // no server named → cautious
    // ssh in a shell command is remote by definition, even on a local server
    expect(needsLabApproval('Bash', { command: 'ssh desktop hostname' }, localOnly)).toBe(true);
  });

  it('leaves ordinary local work alone', () => {
    for (const t of ['mcp__lab__gpu_status', 'mcp__lab__job_status', 'mcp__lab__tail_log', 'mcp__lab__list_servers', 'Read', 'Write', 'WebFetch'])
      expect(needsLabApproval(t, { command: 'ssh desktop ls' })).toBe(false); // non-Bash: the command field is irrelevant
    for (const cmd of ['ls workspaces | wc -l', 'python3 train.py', 'git status', 'cat pushups.txt', 'grep -r sshd /etc'])
      expect(needsLabApproval('Bash', { command: cmd }), cmd).toBe(false);
    expect(needsLabApproval('Bash', {})).toBe(false);
  });
});

describe('allowedOrigin (browser-only surface)', async () => {
  const { allowedOrigin } = await import('../src/origin.ts');

  it('allows only the office itself and the vite dev server on loopback', () => {
    for (const o of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])
      expect(allowedOrigin(o, 8787), o).toBe(true);
    expect(allowedOrigin(undefined, 8787)).toBe(true); // curl / local script; the loopback bind is the guard
  });

  it('refuses other sites, other ports and odd schemes', () => {
    for (const o of [
      'https://evil.example',
      'http://evil.example:5173',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://127.0.0.1.evil.example:8787',
      'file://',
      'null',
      'not a url',
      '',
    ])
      expect(allowedOrigin(o || undefined, 8787), JSON.stringify(o)).toBe(o === '' ? true : false);
  });
});

describe('live sessions', async () => {
  const { AgentManager } = await import('../src/agents/manager.ts');
  const { PermissionBroker: Broker } = await import('../src/permissions/broker.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  /** a stand-in for one Claude Code session: records the prompts pushed in, answers each with a `result` */
  function fakeSdk() {
    const calls: { resume?: string; permissionMode?: string; model?: string }[] = [];
    const prompts: string[] = [];
    const modeChanges: string[] = [];
    let cost = 0;
    const sessions: any[] = [];
    const queryFn: any = ({ prompt, options }: any) => {
      calls.push({ resume: options.resume, permissionMode: options.permissionMode, model: options.model });
      const out: any[] = [];
      let wake: any = null; // assigned from the iterator below; `any` keeps TS from narrowing it to null here
      let closed = false;
      const emit = (m: any) => {
        out.push(m);
        wake?.();
      };
      void (async () => {
        for await (const m of prompt as AsyncIterable<any>) {
          prompts.push(String(m.message.content));
          emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: options.model ?? 'claude', permissionMode: options.permissionMode });
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: `ok:${prompts.length}` }] } });
          cost += 0.01;
          emit({ type: 'result', subtype: 'success', result: `ok:${prompts.length}`, num_turns: 1, duration_ms: 10, total_cost_usd: cost });
        }
        closed = true;
        wake?.();
      })();
      const q = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (out.length) yield out.shift();
            if (closed) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },
        setPermissionMode: async (m: string) => void modeChanges.push(m),
        setModel: async () => {},
        interrupt: async () => {},
        close: () => {
          closed = true;
          wake?.();
        },
      };
      sessions.push(q);
      return q;
    };
    return { queryFn, calls, prompts, modeChanges, sessions };
  }

  function makeManager(sdk: ReturnType<typeof fakeSdk>, over: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'office-live-'));
    const office: any = { maxConcurrent: 3, model: '', researchRepo: '', workspaceRoot: root, reportDirs: [], obsidian: null, providers: [], permissionMode: 'auto', sessionIdleMinutes: 30, port: 8787, ...over };
    const role: any = { id: 'lit', name: 'Ada', title: 'R', desk: 0, sprite: {}, useWorktree: false, autoAllow: [], systemPrompt: '' };
    const store = new Store(':memory:');
    const m = new AgentManager(office, [role], store, new Broker(), { list: () => [] } as any);
    m.queryFn = sdk.queryFn;
    return { m, store };
  }

  const settle = async (ms = 30) => await new Promise((r) => setTimeout(r, ms));

  it('reuses one session across instructions instead of starting a process each time', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk);
    m.instruct('lit', '1+1은?');
    await settle();
    m.instruct('lit', '2+2는?');
    await settle();
    expect(sdk.calls).toHaveLength(1); // one process, two turns
    expect(sdk.prompts).toEqual(['1+1은?', '2+2는?']);
    expect(m.views()[0].live).toBe(true);
    expect(m.runningCount()).toBe(0); // the idle open session holds no concurrency slot
  });

  it('bills the delta, not the cumulative session total', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk);
    m.instruct('lit', 'a');
    await settle();
    m.instruct('lit', 'b');
    await settle();
    expect(m.views()[0].costUsd).toBeCloseTo(0.02, 5); // 0.01 + 0.01, not 0.01 + 0.02
  });

  it('a 🔒 task switches the live session to ask and back', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk);
    m.instruct('lit', 'normal');
    await settle();
    m.instruct('lit', 'locked', 1, { requireApproval: true });
    await settle();
    m.instruct('lit', 'normal again');
    await settle();
    expect(sdk.calls[0].permissionMode).toBe('auto');
    expect(sdk.modeChanges).toEqual(['default', 'auto']);
  });

  it('closes an idle session and resumes the conversation on the next instruction', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk, { sessionIdleMinutes: 0.0005 }); // ~30ms
    m.instruct('lit', 'first');
    await settle(120);
    expect(m.views()[0].live).toBe(false);
    m.instruct('lit', 'later');
    await settle();
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1].resume).toBe('sess-1'); // same conversation, new process
  });

  it('busy() lists who is mid-turn, for `npm run update` to wait on', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk);
    expect(m.busy()).toEqual({ working: [], queued: 0 });
    m.instruct('lit', 'go');
    expect(m.busy().working).toEqual([{ id: 'lit', name: 'Ada' }]);
    await settle();
    expect(m.busy()).toEqual({ working: [], queued: 0 }); // the open session alone doesn't count
  });

  it('a task routed to the other engine runs there once and leaves the default untouched', async () => {
    const sdk = fakeSdk();
    const { m, store } = makeManager(sdk);
    m.instruct('lit', 'warm up');
    await settle();
    const claudeSession = m.views()[0].sessionId;
    store.setSetting('codex-thread:lit:backend:' + (await import('node:os')).hostname(), 'th-1');
    const seen: (string | null)[] = [];
    const shown: (string | null)[] = [];
    (m as any).runCodex = async (e: any) => {
      seen.push(e.view.sessionId);
      shown.push(e.view.turnEngine);
    };
    m.instruct('lit', 'review this', null, { engine: 'codex' });
    await settle();
    expect(seen).toEqual(['th-1']); // ran on Codex, resuming the Codex thread
    expect(shown).toEqual(['codex']); // the panel showed Codex while it ran…
    expect(m.views()[0].turnEngine).toBeNull(); // …and the default again afterwards
    expect(sdk.prompts).toEqual(['warm up']); // the Claude session got nothing
    expect(m.views()[0].engine).toBe('claude');
    expect(m.views()[0].sessionId).toBe(claudeSession);
    m.instruct('lit', 'back to normal');
    await settle();
    expect(sdk.prompts).toEqual(['warm up', 'back to normal']);
    expect(seen).toHaveLength(1);
  });

  it('log lines carry the engine of the conversation they belong to', async () => {
    const sdk = fakeSdk();
    const { m, store } = makeManager(sdk);
    m.instruct('lit', 'on claude');
    await settle();
    (m as any).runCodex = async (e: any) => (m as any).log(e, 'assistant', 'codex says hi');
    m.instruct('lit', 'on codex', null, { engine: 'codex' });
    await settle();
    const lines = store.recentLogs('lit');
    expect(lines.filter((l) => l.engine === 'claude').map((l) => l.text)).toContain('on claude');
    expect(lines.filter((l) => l.engine === 'codex').map((l) => l.text)).toEqual(expect.arrayContaining(['on codex', 'codex says hi']));
    expect(lines.every((l) => l.engine === 'claude' || l.engine === 'codex')).toBe(true);
  });

  it('a local-model employee ignores a Codex override', async () => {
    const sdk = fakeSdk();
    const { m, store } = makeManager(sdk);
    (m as any).emps.get('lit').role.provider = 'ollama-x';
    let codex = 0;
    (m as any).runCodex = async () => void codex++;
    m.instruct('lit', 'x', null, { engine: 'codex' });
    await settle();
    expect(codex).toBe(0);
    expect(store.logsSince(0).some((l) => /requested engine is ignored|지정된 실행기/.test(l.text))).toBe(true);
  });

  it('stop() interrupts the turn but keeps the session open', async () => {
    const sdk = fakeSdk();
    const { m } = makeManager(sdk);
    m.instruct('lit', 'go');
    await settle();
    m.stop('lit');
    await settle();
    expect(m.views()[0].live).toBe(true);
  });
});

describe('remote hosts', async () => {
  const { remoteCommand, forwardEnv, SSH_BASE } = await import('../src/hosts.ts');
  const { normalizeHosts } = await import('../src/config.ts');

  const cfg: any = { id: 'desktop', name: 'desktop', ssh: 'desktop', projectRoot: '~/project', claudePath: '/home/me/.local/bin/claude' };

  it('forwards only the session env, never the local shell env', () => {
    const env = forwardEnv({ PATH: '/opt/homebrew/bin', HOME: '/Users/me', SHELL: '/bin/zsh', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435', CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.5:9b', ANTHROPIC_API_KEY: '', NOPE: undefined });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435', CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.5:9b' });
  });

  it('cds into the session folder and execs the absolute CLI path', () => {
    const cmd = remoteCommand(cfg, { command: '/opt/homebrew/bin/claude', args: ['--output-format', 'stream-json'], cwd: '/home/me/project/beta', env: {} });
    expect(cmd).toBe("cd '/home/me/project/beta' && exec env '/home/me/.local/bin/claude' '--output-format' 'stream-json'");
    expect(cmd).not.toContain('/opt/homebrew'); // the local path would not exist there
  });

  it('quotes folders, args and env values so nothing can break out of the remote shell', async () => {
    // run the generated line through a real shell with a harmless "CLI" that just prints its argv
    const { execFileSync, } = await import('node:child_process');
    const { mkdtempSync, existsSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'host spike '));   // a space in the path, on purpose
    const fake = join(dir, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\necho "URL:$ANTHROPIC_BASE_URL"\n');
    chmodSync(fake, 0o755);
    const canary = join(dir, 'pwned');

    const cmd = remoteCommand({ ...cfg, claudePath: fake }, {
      command: 'claude',
      args: ['--append-system-prompt', `it's fine; touch ${canary}`],
      cwd: dir,
      env: { ANTHROPIC_BASE_URL: `http://x; touch ${canary}` },
    });
    const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });

    expect(out).toContain(`ARG:it's fine; touch ${canary}`); // arrived as one literal argument
    expect(out).toContain(`URL:http://x; touch ${canary}`);
    expect(existsSync(canary)).toBe(false); // nothing escaped into the shell
  });

  it('never asks ssh for a tty (a tty would corrupt stream-json)', () => {
    expect(SSH_BASE).toContain('-T');
    expect(SSH_BASE).not.toContain('-t');
    expect(SSH_BASE).toContain('BatchMode=yes');
  });

  it('remembers which machine a session id belongs to', () => {
    const store = new Store(':memory:');
    expect(store.getSession('exec')).toMatchObject({ sessionId: null, hostId: null });
    store.saveSession('exec', 'sess-remote', 0.5, '/home/me/project', 'desktop');
    expect(store.getSession('exec')).toMatchObject({ sessionId: 'sess-remote', cwd: '/home/me/project', hostId: 'desktop' });
    store.saveSession('exec', 'sess-local', 0.5, '/Users/me/x', null); // moved back to this machine
    expect(store.getSession('exec').hostId).toBeNull();
  });

  it('fills in host defaults and drops incomplete entries', () => {
    const hs = normalizeHosts([{ id: 'desktop', ssh: 'local' }, { name: 'no id' }, { id: 'master', ssh: 'master', projectRoot: '/data/proj' }]);
    expect(hs).toHaveLength(2);
    expect(hs[0]).toMatchObject({ id: 'desktop', name: 'desktop', ssh: 'local', projectRoot: '~/project' });
    expect(hs[1].projectRoot).toBe('/data/proj');
  });
});

describe('portability (moving the backend to another machine)', async () => {
  const { localExec, isLocalHost } = await import('../src/compute/adapter.ts');
  const { SshAdapter } = await import('../src/compute/ssh.ts');
  const { sessionHostId } = await import('../src/agents/manager.ts');
  const { AttachmentLibrary } = await import('../src/attachments.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  it('ssh_host "local" means this machine', () => {
    expect(isLocalHost('local')).toBe(true);
    expect(isLocalHost('desktop')).toBe(false);
  });

  it('localExec runs the script here, with the same contract as sshExec', async () => {
    const ok = await localExec('ignored', 'echo hi; echo oops >&2; exit 0');
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');
    expect(ok.stderr.trim()).toBe('oops');
    expect((await localExec('ignored', 'exit 3')).code).toBe(3);
  });

  it('a local adapter talks to the machine it runs on', async () => {
    const cfg: any = { name: 'desktop', type: 'ssh', ssh_host: 'local', workdir: '~/office-jobs' };
    const seen: string[] = [];
    const a = new SshAdapter(cfg, async (host, script) => {
      seen.push(host);
      return { code: 0, stdout: 'NVIDIA Test, 0, 10, 100\n---\nload average: 0.1', stderr: '' };
    });
    await a.gpuStats();
    expect(seen).toEqual(['local']); // the adapter still passes the configured host through
  });

  it('a session id is tied to the machine that recorded it, backend moves included', () => {
    // same role, two different backend machines → different ids, so the stale session is not resumed
    expect(sessionHostId(undefined, 'laptop.local')).not.toBe(sessionHostId(undefined, 'desktop'));
    // a role pinned to a host keeps that host's id wherever the backend runs
    expect(sessionHostId('desktop', 'mac')).toBe(sessionHostId('desktop', 'desktop'));
    expect(sessionHostId('desktop', 'mac')).toBe('desktop');
  });

  it('attachment paths survive a move: stored relative, handed out absolute', async () => {
    const oldRoot = mkdtempSync(join(tmpdir(), 'ws-old-'));
    const store = new Store(':memory:');
    const lib = new AttachmentLibrary(oldRoot, store);
    const v = await lib.save('data.csv', Buffer.from('a,b\n'));
    expect(lib.rows([v.id])[0].path.startsWith(oldRoot)).toBe(true);
    const rel = (store.db.prepare('SELECT path FROM attachments WHERE id = ?').get(v.id) as any).path;
    expect(rel.startsWith('/')).toBe(false); // relative in the DB

    // the same DB opened on another machine, under a different workspace root
    const newRoot = mkdtempSync(join(tmpdir(), 'ws-new-'));
    new AttachmentLibrary(newRoot, store);
    expect(store.getAttachments([v.id])[0].path).toBe(join(newRoot, rel));
  });
});

describe('removing a role from roles.yaml', async () => {
  it('leaves its cards on the board instead of pointing at nobody', () => {
    const s = new Store(':memory:');
    const kept = s.createTask('keep', '', 'lit');
    const gone = s.createTask('orphan', '', 'data');
    const doing = s.createTask('orphan in flight', '', 'data');
    s.updateTask(gone.id, { assignee: 'data', state: 'review' });
    s.updateTask(doing.id, { assignee: 'data', state: 'doing' });
    s.updateTask(kept.id, { assignee: 'lit', state: 'doing' });

    expect(s.reassignUnknown(['lit', 'eval', 'sec', 'exec'])).toBe(2);
    const by = Object.fromEntries(s.listTasks().map((t) => [t.id, t]));
    expect(by[kept.id]).toMatchObject({ assignee: 'lit', state: 'doing' }); // untouched
    expect(by[gone.id]).toMatchObject({ assignee: null, state: 'review' }); // kept its state
    expect(by[doing.id]).toMatchObject({ assignee: null, state: 'todo' }); // pulled back out of doing
    expect(s.reassignUnknown(['lit', 'eval', 'sec', 'exec'])).toBe(0); // idempotent
  });
});

describe('office token lock', async () => {
  const { isAuthorized, tokenMatches, parseCookies, COOKIE, cookieHeader, suggestToken } = await import('../src/auth.ts');
  const TOKEN = 's3cret-office-token';
  const req = (headers: Record<string, string>) => ({ headers });

  it('open when no token is configured (loopback-only, as before)', () => {
    expect(isAuthorized(req({}), '')).toBe(true);
  });

  it('lets in the browser cookie and the script header, nothing else', () => {
    expect(isAuthorized(req({ cookie: `${COOKIE}=${TOKEN}` }), TOKEN)).toBe(true);
    expect(isAuthorized(req({ 'x-office-token': TOKEN }), TOKEN)).toBe(true);
    expect(isAuthorized(req({}), TOKEN)).toBe(false);
    expect(isAuthorized(req({ cookie: `${COOKIE}=wrong` }), TOKEN)).toBe(false);
    expect(isAuthorized(req({ 'x-office-token': TOKEN + 'x' }), TOKEN)).toBe(false);
    expect(isAuthorized(req({ cookie: 'other=1; junk' }), TOKEN)).toBe(false);
  });

  it('compares tokens of different lengths without throwing', () => {
    expect(tokenMatches('short', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('reads cookies with spaces, encoding and junk around them', () => {
    const c = parseCookies(`a=1; ${COOKIE}=${encodeURIComponent('tok en/+=')}; b=2`);
    expect(c[COOKIE]).toBe('tok en/+=');
    expect(parseCookies(undefined)).toEqual({});
  });

  it('sets a cookie a page script cannot read or send cross-site', () => {
    const h = cookieHeader(TOKEN);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Strict');
    expect(suggestToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('project sessions', async () => {
  const { Host } = await import('../src/hosts.ts');

  it('resolves a project folder on the host, expanding ~ ourselves', () => {
    const h = new Host({ id: 'd', name: 'd', ssh: 'desktop', projectRoot: '~/project' } as any);
    // every path we send is quoted, so the remote shell never expands ~ for us
    expect(() => h.projectDir('alpha')).toThrow(); // home not known until the health check answers
    (h as any).home = '/home/me';
    expect(h.projectDir('alpha')).toBe('/home/me/project/alpha');
    expect(h.projectDir('~/elsewhere')).toBe('/home/me/elsewhere');
    expect(h.projectDir('/data/shared')).toBe('/data/shared'); // absolute stays put
  });

  it('gives each session its own id and never reuses one', () => {
    const s = new Store(':memory:');
    const p = s.createProject('desktop', 'alpha', 'alpha');
    const a = s.addProjectSession(p.id);
    const b = s.addProjectSession(p.id);
    expect([a.id, b.id]).toEqual([`p:${p.id}:1`, `p:${p.id}:2`]);
    expect(s.listProjectSessions(p.id).map((x) => x.id)).toEqual([a.id, b.id]);

    s.closeProjectSession(a.id);
    expect(s.listProjectSessions(p.id).map((x) => x.id)).toEqual([b.id]);
    // the closed number is not handed out again, so old logs can never be mistaken for a new session
    expect(s.addProjectSession(p.id).id).toBe(`p:${p.id}:3`);
  });

  it('closing a session drops its conversation, archiving a project closes them all', () => {
    const s = new Store(':memory:');
    const p = s.createProject('desktop', 'beta', 'beta');
    const one = s.addProjectSession(p.id);
    s.saveSession(one.id, 'sess-abc', 0.3, '/home/me/project/beta', 'desktop');
    expect(s.getSession(one.id).sessionId).toBe('sess-abc');
    s.closeProjectSession(one.id);
    expect(s.getSession(one.id).sessionId).toBeNull();

    s.addProjectSession(p.id);
    s.addProjectSession(p.id);
    expect(s.listProjectSessions(p.id)).toHaveLength(2);
    s.archiveProject(p.id);
    expect(s.listProjectSessions(p.id)).toHaveLength(0);
    expect(s.listProjects()).toHaveLength(0); // archived projects drop off the board
    expect(s.getProject(p.id)?.archivedAt).toBeTruthy(); // but the row is kept
  });

  it('keeps projects on different hosts apart', () => {
    const s = new Store(':memory:');
    const a = s.createProject('desktop', 'same-name', 'proj');
    const b = s.createProject('gpu1', 'same-name', 'proj');
    expect(a.id).not.toBe(b.id);
    expect(s.listProjects().map((p) => p.hostId).sort()).toEqual(['desktop', 'gpu1']);
  });
});

describe('office seating', async () => {
  const { heightFor, rowsFor } = await import('../../web/src/game/office.ts');
  const { sessionSprite, projectHue } = await import('../src/projects.ts');

  it('the room keeps its original size until the grid needs a third row', () => {
    expect(rowsFor(-1)).toBe(2); // nobody in the grid
    expect(rowsFor(5)).toBe(2); // 3 columns × 2 rows = slots 0..5
    expect(rowsFor(6)).toBe(3);
    expect(rowsFor(11)).toBe(4);
    // the bottom strip (manager, reception, lead) needs its own band below the last row,
    // or the reception desk clips the row above it
    expect(heightFor(2)).toBe(256);
    expect(heightFor(3)).toBe(328);
    expect(heightFor(3) - heightFor(2)).toBe(72); // one row taller, nothing else moves
  });

  it('a session only takes a desk once it is let into the office, and gives it back', () => {
    const s = new Store(':memory:');
    const p = s.createProject('desktop', 'beta', 'beta');
    const a = s.addProjectSession(p.id, '학습');
    const b = s.addProjectSession(p.id);
    expect([a.desk, b.desk]).toEqual([-1, -1]); // tab only
    expect(a.label).toBe('학습');
    expect(b.label).toBe('Session 2');

    const staff = [0, 1]; // lit and eval hold these grid slots
    expect(s.setSessionDesk(a.id, true, staff)).toBe(2);
    expect(s.setSessionDesk(b.id, true, staff)).toBe(3);
    expect(s.setSessionDesk(a.id, false, staff)).toBe(-1); // sent back to the tab
    // the freed desk is handed to the next session rather than drifting upward
    const c = s.addProjectSession(p.id);
    expect(s.setSessionDesk(c.id, true, staff)).toBe(2);
  });

  it('a session always looks the same, and project-mates share a shirt', () => {
    const one = sessionSprite('pr-aaa', 'p:pr-aaa:1');
    expect(sessionSprite('pr-aaa', 'p:pr-aaa:1')).toEqual(one); // deterministic
    // project-mates share the hue but not the shade, so you can still tell them apart
    expect(projectHue('pr-aaa')).toBe(projectHue('pr-aaa'));
    expect(projectHue('pr-bbb')).not.toBe(projectHue('pr-aaa'));
    expect(sessionSprite('pr-aaa', 'p:pr-aaa:2').shirt).not.toBe(one.shirt);
    for (const v of Object.values(one)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('schema migrations', () => {
  it('adds the desk column to a project_sessions table made before it existed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'office-mig-')), 'office.db');

    // an older database: project_sessions without `desk`
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE project_sessions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, label TEXT NOT NULL,
      createdAt INTEGER NOT NULL, closedAt INTEGER)`);
    old.exec(`INSERT INTO project_sessions (id, projectId, label, createdAt) VALUES ('p:old:1', 'old', '세션 1', 1)`);
    old.close();

    const s = new Store(file);
    const row = s.listProjectSessions('old')[0];
    expect(row.desk).toBe(-1); // existing sessions start outside the office, not at desk 0
    expect(s.setSessionDesk(row.id, true, [0, 1])).toBe(2);
  });
});

describe('ssh connection pressure', async () => {
  const { SSH_SHORT, SSH_BASE, sshControlOpts, Host } = await import('../src/hosts.ts');

  it('short, frequent commands share one master connection per host', () => {
    const joined = SSH_SHORT.join(' ');
    expect(joined).toContain('ControlMaster=auto');
    expect(joined).toContain('ControlPersist=5m');
    expect(sshControlOpts().join(' ')).toMatch(/ControlPath=\S+\/%C/); // %C keeps the socket path short
  });

  it('long-lived sessions keep their own connection', () => {
    // one dropped TCP connection must not take every session on a host down at once
    expect(SSH_BASE.join(' ')).not.toContain('ControlMaster');
  });

  it('a reachable host gets checked once and then left alone', async () => {
    const h = new Host({ id: 'gpu1', name: 'gpu1', ssh: 'gpu1', projectRoot: '~/project' } as any);
    let checks = 0;
    (h as any).check = async () => {
      checks++;
      h.view = { ...h.view, ok: true };
    };
    h.start();
    await new Promise((r) => setTimeout(r, 60));
    h.stop();
    expect(checks).toBe(1); // no polling at all while it is up — zero traffic when idle
  });

  it('an unreachable host is retried, backing off instead of knocking every few seconds', async () => {
    const h = new Host({ id: 'gpu1', name: 'gpu1', ssh: 'gpu1', projectRoot: '~/project' } as any);
    let checks = 0;
    (h as any).check = async () => {
      checks++;
      h.view = { ...h.view, ok: false };
    };
    (h as any).retryMs = 10; // shrink the schedule for the test
    h.start();
    await new Promise((r) => setTimeout(r, 90));
    h.stop();
    expect(checks).toBeGreaterThan(1); // it kept trying
    expect(checks).toBeLessThan(9); // but the gap grew each time rather than staying at 10ms
  });
});

describe('ssh rate limit', async () => {
  const { SshThrottle } = await import('../src/sshRate.ts');

  it('caps runs per host per minute and counts hosts separately', () => {
    const t = new SshThrottle(5);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(t.allow('gpu1', t0 + i)).toBe(true);
    expect(t.allow('gpu1', t0 + 5)).toBe(false); // over budget
    expect(t.allow('gpu2', t0 + 5)).toBe(true); // a different server has its own budget
    expect(t.used('gpu1', t0 + 5)).toBe(5);
  });

  it('frees slots as the window slides, and says how long to wait', () => {
    const t = new SshThrottle(2);
    const t0 = 1_000_000;
    t.allow('gpu1', t0);
    t.allow('gpu1', t0 + 30_000);
    expect(t.allow('gpu1', t0 + 31_000)).toBe(false);
    expect(t.waitMs('gpu1', t0 + 31_000)).toBeGreaterThan(28_000); // until the first one ages out
    expect(t.waitMs('gpu1', t0 + 61_000)).toBe(0); // the first run has left the window
    expect(t.allow('gpu1', t0 + 61_000)).toBe(true); // so the slot it freed is available
  });

  it('reserve() waits for a slot instead of failing, but gives up on a deadline', async () => {
    const t = new SshThrottle(1);
    expect(await t.reserve('gpu1', 100)).toBe(true); // free right away
    expect(await t.reserve('gpu1', 100)).toBe(false); // would need ~60s, deadline is 100ms
  });
});

describe('ssh budget for agent commands', async () => {
  const { SshThrottle } = await import('../src/sshRate.ts');
  const { sshBudgetVerdict } = await import('../src/agents/manager.ts');

  it('works out which host a shell command would connect to', () => {
    expect(SshThrottle.targetOf('ssh srv1 hostname')).toBe('srv1');
    expect(SshThrottle.targetOf('ssh -p 10300 -o BatchMode=yes desktop ls')).toBe('desktop');
    expect(SshThrottle.targetOf('cd /tmp && ssh srv1 ls')).toBe('srv1');
    expect(SshThrottle.targetOf('scp a.txt gpu1:~/out/')).toBe('gpu1');
    expect(SshThrottle.targetOf('rsync -a ./out me@gpu2:~/out')).toBe('gpu2');
    expect(SshThrottle.targetOf('ssh me@srv3 "nvidia-smi"')).toBe('srv3');
  });

  it('stays out of the way when it cannot tell', () => {
    expect(SshThrottle.targetOf('ls -al')).toBeNull();
    expect(SshThrottle.targetOf('python3 train.py')).toBeNull();
    expect(SshThrottle.targetOf('rsync -a ./a ./b')).toBeNull(); // local to local
    expect(sshBudgetVerdict('ls -al', new SshThrottle(1))).toBeNull();
  });

  it('denies once the host is over budget, and says how long to wait', () => {
    const t = new SshThrottle(2);
    const t0 = 1_000_000;
    expect(sshBudgetVerdict('ssh gpu1 ls', t, t0)).toBeNull(); // 1st
    expect(sshBudgetVerdict('ssh gpu1 ls', t, t0 + 1)).toBeNull(); // 2nd
    const over = sshBudgetVerdict('ssh gpu1 ls', t, t0 + 2);
    expect(over).toMatchObject({ host: 'gpu1' });
    expect(over!.waitSec).toBeGreaterThan(55);
    expect(sshBudgetVerdict('ssh gpu2 ls', t, t0 + 2)).toBeNull(); // another host is unaffected
  });

  it('honours a per-host limit, and 0 means no limit', () => {
    const t = new SshThrottle(5);
    t.setLimit('srv1', 2);
    t.setLimit('desktop', 0);
    expect(t.limitFor('srv1')).toBe(2);
    expect(t.limitFor('gpu9')).toBe(5); // falls back to the office default
    const t0 = 2_000_000;
    t.allow('srv1', t0);
    t.allow('srv1', t0);
    expect(t.allow('srv1', t0)).toBe(false);
    for (let i = 0; i < 50; i++) expect(t.allow('desktop', t0)).toBe(true); // opted out
  });
});

describe('ssh budget: nothing routes around it', async () => {
  const { SshThrottle } = await import('../src/sshRate.ts');
  const { spawnRemote, setSshLimit, sshThrottle } = await import('../src/hosts.ts');

  it('the spawn itself refuses when over budget, so a new caller cannot skip the check', () => {
    setSshLimit(2);
    const cfg: any = { id: 't', name: 't', ssh: 'nonexistent-test-host', projectRoot: '~/x', claudePath: '/bin/true' };
    const args: any = { command: 'claude', args: ['--version'], cwd: '/tmp', env: {} };
    // two go through (they fail to connect, which is fine — we only care that budget is spent)
    for (let i = 0; i < 2; i++) spawnRemote(cfg, args).kill('SIGKILL');
    expect(() => spawnRemote(cfg, args)).toThrow(/2 per minute/);
    setSshLimit(5);
  });

  it('waitForSlot does not consume, so the slot is counted exactly once', async () => {
    const t = new SshThrottle(1);
    expect(await t.waitForSlot('h', 50)).toBe(true);
    expect(t.used('h')).toBe(0); // waiting alone spends nothing
    expect(t.allow('h')).toBe(true);
    expect(t.used('h')).toBe(1);
    expect(await t.waitForSlot('h', 50)).toBe(false); // now it really is full
  });

  it('reports the host-specific limit, not the office default', () => {
    const t = new SshThrottle(5);
    t.setLimit('strict', 1);
    expect(t.limitFor('strict')).toBe(1);
    expect(t.limitFor('other')).toBe(5);
  });
});

describe('usage limit: park and resume', async () => {
  const { AgentManager } = await import('../src/agents/manager.ts');
  const { PermissionBroker: Broker } = await import('../src/permissions/broker.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  /** a session that fails the first turn on the usage limit, then succeeds */
  function limitedSdk() {
    const prompts: string[] = [];
    let turn = 0;
    const queryFn: any = ({ prompt }: any) => {
      const out: any[] = [];
      let wake: any = null;
      let closed = false;
      const emit = (m: any) => { out.push(m); wake?.(); };
      void (async () => {
        for await (const m of prompt as AsyncIterable<any>) {
          prompts.push(String(m.message.content));
          emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude', permissionMode: 'auto' });
          if (++turn === 1) {
            emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 1 } });
            emit({ type: 'result', subtype: 'error_during_execution', num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
          } else {
            emit({ type: 'assistant', message: { content: [{ type: 'text', text: '이어서 완료' }] } });
            emit({ type: 'result', subtype: 'success', result: '이어서 완료', num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
          }
        }
        closed = true; wake?.();
      })();
      return {
        async *[Symbol.asyncIterator]() { for (;;) { while (out.length) yield out.shift(); if (closed) return; await new Promise<void>((r) => (wake = r)); wake = null; } },
        setPermissionMode: async () => {}, setModel: async () => {}, interrupt: async () => {},
        close: () => { closed = true; wake?.(); },
      };
    };
    return { queryFn, prompts };
  }

  const make = (sdk: any) => {
    const office: any = { maxConcurrent: 3, model: '', researchRepo: '', workspaceRoot: mkdtempSync(join(tmpdir(), 'office-rl-')), reportDirs: [], obsidian: null, providers: [], hosts: [], permissionMode: 'auto', sessionIdleMinutes: 30, port: 8787, authToken: '', sshPerMinute: 5 };
    const role: any = { id: 'lit', name: 'Ada', title: 'R', desk: 0, sprite: {}, useWorktree: false, autoAllow: [], systemPrompt: '' };
    const store = new Store(':memory:');
    const m = new AgentManager(office, [role], store, new Broker(), { list: () => [], isRemote: () => true } as any);
    m.queryFn = sdk.queryFn;
    return { m, store };
  };
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('parks the work instead of leaving the employee looking busy, then resumes itself', async () => {
    const sdk = limitedSdk();
    const { m } = make(sdk);
    m.instruct('lit', '조사해줘', 1);
    await settle(60);
    const parked = m.views()[0];
    expect(parked.status).toBe('error'); // not stuck on "thinking"
    expect(parked.activity).toContain('Usage limit');
    expect(parked.parkedUntil).toBeGreaterThan(0);

    await settle(2600); // the reset time passes
    expect(sdk.prompts).toHaveLength(2);
    expect(sdk.prompts[1]).toContain('[Auto-resume]'); // told not to redo what it already did
    expect(m.views()[0].parkedUntil).toBeUndefined();
  });

  it('a task that failed stays on the board as doing, not moved to review', async () => {
    const sdk = limitedSdk();
    const { m, store } = make(sdk);
    const t = store.createTask('조사', '', 'lit');
    store.updateTask(t.id, { assignee: 'lit', state: 'doing' });
    m.instruct('lit', '조사해줘', t.id);
    await settle(60);
    expect(store.getTask(t.id)!.state).toBe('doing'); // still claimed, so it can be picked up again
    m.stop('lit'); // don't leave the parked timer running past the test
  });

  it('resumeNow() restarts parked work without waiting for the reset', async () => {
    const sdk = limitedSdk();
    const { m } = make(sdk);
    m.instruct('lit', '조사해줘');
    await settle(60);
    expect(m.resumeNow('lit')).toBe(true);
    await settle(60);
    expect(sdk.prompts[1]).toContain('[Resumed]');
    expect(m.resumeNow('lit')).toBe(false); // nothing left parked
  });
});

describe('team prompt', async () => {
  const { teamPrompt } = await import('../src/config.ts');
  it('starts with the field when one is set, and adds server etiquette only with servers', () => {
    const plain = teamPrompt('', false);
    expect(plain).not.toContain('About this team');
    expect(plain).not.toContain('Remote server etiquette');
    const full = teamPrompt('a robotics lab', true);
    expect(full.startsWith('About this team: a robotics lab\n\n')).toBe(true);
    expect(full).toContain('Remote server etiquette');
  });
});

describe('language', async () => {
  const { AgentManager, reportLanguageLine } = await import('../src/agents/manager.ts');
  const { getLang, setLang, tr } = await import('../../shared/i18n.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  it('people-facing text follows the office language', () => {
    const before = getLang();
    try {
      setLang('ko');
      expect(tr({ ko: '가', en: 'a' })).toBe('가');
      expect(statusForTool('mcp__lab__submit_job', { server: 'gpu-a', name: 'train' }).activity).toContain('gpu-a에');
      setLang('en');
      expect(statusForTool('mcp__lab__submit_job', { server: 'gpu-a', name: 'train' }).activity).toContain('to gpu-a');
    } finally {
      setLang(before);
    }
  });

  it('the settings table round-trips', () => {
    const store = new Store(':memory:');
    expect(store.getSetting('language')).toBeNull();
    store.setSetting('language', 'ko');
    store.setSetting('language', 'en');
    expect(store.getSetting('language')).toBe('en');
  });

  it('prompts tell the agent which language to report in, and a switch reopens the session', async () => {
    const before = getLang();
    const appends: string[] = [];
    const mcpNames: string[][] = [];
    const queryFn: any = ({ prompt, options }: any) => {
      appends.push(options.systemPrompt.append);
      mcpNames.push(Object.keys(options.mcpServers ?? {}));
      const out: any[] = [];
      let wake: any = null;
      let closed = false;
      const emit = (m: any) => { out.push(m); wake?.(); };
      void (async () => {
        for await (const _ of prompt as AsyncIterable<any>) {
          emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude', permissionMode: 'auto' });
          emit({ type: 'result', subtype: 'success', result: 'ok', num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
        }
        closed = true; wake?.();
      })();
      return {
        async *[Symbol.asyncIterator]() { for (;;) { while (out.length) yield out.shift(); if (closed) return; await new Promise<void>((r) => (wake = r)); wake = null; } },
        setPermissionMode: async () => {}, setModel: async () => {}, interrupt: async () => {},
        close: () => { closed = true; wake?.(); },
      };
    };
    const office: any = { maxConcurrent: 3, model: '', researchRepo: '', workspaceRoot: mkdtempSync(join(tmpdir(), 'office-lang-')), reportDirs: [], obsidian: null, providers: [], hosts: [], permissionMode: 'auto', sessionIdleMinutes: 30, port: 8787, authToken: '', sshPerMinute: 5, language: 'en' };
    const role: any = { id: 'lit', name: 'Ada', title: 'R', desk: 0, sprite: {}, useWorktree: false, autoAllow: [], systemPrompt: 'You are Ada.' };
    const m = new AgentManager(office, [role], new Store(':memory:'), new PermissionBroker(), { list: () => [], isRemote: () => true } as any);
    m.queryFn = queryFn;
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      setLang('ko');
      m.instruct('lit', 'a');
      await settle(60);
      m.instruct('lit', 'b'); // same language: the open session is reused
      await settle(60);
      expect(appends).toEqual([`You are Ada.\n\n${reportLanguageLine('ko')}`]);
      setLang('en');
      m.instruct('lit', 'c');
      await settle(60);
      expect(appends).toHaveLength(2);
      expect(appends[1]).toContain('in English');
      expect(mcpNames[0]).not.toContain('lab'); // no GPU servers configured → no lab tools
    } finally {
      setLang(before);
      m.stop('lit');
    }
  });
});

describe('phone notifications', async () => {
  const { Notifier, normalizeNotify, encodeHeader } = await import('../src/notify.ts');

  function make(over: Record<string, unknown> = {}, ok = true) {
    const calls: { url: string; init: any }[] = [];
    const n = new Notifier(normalizeNotify({ ntfy: 'https://ntfy.example/topic', ...over } as any));
    n.fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (!ok) throw new Error('offline');
      return new Response('', { status: 200 });
    }) as any;
    return { n, calls };
  }

  it('is off without a channel, and defaults to every event, no preview, whenAway', () => {
    expect(normalizeNotify(undefined)).toBeNull();
    expect(normalizeNotify({ ntfy: '  ' } as any)).toBeNull();
    const c = normalizeNotify({ ntfy: 'https://x/y' } as any)!;
    expect(c.events).toEqual(['approval', 'result', 'error', 'job', 'scheduled']);
    expect(c.preview).toBe(false);
    expect(c.whenAway).toBe(true);
    expect(normalizeNotify({ ntfy: 'https://x/y', events: ['approval', 'bogus'] } as any)!.events).toEqual(['approval']);
  });

  it('sends to ntfy with a title that survives Korean and emoji', async () => {
    const { n, calls } = make();
    expect(await n.send('approval', '🔐 승인 요청', 'body', 'high')).toBe(true);
    expect(calls).toHaveLength(1);
    const h = calls[0].init.headers;
    expect(h.Priority).toBe('4');
    expect(h.Tags).toBe('approval');
    expect(h.Title).toBe(encodeHeader('🔐 승인 요청'));
    expect(Buffer.from(h.Title.slice(10, -2), 'base64').toString()).toBe('🔐 승인 요청');
    expect(encodeHeader('plain')).toBe('plain');
  });

  it('skips unchosen events and holds back while someone is watching', async () => {
    const { n, calls } = make({ events: ['approval'] });
    expect(await n.send('result', 'x')).toBe(false);
    n.isWatched = () => true;
    expect(await n.send('approval', 'x')).toBe(false);
    expect(calls).toHaveLength(0);
    const { n: n2, calls: c2 } = make({ whenAway: false });
    n2.isWatched = () => true;
    expect(await n2.send('approval', 'x')).toBe(true);
    expect(c2).toHaveLength(1);
  });

  it('caps the rate and never throws on a dead channel', async () => {
    const { n, calls } = make();
    for (let i = 0; i < 25; i++) await n.send('result', `r${i}`);
    expect(calls).toHaveLength(20);
    const { n: dead } = make({}, false);
    await expect(dead.send('result', 'x')).resolves.toBe(false);
  });

  it('keeps reply text out unless preview is on', () => {
    expect(make().n.preview('secret result')).toBe('');
    const long = 'a'.repeat(500);
    expect(make({ preview: true }).n.preview(long)).toHaveLength(201);
  });

  it('posts Slack/Discord-shaped JSON to a webhook', async () => {
    const { n, calls } = make({ ntfy: '', webhook: 'https://hooks.example/abc' });
    await n.send('job', 'Job #1 done', 'ok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: '*Job #1 done*\nok', content: '*Job #1 done*\nok' });
  });
});

describe('scheduled tasks', async () => {
  const { dueTasks, parseStartAt } = await import('../src/schedule.ts');

  it('stores startAt and clears it on update', () => {
    const s = new Store(':memory:');
    const t = s.createTask('later', '', 'lit', null, false, 1_000);
    expect(t.startAt).toBe(1_000);
    expect(t.assignee).toBe('lit');
    expect(t.state).toBe('todo');
    expect(s.updateTask(t.id, { state: 'doing', startAt: null })!.startAt).toBeNull();
    expect(s.getTask(t.id)!.startAt).toBeNull();
    expect(s.createTask('plain', '', null).startAt).toBeNull();
  });

  it('starts only todo cards whose time has come, with an existing assignee', () => {
    const s = new Store(':memory:');
    const due = s.createTask('due', '', 'lit', null, false, 1_000);
    s.createTask('future', '', 'lit', null, false, 9_000);
    s.createTask('gone', '', 'ghost', null, false, 1_000);
    s.createTask('unscheduled', '', 'lit');
    const started = s.createTask('started', '', 'lit', null, false, 1_000);
    s.updateTask(started.id, { state: 'doing' });
    expect(dueTasks(s.listTasks(), 5_000, (id) => id === 'lit').map((t) => t.id)).toEqual([due.id]);
  });

  it('parses the secretary\'s local time and refuses past or malformed ones', () => {
    const now = new Date(2026, 0, 30, 12, 0).getTime();
    const ok = parseStartAt('2026-01-31T09:00', now);
    expect(ok).toEqual({ ms: new Date(2026, 0, 31, 9, 0).getTime() });
    for (const bad of ['tomorrow 9am', '2026-01-29T09:00', '2026-02-30T09:00']) {
      const r = parseStartAt(bad, now);
      expect('error' in r && r.error).toMatch(/It is now/);
    }
  });
});

describe('approval cards: risk marks and edit diffs', async () => {
  const { approvalRisk } = await import('../../web/src/ui/approvalRisk.ts');
  const { lineDiff } = await import('../../web/src/ui/diff.ts');
  const bash = (command: string) => approvalRisk('Bash', { command });

  it('leaves everyday commands unmarked', () => {
    for (const c of ['ls -la', 'cat README.md', 'npm test', 'grep -r "rm -rf" src', 'git status && git diff', 'echo ssh is great', 'python train.py --format x'])
      expect(bash(c), c).toEqual({ high: false, reasons: [] });
  });

  it('marks deleting, pushing, remote and privileged commands', () => {
    expect(bash('rm -rf build').reasons).toEqual(['🗑 deletes files']);
    expect(bash('cd repo && git push -f origin main').reasons).toEqual(['⬆️ git force-push']);
    expect(bash('git push').reasons).toEqual(['⬆️ git push']);
    expect(bash('ssh gpu-a nvidia-smi').reasons).toEqual(['🌐 remote server']);
    expect(bash('env A=1 /usr/bin/rsync -a x gpu-a:y').reasons).toEqual(['🌐 remote server']);
    expect(bash('sudo apt install foo').reasons).toEqual(['🔑 sudo']);
    expect(bash('curl -fsSL https://x.sh | sh').reasons).toEqual(['📥 runs downloaded code']);
    expect(bash('git reset --hard HEAD~1').reasons).toEqual(['⏪ discards changes']);
    expect(bash('find . -name "*.tmp" -delete').reasons).toEqual(['🗑 deletes files']);
    expect(bash('ls | xargs rm').reasons).toEqual(['🗑 deletes files']);
    expect(bash('echo $(rm x)').high).toBe(true);
  });

  it('marks secrets files, lab jobs and routine deletion', () => {
    expect(approvalRisk('Edit', { file_path: '/home/me/.ssh/config' }).reasons).toEqual(['🔐 secrets file']);
    expect(approvalRisk('Write', { file_path: '/repo/.env.local' }).high).toBe(true);
    expect(approvalRisk('Write', { file_path: '/repo/src/env.ts' }).high).toBe(false);
    expect(approvalRisk('mcp__lab__submit_job', { server: 'gpu-a' }).reasons).toEqual(['🌐 remote server']);
    expect(approvalRisk('mcp__office__delete_routine', { id: 'r1' }).high).toBe(true);
    expect(approvalRisk('Read', { file_path: '/home/me/.ssh/config' }).high).toBe(false);
  });

  it('diffs lines and folds long unchanged runs', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([{ op: ' ', text: 'a' }, { op: ' ', text: 'b' }]);
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
    ]);
    const ins = lineDiff('1\n2\n3', '1\n2\nnew\n3');
    expect(ins.filter((l) => l.op !== ' ')).toEqual([{ op: '+', text: 'new' }]);
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const changed = [...long];
    changed[10] = 'X';
    const d = lineDiff(long.join('\n'), changed.join('\n'));
    expect(d[0]).toEqual({ op: '…', text: '' });
    expect(d.filter((l) => l.op === ' ')).toHaveLength(6);
    expect(d[d.length - 1].op).toBe('…');
    const big = Array.from({ length: 500 }, (_, i) => String(i)).join('\n');
    const fb = lineDiff(big, big + '\nz');
    expect(fb.filter((l) => l.op === '-')).toHaveLength(500); // too big for LCS: old then new
  });
});

describe('lead picks the engine per task', async () => {
  const { planTaskEngine } = await import('../src/mcp/officeTools.ts');
  const s = new Store(':memory:');
  const done = s.createTask('Add parser', 'parse the log', 'aide1');
  s.updateTask(done.id, { state: 'review', result: 'Added parse() in src/log.ts' });
  const viaCodex = s.createTask('Port script', '', 'aide1', null, false, null, 'codex');
  const emps = [
    { id: 'aide1', engine: 'claude' as const },
    { id: 'aide2', engine: 'codex' as const },
  ];

  it('stores the engine on the task', () => {
    expect(s.getTask(viaCodex.id)!.engine).toBe('codex');
    expect(s.getTask(done.id)!.engine).toBeNull();
  });

  it('an explicit engine wins, and none means the default', () => {
    expect(planTaskEngine({ engine: 'claude', detail: 'd' }, s.listTasks(), emps)).toEqual({ engine: 'claude', detail: 'd' });
    expect(planTaskEngine({ detail: 'd' }, s.listTasks(), emps)).toEqual({ engine: null, detail: 'd' });
  });

  it('a review goes to the engine that did not do the work, with the work attached', () => {
    const r = planTaskEngine({ reviewOf: done.id }, s.listTasks(), emps);
    expect('engine' in r && r.engine).toBe('codex'); // aide1 runs on Claude by default
    expect('detail' in r && r.detail).toMatch(/Review the work of task #\d+ "Add parser".*on claude/);
    expect('detail' in r && r.detail).toContain('Added parse() in src/log.ts');
    const r2 = planTaskEngine({ reviewOf: viaCodex.id }, s.listTasks(), emps);
    expect('engine' in r2 && r2.engine).toBe('claude'); // that one was routed to Codex
    expect(planTaskEngine({ reviewOf: done.id, engine: 'claude' }, s.listTasks(), emps)).toMatchObject({ engine: 'claude' });
    expect(planTaskEngine({ reviewOf: 999 }, s.listTasks(), emps)).toEqual({ error: 'reviewOf: there is no task #999.' });
  });
});

describe('log history per engine', async () => {
  const { inferLogEngines } = await import('../src/db.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const L = (kind: string, text: string) => ({ kind, text });

  it('tags old turns by the shapes only the Codex runner writes', () => {
    const lines = [
      L('system', 'boot'), // before any instruction → claude
      L('user', 'a'), L('system', '🧠 모델: claude'), L('result', '완료 (2 turns, 3s)'),
      L('user', 'b'), L('tool', '/bin/bash -lc "ls"'), L('result', 'Codex 작업 완료'),
      L('user', 'c'), L('tool', 'Bash(ls)'),
      L('user', 'd'), L('error', 'failed to load configuration: /home/x/.codex/config.toml'),
      L('user', 'e'), L('tool', 'File change'),
      L('user', 'f'), L('error', 'Codex: failed'),
    ];
    expect(inferLogEngines(lines)).toEqual([
      'claude',
      'claude', 'claude', 'claude',
      'codex', 'codex', 'codex',
      'claude', 'claude',
      'codex', 'codex',
      'codex', 'codex',
      'codex', 'codex',
    ]);
  });

  it('round-trips the engine and backfills a database from before the column', () => {
    const s = new Store(':memory:');
    s.addLog({ employeeId: 'x', ts: 1, kind: 'user', text: 'hi', engine: 'codex' });
    expect(s.recentLogs('x')[0].engine).toBe('codex');

    const path = join(mkdtempSync(join(tmpdir(), 'office-logs-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, employeeId TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)');
    const ins = old.prepare('INSERT INTO logs (employeeId, ts, kind, text) VALUES (?, ?, ?, ?)');
    ins.run('lit', 1, 'user', 'old claude turn');
    ins.run('lit', 2, 'result', '완료 (1 turns, 1s)');
    ins.run('lit', 3, 'user', 'old codex turn');
    ins.run('lit', 4, 'result', 'Codex 작업 완료');
    old.close();
    const migrated = new Store(path);
    expect(migrated.recentLogs('lit').map((l) => l.engine)).toEqual(['claude', 'claude', 'codex', 'codex']);
  });
});

describe('search', async () => {
  const { searchTokens, likePattern, matchesAll, snippet, searchAll, PER_KIND } = await import('../src/search.ts');

  it('splits a query into words that must all match: lower-cased, no repeats, six at most, no single ASCII characters', () => {
    expect(searchTokens('  RMSD   Baseline rmsd ')).toEqual(['rmsd', 'baseline']);
    expect(searchTokens('a 실험 b 결과')).toEqual(['실험', '결과']);
    expect(searchTokens('designability 표')).toEqual(['designability', '표']); // one Hangul syllable is a word
    expect(searchTokens('값 1 x')).toEqual(['값']);
    expect(searchTokens('x')).toEqual([]);
    expect(searchTokens('aa bb cc dd ee ff gg hh')).toHaveLength(6);
    expect(matchesAll('The RMSD beat the baseline', ['rmsd', 'baseline'])).toBe(true);
    expect(matchesAll('The RMSD only', ['rmsd', 'baseline'])).toBe(false);
  });

  it('cuts a snippet around the first match, on one line, marking where it was cut', () => {
    const long = `${'가'.repeat(200)} 찾는말 ${'나'.repeat(200)}`;
    const s = snippet(long, ['찾는말'], 20);
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
    expect(s).toContain('찾는말');
    expect(s.length).toBeLessThan(50);
    expect(snippet('앞\n\n찾는말   뒤', ['찾는말'])).toBe('앞 찾는말 뒤'); // short text: whole, whitespace collapsed
    expect(snippet('찾는말 is at the very start of this text', ['찾는말'], 10)).toBe('찾는말 is at …'); // ten characters from the match, cut after them
    expect(snippet('nothing here', ['zzz'], 3)).toBe('nothin…'); // no match (matched on a title only): the beginning
  });

  it('finds logs, tasks and feed items, newest first, treating % and _ as plain characters', () => {
    const s = new Store(':memory:');
    s.addLog({ employeeId: 'lit', ts: 1000, kind: 'assistant', text: 'Baseline RMSD는 2.31 Å입니다' });
    s.addLog({ employeeId: 'eval', ts: 2000, kind: 'user', text: 'rmsd 표를 다시 만들어 줘' });
    s.addLog({ employeeId: 'eval', ts: 3000, kind: 'assistant', text: '정확도 100% 달성' });
    s.addLog({ employeeId: 'eval', ts: 4000, kind: 'tool', text: 'Read(run_10/config.yaml)' });
    s.addLog({ employeeId: 'eval', ts: 5000, kind: 'tool', text: 'Read(run510/config.yaml)' });
    expect(s.searchLogs(['rmsd'], 10).map((l) => l.ts)).toEqual([2000, 1000]); // case-insensitive, newest first
    expect(s.searchLogs(['rmsd', 'baseline'], 10).map((l) => l.ts)).toEqual([1000]); // AND
    expect(s.searchLogs(['rmsd'], 1)).toHaveLength(1);
    expect(s.searchLogs(['100%'], 10).map((l) => l.ts)).toEqual([3000]);
    expect(s.searchLogs(['0%'], 10).map((l) => l.ts)).toEqual([3000]); // "%" is not "anything"
    expect(s.searchLogs(['run_10'], 10).map((l) => l.ts)).toEqual([4000]); // "_" is not "any one character"
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
    expect(s.searchLogs([], 10)).toEqual([]);

    const t1 = s.createTask('논문 요약', '최신 diffusion 논문 3편', null);
    const t2 = s.createTask('지표 계산', '', null);
    s.updateTask(t2.id, { result: 'TM-score 평균 0.71 (diffusion 모델)' });
    expect(s.searchTasks(['diffusion'], 10).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort()); // title, detail and result
    expect(s.searchTasks(['tm-score'], 10).map((t) => t.id)).toEqual([t2.id]);

    s.addFeed({ ts: 10, kind: 'result', employeeId: 'sec', title: '⏰ 아침 브리핑', body: '오늘 GPU 3대 비어 있음', path: null, ok: true });
    s.addFeed({ ts: 20, kind: 'report', employeeId: 'lit', title: '논문 정리', body: '# GPU 메모리 최적화', path: 'lit/reports/a.md', ok: true });
    expect(s.searchFeed(['gpu'], 10).map((f) => f.ts)).toEqual([20, 10]);
    expect(s.searchFeed(['브리핑'], 10).map((f) => f.ts)).toEqual([10]); // the title too
  });

  it('reads report files for their text, but only files from the last scan', () => {
    const ws = mkdtempSync(join(tmpdir(), 'office-search-'));
    const w = (rel: string, text: string) => {
      mkdirSync(join(ws, rel, '..'), { recursive: true });
      writeFileSync(join(ws, rel), text);
    };
    w('lit/reports/a.md', '# 구조 예측 정리\n\nAlphaFold3의 리간드 결합 정확도');
    w('lit/reports/b.md', '# 생성 모델\n\nRFdiffusion 설계 성공률');
    const lib = new ReportLibrary(() => reportRoots(ws, [], () => 'lit'));
    expect(lib.search(['alphafold3'], 10)).toEqual([]); // nothing scanned yet
    lib.scan();
    expect(lib.search(['alphafold3'], 10).map((r) => r.path)).toEqual(['lit/reports/a.md']);
    expect(lib.search(['구조', '리간드'], 10).map((r) => r.path)).toEqual(['lit/reports/a.md']); // title + body, AND
    expect(lib.search(['구조', 'rfdiffusion'], 10)).toEqual([]);
    w('lit/reports/c.md', '# 새 파일\n\nAlphaFold3 후속');
    expect(lib.search(['alphafold3'], 10).map((r) => r.path)).toEqual(['lit/reports/a.md']); // c.md not scanned yet
    lib.scan();
    expect(lib.search(['alphafold3'], 10)).toHaveLength(2);
    // an edited file is read again
    const past = new Date(Date.now() - 60_000);
    w('lit/reports/a.md', '# 구조 예측 정리\n\n내용을 바꿈');
    utimesSync(join(ws, 'lit/reports/a.md'), past, past);
    lib.scan();
    expect(lib.search(['alphafold3'], 10).map((r) => r.path)).toEqual(['lit/reports/c.md']);
  });

  it('puts the four kinds together, with a title, a snippet and something to open', () => {
    const s = new Store(':memory:');
    const ws = mkdtempSync(join(tmpdir(), 'office-search-'));
    mkdirSync(join(ws, 'lit/reports'), { recursive: true });
    writeFileSync(join(ws, 'lit/reports/r.md'), '# 주간 정리\n\n이번 주 designability 실험 결과');
    const lib = new ReportLibrary(() => reportRoots(ws, [], () => 'lit'));
    lib.scan();
    s.addLog({ employeeId: 'lit', ts: 1, kind: 'assistant', text: 'designability는 0.62로 나왔습니다' });
    const t = s.createTask('designability 재계산', '', 'eval');
    s.addFeed({ ts: 2, kind: 'result', employeeId: 'lit', title: '결과', body: 'designability 표 첨부', path: null, ok: true });
    const hits = searchAll('Designability', s, lib, (id) => (id === 'lit' ? 'Alan' : id));
    expect(hits.map((h) => h.kind).sort()).toEqual(['feed', 'log', 'report', 'task']);
    const by = Object.fromEntries(hits.map((h) => [h.kind, h]));
    expect(by.report).toMatchObject({ path: 'lit/reports/r.md', title: '주간 정리', employeeId: 'lit' });
    expect(by.report.text).toBeUndefined(); // reports are opened by path, not sent along
    expect(by.log).toMatchObject({ title: 'Alan', employeeId: 'lit', logKind: 'assistant' });
    expect(by.log.snippet).toContain('designability');
    expect(by.task).toMatchObject({ taskId: t.id, title: `#${t.id} designability 재계산`, employeeId: 'eval' });
    expect(by.feed).toMatchObject({ title: '결과', text: 'designability 표 첨부' });
    expect(searchAll('x', s, lib, (id) => id)).toEqual([]); // too short to search
    expect(searchAll('   ', s, lib, (id) => id)).toEqual([]);
    for (let i = 0; i < PER_KIND + 5; i++) s.addLog({ employeeId: 'lit', ts: 10 + i, kind: 'tool', text: `designability run ${i}` });
    expect(searchAll('designability', s, lib, (id) => id).filter((h) => h.kind === 'log')).toHaveLength(PER_KIND);
  });
});

describe('task chains', async () => {
  type Task = import('../../shared/protocol.ts').Task;
  const { isFinished, waitsOn, readyFollowers, orphanedFollowers, followBlock } = await import('../src/schedule.ts');
  const task = (id: number, state: Task['state'], afterTask: number | null = null, assignee: string | null = 'eval'): Task =>
    ({ id, title: `t${id}`, detail: '', assignee, state, result: null, createdBy: null, requireApproval: false, startAt: null, engine: null, afterTask, attachments: [], createdAt: 0, updatedAt: 0 }) as Task;
  const known = (id: string) => id === 'eval' || id === 'lit';

  it('a task counts as finished once it reaches review or done', () => {
    expect((['todo', 'doing', 'review', 'done'] as const).map((s) => isFinished({ state: s }))).toEqual([false, false, true, true]);
  });

  it('a follow-up waits while the task before it is unfinished, and is ready once that one is in review or done', () => {
    for (const [prevState, ready] of [['todo', false], ['doing', false], ['review', true], ['done', true]] as const) {
      const tasks = [task(1, prevState, null, 'lit'), task(2, 'todo', 1)];
      expect(readyFollowers(tasks, known).map((t) => t.id), prevState).toEqual(ready ? [2] : []);
      expect(waitsOn(tasks[1], tasks)?.id ?? null, prevState).toBe(ready ? null : 1);
    }
  });

  it('only a waiting card is started: not one already going, not one without a known assignee', () => {
    const done = task(1, 'review', null, 'lit');
    expect(readyFollowers([done, task(2, 'doing', 1)], known)).toEqual([]); // started by hand meanwhile
    expect(readyFollowers([done, task(2, 'review', 1)], known)).toEqual([]);
    expect(readyFollowers([done, task(2, 'todo', 1, null)], known)).toEqual([]);
    expect(readyFollowers([done, task(2, 'todo', 1, 'gone')], known)).toEqual([]); // role removed
    expect(readyFollowers([done, task(2, 'todo', null)], known)).toEqual([]); // follows nothing
    expect(waitsOn(task(2, 'doing', 1), [task(1, 'doing'), task(2, 'doing', 1)])).toBeNull(); // not waiting any more
  });

  it('a chain releases one link at a time', () => {
    const chain = (a: Task['state'], b: Task['state']) => [task(1, a, null, 'lit'), task(2, b, 1), task(3, 'todo', 2, 'lit')];
    expect(readyFollowers(chain('doing', 'todo'), known)).toEqual([]);
    expect(readyFollowers(chain('review', 'todo'), known).map((t) => t.id)).toEqual([2]);
    expect(readyFollowers(chain('done', 'doing'), known)).toEqual([]);
    expect(readyFollowers(chain('done', 'review'), known).map((t) => t.id)).toEqual([3]);
  });

  it('a card whose predecessor was deleted is orphaned, not started', () => {
    const tasks = [task(2, 'todo', 1), task(3, 'doing', 1), task(4, 'todo', null)];
    expect(orphanedFollowers(tasks).map((t) => t.id)).toEqual([2]); // #3 is already running, #4 follows nothing
    expect(readyFollowers(tasks, known)).toEqual([]);
    expect(waitsOn(tasks[0], tasks)).toBeNull();
  });

  it('tells the follow-up what the task before it produced', () => {
    const prev = { ...task(7, 'review', null, 'lit'), title: 'Survey diffusion papers', result: 'Three papers: A, B, C. Notes in notes/lit/diffusion.md' };
    const b = followBlock(prev, 'Alan');
    expect(b).toContain('follows task #7 "Survey diffusion papers", done by Alan');
    expect(b).toContain('Three papers: A, B, C. Notes in notes/lit/diffusion.md');
    expect(followBlock({ ...prev, result: null }, 'Alan')).toContain('left no written result');
    const long = followBlock({ ...prev, result: 'x'.repeat(20_000) }, 'Alan');
    expect(long.length).toBeLessThan(7000);
    expect(long).toContain('truncated; the full text is in task #7');
  });

  it('stores what a task follows, and opens a database from before the column existed', () => {
    const s = new Store(':memory:');
    const a = s.createTask('조사', '', 'lit');
    const b = s.createTask('비교표', '', 'eval', null, false, null, null, a.id);
    expect(s.getTask(a.id)!.afterTask).toBeNull();
    expect(s.getTask(b.id)!.afterTask).toBe(a.id);
    expect(s.listTasks().find((t) => t.id === b.id)!.afterTask).toBe(a.id);
    expect(s.updateTask(b.id, { state: 'doing' })!.afterTask).toBe(a.id); // other updates leave it alone
    expect(s.updateTask(b.id, { afterTask: null })!.afterTask).toBeNull();
    expect(s.getTask(b.id)!.afterTask).toBeNull();

    const f = join(mkdtempSync(join(tmpdir(), 'office-db-')), 'office.db');
    const old = new DatabaseSync(f);
    old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', assignee TEXT, state TEXT NOT NULL DEFAULT 'todo', result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      INSERT INTO tasks (title, createdAt, updatedAt) VALUES ('예전 작업', 1, 1);`);
    old.close();
    const migrated = new Store(f);
    expect(migrated.listTasks()[0]).toMatchObject({ title: '예전 작업', afterTask: null });
    expect(migrated.createTask('새 작업', '', 'eval', null, false, null, null, 1).afterTask).toBe(1);
  });
});

describe('the office title', async () => {
  const { DEFAULT_TITLE, FIGURE_KEYS, FIGURE_MAX_LEN, figureDefaultName } = await import('../../shared/protocol.ts');
  const { loginPage } = await import('../src/auth.ts');

  it('is one of the labels the manager can change, "8-bit Lab" until they do, 30 characters at most', () => {
    expect(FIGURE_KEYS).toContain('title');
    expect(figureDefaultName('title')).toBe('8-bit Lab');
    expect(DEFAULT_TITLE).toBe('8-bit Lab');
    expect(FIGURE_MAX_LEN.title).toBe(30);
  });

  it('is stored like the other labels, and an empty one falls back to the default', () => {
    // the same reserved-key scheme index.ts uses for the manager tag and the whiteboard
    const s = new Store(':memory:');
    const name = () => s.getEmployeeName('__title') ?? figureDefaultName('title');
    expect(name()).toBe('8-bit Lab');
    s.setEmployeeName('__title', '유빈 연구실');
    expect(name()).toBe('유빈 연구실');
    s.setEmployeeName('__title', null); // what renameFigure does with an empty name
    expect(name()).toBe('8-bit Lab');
  });

  it('shows on the login page, escaped', () => {
    expect(loginPage(false)).toContain('<h1>👾 8-bit Lab</h1>');
    const page = loginPage(false, 'Lab <b>&"x"');
    expect(page).toContain('<h1>👾 Lab &lt;b&gt;&amp;&quot;x&quot;</h1>');
    expect(page).toContain('<title>Lab &lt;b&gt;&amp;&quot;x&quot; · ');
    expect(page).not.toContain('<b>&"x"');
  });
});
