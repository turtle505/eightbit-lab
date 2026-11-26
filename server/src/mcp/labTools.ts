import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isLocalHost, sq } from '../compute/adapter.ts';
import { sshControlOpts, sshThrottle } from '../hosts.ts';
import type { ServerRegistry } from '../compute/registry.ts';
import type { Store } from '../db.ts';
import { bus } from '../bus.ts';
import { cleanMetrics, cleanParams } from '../../../shared/experiments.ts';
import { normalizeTopic } from '../../../shared/topics.ts';

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], isError });

/** In-process MCP server giving one employee access to the lab's GPU servers. Tools appear as mcp__lab__<name>. */

const run = (cmd: string, args: string[]) =>
  new Promise<number>((res) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('close', (c) => res(c ?? -1));
    p.on('error', () => res(-1));
  });

/**
 * Pull a remote path as one gzip stream: `ssh host 'tar czf - -C dir base' | tar xzf - -C dest`.
 * A single connection and a single transfer — `scp -r` would negotiate per file, which is the
 * pattern that gets a lab's IP blocked.
 */
function tarFetch(sshHost: string, remotePath: string, dest: string): Promise<number> {
  const clean = remotePath.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  const dir = slash > 0 ? clean.slice(0, slash) : slash === 0 ? '/' : '.';
  const base = clean.slice(slash + 1) || '.';
  return new Promise((res) => {
    const remote = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...sshControlOpts(), sshHost,
      `tar czf - -C ${sq(dir)} ${sq(base)}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const local = spawn('tar', ['xzf', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'ignore'] });
    remote.stdout.pipe(local.stdin);
    let remoteCode = 0;
    remote.on('close', (c) => (remoteCode = c ?? -1));
    remote.on('error', () => (remoteCode = -1));
    local.on('close', (c) => res(remoteCode !== 0 ? remoteCode : c ?? -1));
    local.on('error', () => res(-1));
  });
}

/** The tool that writes a result into the office's experiment table. It touches no server, so it is always allowed. */
export const RECORD_TOOL = 'mcp__lab__record_result';

const paramsShape = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/**
 * `currentTopic` is the topic of the task the employee is on right now (read at call time: the server is built
 * once per session). With no GPU servers configured only `record_result` is offered.
 */
export function labToolsServer(employeeId: string, cwd: string, registry: ServerRegistry, store: Store, currentTopic: () => string | null = () => null) {
  const hasServers = registry.list().length > 0;
  /** an explicit topic must be a valid one; none falls back to the task being worked on */
  const topicOf = (given: string | undefined): { topic: string | null } | { error: string } => (given?.trim() ? normalizeTopic(given) : { topic: currentTopic() });
  const recordResult = tool(
    'record_result',
    'Write the final numbers of an experiment into the office\'s comparison table, so runs can be compared later. ' +
      'For an office job pass job_id; for something run another way (a local evaluation, a script) pass name instead and a row is created. ' +
      'Calling it again for the same job_id adds to what is there (a metric given again replaces its value). Only record numbers you actually measured.',
    {
      job_id: z.number().int().optional().describe('office job id (from submit_job / job_status)'),
      name: z.string().optional().describe('experiment name, when there is no office job for it'),
      metrics: z.record(z.string(), z.number()).describe('final metrics, name → number, e.g. {"val_loss": 0.412, "rmsd": 1.38}'),
      params: paramsShape.optional().describe('the setup it was run with, if not given at submit, e.g. {"lr": 0.0003, "seed": 1}'),
      topic: z.string().optional().describe('research topic folder name; defaults to the topic of your current task'),
      note: z.string().optional().describe('one line of context: data split, checkpoint, anything needed to read the numbers'),
    },
    async (a) => {
      const m = cleanMetrics(a.metrics);
      if ('error' in m) return text(m.error, true);
      const p = cleanParams(a.params);
      if ('error' in p) return text(p.error, true);
      const tp = topicOf(a.topic);
      if ('error' in tp) return text(tp.error, true);
      const note = a.note?.replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      let job;
      if (a.job_id != null) {
        if (!store.getJob(a.job_id)) return text(`job ${a.job_id} not found`, true);
        job = store.recordResult(a.job_id, { metrics: m.metrics, params: p.params, note, topic: a.topic?.trim() ? tp.topic : undefined });
      } else {
        const name = a.name?.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name) return text('give job_id, or name for a run that was not an office job', true);
        job = store.createJob({ server: '', remoteId: '', name, command: '', submittedBy: employeeId, state: 'recorded', logPath: '', topic: tp.topic, params: p.params, metrics: m.metrics, note });
      }
      if (!job) return text('could not record the result', true);
      bus.send({ t: 'job', data: job });
      bus.emit('resultRecorded', job);
      return text(`recorded on #${job.id} ${job.name}: ${Object.entries(job.metrics ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    },
  );
  return createSdkMcpServer({
    name: 'lab',
    // always in the prompt: these are few, and deferring them costs a ToolSearch turn on every run
    alwaysLoad: true,
    version: '1.0.0',
    instructions: hasServers
      ? 'Remote GPU servers this office can submit jobs to. Check gpu_status before submit_job. Jobs run in a fresh directory on the server; ' +
        'use absolute paths or cd into the project inside `command`. Results stay on the server unless you call fetch_results. ' +
        'Pass the run\'s setup as `params` to submit_job, and when a run is done write its final numbers with record_result.'
      : 'The office\'s experiment table. When you have measured final numbers for a run (training, evaluation, benchmark), write them with record_result so they can be compared with other runs.',
    tools: !hasServers ? [recordResult] : [
      recordResult,
      tool('list_servers', 'List the lab GPU servers with type (ssh/slurm), online status and GPU usage.', {}, async () =>
        text(JSON.stringify(registry.list(), null, 2)),
      ),
      tool('gpu_status', 'Refresh and return live GPU utilization/memory of every server (or one).', { server: z.string().optional() }, async ({ server }) => {
        await registry.refreshServers();
        const list = registry.list().filter((s) => !server || s.name === server);
        return text(JSON.stringify(list, null, 2));
      }),
      tool(
        'submit_job',
        'Submit a shell job to a remote GPU server. `command` is bash run after the server setup (conda env etc.). Returns the office job id.',
        {
          server: z.string().describe('server name from list_servers'),
          name: z.string().describe('short job name, e.g. train-frameflow-v2'),
          command: z.string().describe('bash commands, e.g. "cd ~/proj && python train.py --cfg cfg.yaml"'),
          gpus: z.number().int().min(0).max(8).optional().describe('GPUs to request (slurm only)'),
          params: paramsShape.optional().describe('the setup of this run for the comparison table, e.g. {"lr": 0.0003, "model": "v2", "seed": 1}'),
          topic: z.string().optional().describe('research topic folder name; defaults to the topic of your current task'),
        },
        async (a) => {
          const p = cleanParams(a.params);
          if ('error' in p) return text(p.error, true);
          const tp = topicOf(a.topic);
          if ('error' in tp) return text(tp.error, true);
          try {
            const job = await registry.submit({ server: a.server, name: a.name, command: a.command, gpus: a.gpus, submittedBy: employeeId, topic: tp.topic, params: p.params });
            return text(`submitted job #${job.id} on ${job.server} (remote id ${job.remoteId}). log: ${job.logPath}`);
          } catch (e) {
            return text(String((e as Error).message), true);
          }
        },
      ),
      tool('job_status', 'Get state of office jobs (all recent, or one by id).', { job_id: z.number().int().optional() }, async ({ job_id }) => {
        if (job_id != null) {
          const j = store.getJob(job_id);
          if (!j) return text(`job ${job_id} not found`, true);
          return text(JSON.stringify(await registry.refreshJob(j), null, 2));
        }
        return text(JSON.stringify(store.listJobs(30), null, 2));
      }),
      tool('tail_log', 'Show the last N lines of a job log.', { job_id: z.number().int(), lines: z.number().int().optional() }, async ({ job_id, lines }) => {
        const j = store.getJob(job_id);
        if (!j) return text(`job ${job_id} not found`, true);
        try {
          return text(await registry.get(j.server).tail(j.logPath, lines ?? 80));
        } catch (e) {
          return text(String((e as Error).message), true);
        }
      }),
      tool('cancel_job', 'Cancel a running job.', { job_id: z.number().int() }, async ({ job_id }) => {
        try {
          await registry.cancel(job_id);
          return text(`cancel requested for job ${job_id}`);
        } catch (e) {
          return text(String((e as Error).message), true);
        }
      }),
      tool(
        'fetch_results',
        'Copy a file or directory from a server into your local working directory (under remote_results/). ' +
          'It is streamed as one compressed archive over a single connection, so fetching a whole folder at once ' +
          'is correct and much kinder to the network than copying files one by one.',
        { server: z.string(), remote_path: z.string() },
        async ({ server, remote_path }) => {
          try {
            const cfg = registry.get(server).cfg;
            const dest = resolve(cwd, 'remote_results', server);
            mkdirSync(dest, { recursive: true });
            // `ssh_host: local` means the backend already runs on that machine — a plain copy, no network
            const local = isLocalHost(cfg.ssh_host);
            if (local) {
              const code = await run('cp', ['-r', remote_path, dest]);
              return code === 0 ? text(`copied to ${dest}`) : text(`cp failed (exit ${code})`, true);
            }
            if (!(await sshThrottle.reserve(cfg.ssh_host, 70_000)))
              return text(
                `ssh rate limit reached (${cfg.ssh_host}: ${sshThrottle.limitFor(cfg.ssh_host)} per minute), so the results cannot be fetched right now. Try again shortly.`,
                true,
              );
            // One compressed stream over one connection. `scp -r` of a folder talks per file, which is
            // what gets lab IPs blocked; tar sends a single archive instead.
            const code = await tarFetch(cfg.ssh_host, remote_path, dest);
            return code === 0 ? text(`copied to ${dest} (one compressed stream)`) : text(`transfer failed (exit ${code})`, true);
          } catch (e) {
            return text(String((e as Error).message), true);
          }
        },
      ),
    ],
  });
}
