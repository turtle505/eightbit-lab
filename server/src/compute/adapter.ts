import { spawn } from 'node:child_process';
import { sshControlOpts } from '../hosts.ts';
import type { GpuInfo, JobState } from '../../../shared/protocol.ts';
import type { ServerConfig } from '../config.ts';

export interface SubmitSpec {
  name: string;
  command: string; // shell commands run inside workdir after `setup`
  gpus?: number;
}

export interface SubmitResult {
  remoteId: string;
  logPath: string;
}

export interface ComputeAdapter {
  readonly cfg: ServerConfig;
  gpuStats(): Promise<{ gpus: GpuInfo[]; note: string }>;
  submit(spec: SubmitSpec): Promise<SubmitResult>;
  status(remoteId: string): Promise<JobState>;
  tail(logPath: string, lines: number): Promise<string>;
  cancel(remoteId: string): Promise<void>;
}

export interface Exec {
  (host: string, script: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Run a bash script on a remote host via ssh (script sent on stdin; BatchMode so it never hangs on a password prompt). */
export const sshExec: Exec = (host, script, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    // polled every 20-60s, so it shares one master connection per host (see hosts.ts sshControlOpts)
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...sshControlOpts(), host, 'bash -s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      stderr += `\n[timeout after ${timeoutMs}ms]`;
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    p.stdin.end(script);
  });

/**
 * Run the script on this machine. Used when a server's `ssh_host` is `local`, i.e. the backend
 * already runs on that machine — going out through ssh to reach ourselves would need a key back in.
 */
export const localExec: Exec = (_host, script, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    const p = spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      stderr += `\n[timeout after ${timeoutMs}ms]`;
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    p.stdin.end(script);
  });

/** `ssh_host: local` means "this machine" — no ssh hop. */
export const isLocalHost = (sshHost: string) => sshHost === 'local';

/** Single-quote a string for bash. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Safe job directory name. */
export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'job';

export function parseNvidiaSmi(out: string): GpuInfo[] {
  return out
    .trim()
    .split('\n')
    .filter((l) => l.includes(','))
    .map((l) => {
      const [index, name, util, memUsed, memTotal] = l.split(',').map((x) => x.trim());
      return { index: Number(index), name, util: Number(util) || 0, memUsed: Number(memUsed) || 0, memTotal: Number(memTotal) || 0 };
    });
}

export const NVIDIA_SMI = 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits';

/** Builds the job script written to <workdir>/<jobdir>/run.sh on the remote. */
export function jobScript(cfg: ServerConfig, spec: SubmitSpec, header = ''): string {
  return ['#!/bin/bash', header, 'set -eo pipefail', cfg.setup ?? '', 'cd "$(dirname "$0")"', 'echo "[office] start $(date)"', spec.command, 'echo "[office] done $(date)"']
    .filter(Boolean)
    .join('\n');
}
