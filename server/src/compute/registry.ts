import { tr } from '../../../shared/i18n.ts';
import type { Job, ServerView } from '../../../shared/protocol.ts';
import { bus } from '../bus.ts';
import type { ServerConfig } from '../config.ts';
import type { Store } from '../db.ts';
import { isLocalHost, localExec, type ComputeAdapter, type SubmitSpec } from './adapter.ts';
import { SlurmAdapter } from './slurm.ts';
import { SshAdapter } from './ssh.ts';

type JobListener = (job: Job) => void;

/** Owns all GPU servers: periodic health polling, job submission and job-state tracking. */
export class ServerRegistry {
  adapters = new Map<string, ComputeAdapter>();
  views = new Map<string, ServerView>();
  private finishedListeners: JobListener[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(configs: ServerConfig[], private store: Store) {
    for (const c of configs) {
      const exec = isLocalHost(c.ssh_host) ? localExec : undefined;
      this.adapters.set(c.name, c.type === 'slurm' ? new SlurmAdapter(c, exec) : new SshAdapter(c, exec));
      this.views.set(c.name, { name: c.name, type: c.type, online: false, gpus: [], note: tr({ ko: '확인 전', en: 'not checked yet' }), checkedAt: 0 });
    }
  }

  list(): ServerView[] {
    return [...this.views.values()];
  }

  /** Is this server somewhere else? An unknown name counts as remote — the cautious answer. */
  isRemote(name: string): boolean {
    const a = this.adapters.get(name);
    return a ? !isLocalHost(a.cfg.ssh_host) : true;
  }

  get(name: string): ComputeAdapter {
    const a = this.adapters.get(name);
    if (!a) throw new Error(`Unknown server: ${name}. Available: ${[...this.adapters.keys()].join(', ') || '(none; configure config/servers.local.yaml)'}`);
    return a;
  }

  onJobFinished(fn: JobListener) {
    this.finishedListeners.push(fn);
  }

  start(serverEveryMs = 60_000, jobEveryMs = 20_000) {
    void this.refreshServers();
    void this.pollJobs();
    this.timers.push(setInterval(() => void this.refreshServers(), serverEveryMs));
    this.timers.push(setInterval(() => void this.pollJobs(), jobEveryMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  async refreshServers() {
    await Promise.all(
      [...this.adapters.values()].map(async (a) => {
        let view: ServerView;
        try {
          const { gpus, note } = await a.gpuStats();
          view = { name: a.cfg.name, type: a.cfg.type, online: true, gpus, note, checkedAt: Date.now() };
        } catch (e) {
          view = { name: a.cfg.name, type: a.cfg.type, online: false, gpus: [], note: String((e as Error).message).slice(0, 200), checkedAt: Date.now() };
        }
        this.views.set(a.cfg.name, view);
        bus.send({ t: 'server', data: view });
      }),
    );
  }

  async submit(spec: SubmitSpec & { server: string; submittedBy: string | null }): Promise<Job> {
    const a = this.get(spec.server);
    const { remoteId, logPath } = await a.submit(spec);
    const job = this.store.createJob({
      server: spec.server,
      remoteId,
      name: spec.name,
      command: spec.command,
      submittedBy: spec.submittedBy,
      state: 'pending',
      logPath,
    });
    bus.send({ t: 'job', data: job });
    return job;
  }

  async refreshJob(job: Job): Promise<Job> {
    const a = this.adapters.get(job.server);
    if (!a) return job;
    let state = job.state;
    try {
      state = await a.status(job.remoteId);
    } catch {
      return job;
    }
    if (state === job.state) return job;
    const updated = this.store.setJobState(job.id, state)!;
    bus.send({ t: 'job', data: updated });
    if (['completed', 'failed', 'cancelled'].includes(state)) this.finishedListeners.forEach((f) => f(updated));
    return updated;
  }

  async pollJobs() {
    await Promise.all(this.store.activeJobs().map((j) => this.refreshJob(j)));
  }

  async cancel(jobId: number) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(tr({ ko: `job ${jobId} 없음`, en: `No job ${jobId}` }));
    await this.get(job.server).cancel(job.remoteId);
    await this.refreshJob(job);
  }
}
