import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HostConfig } from '../config.ts';
import { sq } from '../compute/adapter.ts';
import { muxErrorText, SSH_MUX, sshMux } from '../hosts.ts';

/** Transfer the manager's attachments as one archive inside the host's shared connection and rewrite their prompt paths. */
export async function stageCodexAttachments(host: HostConfig, text: string, paths: string[]): Promise<string> {
  if (!paths.length || host.ssh === 'local') return text;
  const stage = await mkdtemp(join(tmpdir(), 'eightbit-codex-'));
  const remote = `/tmp/eightbit-attachments/${randomUUID()}`;
  try {
    for (const [i, src] of [...new Set(paths)].entries()) {
      const name = `${i}-${basename(src)}`;
      await copyFile(src, join(stage, name));
      text = text.replaceAll(src, `${remote}/${name}`);
    }
    const m = await sshMux.ensure(host.ssh, { wait: true });
    if (!m.ok) throw new Error(muxErrorText(host.ssh, m));
    const archive = spawn('tar', ['-C', stage, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const receiver = spawn('ssh', [...SSH_MUX, host.ssh, `mkdir -p ${sq(remote)} && tar -xf - -C ${sq(remote)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(receiver.stdin);
    let errors = '';
    archive.stderr.on('data', (b) => { errors += String(b); });
    receiver.stderr.on('data', (b) => { errors += String(b); });
    const [archiveCode, receiverCode] = await Promise.all([
      new Promise<number>((resolve, reject) => { archive.on('error', reject); archive.on('close', (n) => resolve(n ?? -1)); }),
      new Promise<number>((resolve, reject) => { receiver.on('error', reject); receiver.on('close', (n) => resolve(n ?? -1)); }),
    ]);
    if (archiveCode || receiverCode) throw new Error(`Attachment transfer failed: ${errors.trim() || `${archiveCode}/${receiverCode}`}`);
    return text;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
