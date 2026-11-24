import { tr } from '../../../shared/i18n.ts';
import type { JobState } from '../../../shared/protocol.ts';
import type { ServerConfig } from '../config.ts';
import { type ComputeAdapter, type Exec, type SubmitSpec, jobScript, slug, sq, sshExec } from './adapter.ts';
import { wdPrelude } from './ssh.ts';

/** SLURM cluster reached through its login node. remoteId = slurm job id. */
export class SlurmAdapter implements ComputeAdapter {
  constructor(readonly cfg: ServerConfig, private exec: Exec = sshExec) {}

  async gpuStats() {
    const p = this.cfg.slurm?.partition;
    const r = await this.exec(
      this.cfg.ssh_host,
      [
        `echo "MINE=$(squeue -h -u $USER | wc -l) RUN=$(squeue -h -u $USER -t R | wc -l)"`,
        `sinfo -h ${p ? `-p ${sq(p)}` : ''} -o "%T %D" 2>/dev/null | awk '{a[$1]+=$2} END {for (k in a) printf "%s:%d ", k, a[k]}'`,
      ].join('\n'),
      20_000,
    );
    if (r.code !== 0 && !r.stdout.includes('MINE=')) throw new Error(r.stderr.trim() || `ssh exit ${r.code}`);
    const mine = /MINE=(\d+) RUN=(\d+)/.exec(r.stdout);
    const nodes = r.stdout.split('\n').slice(1).join(' ').trim();
    return { gpus: [], note: tr({
        ko: `내 job ${mine?.[1] ?? '?'}개 (실행 ${mine?.[2] ?? '?'}) · 노드 ${nodes || '?'}`,
        en: `my jobs ${mine?.[1] ?? '?'} (running ${mine?.[2] ?? '?'}) · nodes ${nodes || '?'}`,
      }) };
  }

  async submit(spec: SubmitSpec) {
    const o = this.cfg.slurm ?? {};
    const dir = `${Date.now()}_${slug(spec.name)}`;
    const gres = spec.gpus != null ? `gpu:${spec.gpus}` : o.gres;
    const header = [
      `#SBATCH --job-name=${slug(spec.name)}`,
      `#SBATCH --output=out.log`,
      o.partition && `#SBATCH --partition=${o.partition}`,
      gres && `#SBATCH --gres=${gres}`,
      o.cpus_per_task && `#SBATCH --cpus-per-task=${o.cpus_per_task}`,
      o.mem && `#SBATCH --mem=${o.mem}`,
      o.time && `#SBATCH --time=${o.time}`,
      o.account && `#SBATCH --account=${o.account}`,
      ...(o.extra ?? []).map((e) => `#SBATCH ${e}`),
    ]
      .filter(Boolean)
      .join('\n');
    const script = jobScript(this.cfg, spec, header);
    const r = await this.exec(
      this.cfg.ssh_host,
      [
        wdPrelude(this.cfg.workdir),
        `JD="$WD/${dir}"; mkdir -p "$JD"`,
        `cat > "$JD/run.sh" <<'__OFFICE_EOF__'\n${script}\n__OFFICE_EOF__`,
        `cd "$JD" && echo "JOBID=$(sbatch --parsable run.sh)"; echo "JD=$JD"`,
      ].join('\n'),
    );
    const id = /JOBID=(\d+)/.exec(r.stdout)?.[1];
    const jd = /JD=(.+)/.exec(r.stdout)?.[1]?.trim();
    if (!id || !jd) throw new Error(`sbatch failed: ${r.stderr || r.stdout}`);
    return { remoteId: id, logPath: `${jd}/out.log` };
  }

  async status(remoteId: string): Promise<JobState> {
    const id = Number(remoteId);
    const r = await this.exec(
      this.cfg.ssh_host,
      `S=$(squeue -h -j ${id} -o %T 2>/dev/null); if [ -n "$S" ]; then echo "$S"; else sacct -n -X -j ${id} -o State 2>/dev/null | head -1; fi`,
    );
    return parseSlurmState(r.stdout);
  }

  async tail(logPath: string, lines: number) {
    const r = await this.exec(this.cfg.ssh_host, `tail -n ${Math.max(1, Math.min(lines, 500))} ${sq(logPath)} 2>&1`);
    return r.stdout || r.stderr;
  }

  async cancel(remoteId: string) {
    await this.exec(this.cfg.ssh_host, `scancel ${Number(remoteId)}`);
  }
}

export function parseSlurmState(out: string): JobState {
  const s = out.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (['PENDING', 'CONFIGURING', 'REQUEUED', 'RESIZING', 'SUSPENDED'].includes(s)) return 'pending';
  if (['RUNNING', 'COMPLETING', 'STAGE_OUT'].includes(s)) return 'running';
  if (s === 'COMPLETED') return 'completed';
  if (s.startsWith('CANCELLED')) return 'cancelled';
  if (['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'BOOT_FAIL', 'DEADLINE', 'PREEMPTED'].includes(s)) return 'failed';
  return 'unknown';
}
