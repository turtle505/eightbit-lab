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
    const sch = new RoutineScheduler([{ id: 'x', name: 'X', schedule: '0 9 * * *', employee: 'ghost', prompt: '' }], new Store(':memory:'), () => {}, () => false);
    expect(sch.list()).toHaveLength(0);
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
