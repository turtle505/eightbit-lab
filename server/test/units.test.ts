import { describe, expect, it } from 'vitest';
import { statusForTool } from '../src/agents/status.ts';
import { parseNvidiaSmi } from '../src/compute/adapter.ts';
import { SshAdapter, parseSshStatus } from '../src/compute/ssh.ts';
import { SlurmAdapter, parseSlurmState } from '../src/compute/slurm.ts';
import { PermissionBroker } from '../src/permissions/broker.ts';
import { Store } from '../src/db.ts';

describe('statusForTool', () => {
  it('maps tools to character states', () => {
    expect(statusForTool('Bash', { command: 'ls' }).status).toBe('running');
    expect(statusForTool('WebSearch', { query: 'FrameFlow' }).status).toBe('researching');
    expect(statusForTool('Edit', { file_path: '/a/b/model.py' }).activity).toContain('model.py');
    const r = statusForTool('mcp__lab__submit_job', { server: 'gpu-a', name: 'train' });
    expect(r.status).toBe('remote');
    expect(r.activity).toContain('gpu-a에');
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
    const r = ['Read', 'mcp__plugin_bio-research_biorxiv'];
    expect(isAutoAllowed(r, 'Read')).toBe(true);
    expect(isAutoAllowed(r, 'mcp__plugin_bio-research_biorxiv__search_preprints')).toBe(true);
    expect(isAutoAllowed(r, 'mcp__plugin_bio-research_biorxiv_evil__x')).toBe(false);
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
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'ghost', prompt: 'p' })).toThrow(/직원/);
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
      ['session', '세션 (5시간)', 5, 'normal'],
      ['weekly_all', '주간 (전체)', 42, 'warning'],
      ['weekly_scoped', '주간 · Fable', 1, 'normal'],
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
    expect(() => lib.save('../evil', 'd', 'b', [])).toThrow(/이름/);
    expect(() => lib.save('Bad Name', 'd', 'b', [])).toThrow(/이름/);
    expect(() => lib.save('ok-name', ' ', 'b', [])).toThrow(/설명/);
    expect(lib.allowFor('missing')).toBeNull();
  });
});

describe('RoutineScheduler with skills', () => {
  const isEmp = () => true;
  it('requires an existing skill or a prompt, and builds a skill instruction', () => {
    const fired: Array<[string, string | null]> = [];
    const sch = new RoutineScheduler([], new Store(':memory:'), (_e, p, _n, sk) => fired.push([p, sk]), isEmp, (n) => n === 'daily-note');
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec', skill: 'ghost' })).toThrow(/스킬/);
    expect(() => sch.create({ name: 'a', schedule: '0 9 * * *', employee: 'sec' })).toThrow(/prompt/);
    const r = sch.create({ name: '노트', schedule: '0 9 * * *', employee: 'sec', skill: 'daily-note' });
    expect(r.skill).toBe('daily-note');
    sch.run(r.id, new Date(2026, 10, 23, 9, 0));
    expect(fired[0][1]).toBe('daily-note');
    expect(fired[0][0]).toContain('`office:daily-note`');
    expect(fired[0][0]).not.toContain('추가 메모');
    sch.update(r.id, { skill: '', prompt: 'plain' });
    expect(sch.list()[0].skill).toBeNull();
  });
  it('routinePrompt appends notes for skill routines and passes plain prompts through', () => {
    const now = new Date(2026, 10, 23, 9, 0);
    expect(routinePrompt({ name: 'n', prompt: '오늘은 짧게', skill: 's' }, now)).toMatch(/office:s[\s\S]*추가 메모: 오늘은 짧게$/);
    expect(routinePrompt({ name: 'n', prompt: 'do it', skill: null }, now)).toMatch(/^\[루틴: n · .*\]\ndo it$/);
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
  '- 14:00 랩미팅', //                              2
  '', //                                            3
  '---', //                                         4
  '', //                                            5
  '## 🧬 Active Project', //                        6
  '**[[Lab meeting]]**', //                         7
  'lab_log:: ', //                                  8
  '', //                                            9
  '**[[Tau oligomer binder design]]**', //         10
  'tau_log::', //                                  11
  '- [ ] 전략 정하기 ↻1', //                         12
  '- [x] backbone design 시도 ↻3', //               13
  '', //                                           14
  '**EGFR 논문 작성**', //                          15
  'egfr_log::', //                                 16
  '무조건 이번주까지..!!', //                         17
  '- [ ] **구조 figure 만들기** ↻1', //              18
  '\t- RFdiffusion figure 요청.', //               19
  '\t  - Noise → backbone 과정', //                 20
  '\t- [ ] pose 시각화', //                         21
  '- [ ] method 다시 작성', //                       22
  '', //                                           23
  '**기타**', //                                    24
  '', //                                           25
  '', //                                           26
  '---', //                                        27
  '## 📚 Study', //                                28
  '[[Study/Study|Study]]', //                      29
  '**[[Proteins; Structure and Function]]**', //   30
  '', //                                           31
  '---', //                                        32
  '## 🏢 Office board — 진행 중 작업', //            33
  '- [ ] 무시돼야 함', //                             34
  '',
].join('\n');

describe('Obsidian daily note', () => {
  it('parses sections, projects, carry markers, children and descriptions', () => {
    const secs = parseDaily(NOTE);
    expect(secs.map((s) => s.kind)).toEqual(['schedule', 'project', 'study']);
    expect(secs[0].projects[0].memo).toEqual(['- 14:00 랩미팅']);
    const proj = secs[1].projects;
    expect(proj.map((p) => p.name)).toEqual(['', 'Lab meeting', 'Tau oligomer binder design', 'EGFR 논문 작성', '기타']);
    expect(proj[1]).toMatchObject({ link: 'Lab meeting', items: [] });
    const tau = proj[2];
    expect(tau.items.map((i) => [i.text, i.checked, i.carry, i.line])).toEqual([
      ['전략 정하기', false, 1, 12],
      ['backbone design 시도', true, 3, 13],
    ]);
    const egfr = proj[3];
    expect(egfr.link).toBeNull();
    expect(egfr.memo).toEqual(['무조건 이번주까지..!!']);
    expect(egfr.items.map((i) => i.text)).toEqual(['**구조 figure 만들기**', 'method 다시 작성']);
    expect(egfr.items[0].notes).toEqual([
      { depth: 0, text: 'RFdiffusion figure 요청.' },
      { depth: 1, text: 'Noise → backbone 과정' },
    ]);
    expect(egfr.items[0].children.map((c) => [c.text, c.line])).toEqual([['pose 시각화', 21]]);
    expect(secs[2].projects.map((p) => p.name)).toEqual(['', 'Proteins; Structure and Function']);
    expect(JSON.stringify(secs)).not.toContain('무시돼야 함');
  });

  it('toggles and edits one line, keeping indentation and ↻N', () => {
    const t1 = applyTodoOp(NOTE, { op: 'toggle', line: 12, raw: '- [ ] 전략 정하기 ↻1' });
    expect(t1.split('\n')[12]).toBe('- [x] 전략 정하기 ↻1');
    expect(applyTodoOp(t1, { op: 'toggle', line: 12, raw: '- [x] 전략 정하기 ↻1' })).toBe(NOTE);
    const t2 = applyTodoOp(NOTE, { op: 'edit', line: 21, raw: '\t- [ ] pose 시각화', text: ' 결합 pose\n시각화 ' });
    expect(t2.split('\n')[21]).toBe('\t- [ ] 결합 pose 시각화');
    const t3 = applyTodoOp(NOTE, { op: 'edit', line: 18, raw: '- [ ] **구조 figure 만들기** ↻1', text: '구조 figure 3개' });
    expect(t3.split('\n')[18]).toBe('- [ ] 구조 figure 3개 ↻1');
    expect(() => applyTodoOp(NOTE, { op: 'edit', line: 18, raw: '- [ ] **구조 figure 만들기** ↻1', text: '  ' })).toThrow(/비어/);
  });

  it('adds to the end of a block or under a parent, and deletes whole subtrees', () => {
    const a = applyTodoOp(NOTE, { op: 'add', headerLine: 10, headerRaw: '**[[Tau oligomer binder design]]**', text: '새 할 일' }).split('\n');
    expect(a.slice(12, 16)).toEqual(['- [ ] 전략 정하기 ↻1', '- [x] backbone design 시도 ↻3', '- [ ] 새 할 일', '']);
    const empty = applyTodoOp(NOTE, { op: 'add', headerLine: 24, headerRaw: '**기타**', text: '메일 답장' }).split('\n');
    expect(empty.slice(24, 27)).toEqual(['**기타**', '- [ ] 메일 답장', '']);
    const lab = applyTodoOp(NOTE, { op: 'add', headerLine: 7, headerRaw: '**[[Lab meeting]]**', text: '발표 준비' }).split('\n');
    expect(lab.slice(7, 10)).toEqual(['**[[Lab meeting]]**', 'lab_log:: ', '- [ ] 발표 준비']);
    const sub = applyTodoOp(NOTE, {
      op: 'add', headerLine: 15, headerRaw: '**EGFR 논문 작성**', text: 'surface 렌더', parentLine: 18, parentRaw: '- [ ] **구조 figure 만들기** ↻1',
    }).split('\n');
    expect(sub.slice(21, 24)).toEqual(['\t- [ ] pose 시각화', '\t- [ ] surface 렌더', '- [ ] method 다시 작성']);
    const del = applyTodoOp(NOTE, { op: 'delete', line: 18, raw: '- [ ] **구조 figure 만들기** ↻1' }).split('\n');
    expect(del.slice(17, 20)).toEqual(['무조건 이번주까지..!!', '- [ ] method 다시 작성', '']);
  });

  it('refuses stale edits and keeps CRLF / trailing newline', () => {
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 12, raw: '- [ ] 다른 내용' })).toThrow(/바뀌었습니다/);
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 999, raw: 'x' })).toThrow(/바뀌었습니다/);
    expect(() => applyTodoOp(NOTE, { op: 'toggle', line: 17, raw: '무조건 이번주까지..!!' })).toThrow(/체크박스/);
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const out = applyTodoOp(crlf, { op: 'toggle', line: 12, raw: '- [ ] 전략 정하기 ↻1' });
    expect(out).toBe(crlf.replace('- [ ] 전략 정하기 ↻1', '- [x] 전략 정하기 ↻1'));
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('builds the daily path and reads/writes today\'s note', () => {
    expect(dailyPath('Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md', new Date(2026, 10, 23))).toBe('Daily/2026/2026.11.23.Mon.md');
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const note = new TodayNote({ vault, daily: 'Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md', createCommand: [] }, () => new Date(2026, 10, 23, 9));
    expect(note.load()).toMatchObject({ enabled: true, exists: false, relPath: 'Daily/2026/2026.11.23.Mon.md', vaultName: vault.split('/').pop(), canCreate: false });
    mkdirSync(join(vault, 'Daily/2026'), { recursive: true });
    writeFileSync(join(vault, 'Daily/2026/2026.11.23.Mon.md'), NOTE);
    expect(note.poll()?.exists).toBe(true);
    expect(note.poll()).toBeNull();
    const after = note.apply({ op: 'toggle', line: 22, raw: '- [ ] method 다시 작성' });
    expect(after.sections[1].projects[3].items[1].checked).toBe(true);
    expect(readFileSync(join(vault, 'Daily/2026/2026.11.23.Mon.md'), 'utf8').split('\n')[22]).toBe('- [x] method 다시 작성');
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
  const { effectivePermission } = await import('../src/agents/manager.ts');
  it('a 🔒 task only ever tightens', () => {
    expect(effectivePermission('auto', false)).toBe('auto');
    expect(effectivePermission('auto', true)).toBe('ask');
    expect(effectivePermission('ask', false)).toBe('ask');
    expect(effectivePermission('ask', true)).toBe('ask');
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
    writeFileSync(src, '단백질 구조 메모');
    execFileSync('textutil', ['-convert', 'docx', '-output', join(root, 'memo.docx'), src]);
    const store = new Store(':memory:');
    const lib = new AttachmentLibrary(root, store);
    const v = await lib.save('memo.docx', readFileSync(join(root, 'memo.docx')));
    expect(v.hasText).toBe(true);
    const r = lib.rows([v.id])[0];
    expect(readFileSync(r.textPath!, 'utf8')).toContain('단백질 구조 메모');
    expect(attachmentBlock([r])).toContain('본문 텍스트');
  });
});

describe('lab server guard', async () => {
  const { needsLabApproval } = await import('../src/agents/manager.ts');

  it('flags remote job tools and shell commands that open a remote session', () => {
    for (const t of ['mcp__lab__submit_job', 'mcp__lab__cancel_job', 'mcp__lab__fetch_results']) expect(needsLabApproval(t, {})).toBe(true);
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

  const cfg: any = { id: 'desktop', name: 'desktop', ssh: 'desktop', projectRoot: '~/project', claudePath: '/home/ybshin/.local/bin/claude' };

  it('forwards only the session env, never the local shell env', () => {
    const env = forwardEnv({ PATH: '/opt/homebrew/bin', HOME: '/Users/ybshin', SHELL: '/bin/zsh', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435', CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.5:9b', ANTHROPIC_API_KEY: '', NOPE: undefined });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435', CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.5:9b' });
  });

  it('cds into the session folder and execs the absolute CLI path', () => {
    const cmd = remoteCommand(cfg, { command: '/opt/homebrew/bin/claude', args: ['--output-format', 'stream-json'], cwd: '/home/ybshin/project/rna', env: {} });
    expect(cmd).toBe("cd '/home/ybshin/project/rna' && exec env '/home/ybshin/.local/bin/claude' '--output-format' 'stream-json'");
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
    store.saveSession('exec', 'sess-remote', 0.5, '/home/ybshin/project', 'desktop');
    expect(store.getSession('exec')).toMatchObject({ sessionId: 'sess-remote', cwd: '/home/ybshin/project', hostId: 'desktop' });
    store.saveSession('exec', 'sess-local', 0.5, '/Users/ybshin/x', null); // moved back to this machine
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
    expect(sessionHostId(undefined, 'Shins-MacBook-Air.local')).not.toBe(sessionHostId(undefined, 'desktop'));
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
    expect(() => h.projectDir('bio2token')).toThrow(); // home not known until the health check answers
    (h as any).home = '/home/ybshin';
    expect(h.projectDir('bio2token')).toBe('/home/ybshin/project/bio2token');
    expect(h.projectDir('~/elsewhere')).toBe('/home/ybshin/elsewhere');
    expect(h.projectDir('/data/shared')).toBe('/data/shared'); // absolute stays put
  });

  it('gives each session its own id and never reuses one', () => {
    const s = new Store(':memory:');
    const p = s.createProject('desktop', 'bio2token', 'bio2token');
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
    const p = s.createProject('desktop', 'rna', 'rna');
    const one = s.addProjectSession(p.id);
    s.saveSession(one.id, 'sess-abc', 0.3, '/home/ybshin/project/rna', 'desktop');
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
    expect(heightFor(2)).toBe(240); // unchanged from before the server room came out
    expect(heightFor(3)).toBe(312);
  });

  it('a session only takes a desk once it is let into the office, and gives it back', () => {
    const s = new Store(':memory:');
    const p = s.createProject('desktop', 'rna', 'rna');
    const a = s.addProjectSession(p.id, '학습');
    const b = s.addProjectSession(p.id);
    expect([a.desk, b.desk]).toEqual([-1, -1]); // tab only
    expect(a.label).toBe('학습');
    expect(b.label).toBe('세션 2');

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
