import type { JobState } from '../../../shared/protocol.ts';
import type { ServerConfig } from '../config.ts';
import { type ComputeAdapter, type Exec, type SubmitSpec, NVIDIA_SMI, jobScript, parseNvidiaSmi, slug, sq, sshExec } from './adapter.ts';

/** Expands a leading ~ in the configured workdir on the remote side. */
export const wdPrelude = (workdir: string) => `WD=${sq(workdir)}; WD="\${WD/#\\~/$HOME}"; mkdir -p "$WD"`;

/** Plain SSH box: jobs run detached with setsid/nohup; exit code written next to the log. remoteId = "<pid>:<jobdir>". */
export class SshAdapter implements ComputeAdapter {
  constructor(readonly cfg: ServerConfig, private exec: Exec = sshExec) {}

  async gpuStats() {
    const r = await this.exec(this.cfg.ssh_host, `${NVIDIA_SMI}; echo "---"; uptime`, 20_000);
    if (r.code !== 0 && !r.stdout.includes('---')) throw new Error(r.stderr.trim() || `ssh exit ${r.code}`);
    const [smi, up = ''] = r.stdout.split('---');
    return { gpus: parseNvidiaSmi(smi), note: up.trim().replace(/.*load average/, 'load') };
  }

  async submit(spec: SubmitSpec) {
    const dir = `${Date.now()}_${slug(spec.name)}`;
    const script = jobScript(this.cfg, spec);
    const r = await this.exec(
      this.cfg.ssh_host,
      [
        wdPrelude(this.cfg.workdir),
        `JD="$WD/${dir}"; mkdir -p "$JD"`,
        `cat > "$JD/run.sh" <<'__OFFICE_EOF__'\n${script}\n__OFFICE_EOF__`,
        `cd "$JD" && setsid nohup bash -c 'bash run.sh > out.log 2>&1; echo $? > exitcode' > /dev/null 2>&1 < /dev/null &`,
        `echo "PID=$!"; echo "JD=$JD"`,
      ].join('\n'),
    );
    const pid = /PID=(\d+)/.exec(r.stdout)?.[1];
    const jd = /JD=(.+)/.exec(r.stdout)?.[1]?.trim();
    if (!pid || !jd) throw new Error(`submit failed: ${r.stderr || r.stdout}`);
    return { remoteId: `${pid}:${jd}`, logPath: `${jd}/out.log` };
  }

  async status(remoteId: string): Promise<JobState> {
    const [pid, jd] = splitId(remoteId);
    const r = await this.exec(
      this.cfg.ssh_host,
      `if [ -f ${sq(jd)}/cancelled ]; then echo CANCELLED; elif [ -f ${sq(jd)}/exitcode ]; then echo "EXIT=$(cat ${sq(jd)}/exitcode)"; elif kill -0 ${Number(pid)} 2>/dev/null; then echo RUNNING; else echo GONE; fi`,
    );
    return parseSshStatus(r.stdout);
  }

  async tail(logPath: string, lines: number) {
    const r = await this.exec(this.cfg.ssh_host, `tail -n ${Math.max(1, Math.min(lines, 500))} ${sq(logPath)} 2>&1`);
    return r.stdout || r.stderr;
  }

  async cancel(remoteId: string) {
    const [pid, jd] = splitId(remoteId);
    // kill the whole session group started by setsid
    await this.exec(this.cfg.ssh_host, `touch ${sq(jd)}/cancelled; kill -TERM -- -${Number(pid)} 2>/dev/null || kill -TERM ${Number(pid)} 2>/dev/null; true`);
  }
}

function splitId(remoteId: string): [string, string] {
  const i = remoteId.indexOf(':');
  return [remoteId.slice(0, i), remoteId.slice(i + 1)];
}

export function parseSshStatus(out: string): JobState {
  const s = out.trim();
  if (s === 'RUNNING') return 'running';
  if (s === 'CANCELLED') return 'cancelled';
  const m = /EXIT=(\d+)/.exec(s);
  if (m) return m[1] === '0' ? 'completed' : 'failed';
  if (s === 'GONE') return 'failed';
  return 'unknown';
}
