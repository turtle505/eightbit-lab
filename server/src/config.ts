import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { PermissionSetting } from '../../shared/protocol.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface OfficeConfig {
  port: number;
  maxConcurrent: number;
  model: string;
  researchRepo: string;
  workspaceRoot: string;
  /** extra folders scanned for .md reports (besides workspaces/<name>/reports) */
  reportDirs: string[];
  /** today's to-do panel from an Obsidian daily note; null = feature off */
  obsidian: ObsidianConfig | null;
  /** non-Claude model backends an employee can be wired to via `provider: <id>` (roles.yaml) */
  providers: ProviderConfig[];
  /** default permission mode of every employee ('auto' unless set) */
  permissionMode: PermissionSetting;
}

/**
 * A model backend other than the Claude subscription. Only `ollama` exists now: an Ollama server reached
 * through an SSH tunnel and spoken to through its Anthropic-compatible API. A future kind (e.g. codex)
 * needs its own runner in AgentManager.
 */
export interface ProviderConfig {
  id: string;
  /** label in the UI, e.g. "🖥 desktop" */
  name: string;
  kind: 'ollama';
  /** ssh alias of the machine running `ollama serve` */
  ssh_host: string;
  /** Ollama port on that machine (default 11434) */
  remotePort: number;
  /** local end of the tunnel (default 11435, so a local Ollama on 11434 doesn't clash) */
  localPort: number;
  /** default model; the UI can switch to any installed model */
  model: string;
}

export interface ObsidianConfig {
  vault: string;
  /** daily note path inside the vault: {YYYY} {MM} {DD} {ddd}(Mon) */
  daily: string;
  /** argv run (no shell, cwd = vault) by the "오늘 노트 만들기" button; "{vault}" is substituted. Empty = no button */
  createCommand: string[];
}

export interface RoleConfig {
  id: string;
  name: string;
  title: string;
  desk: number;
  sprite: { hair: string; shirt: string; pants: string; skin: string };
  useWorktree: boolean;
  autoAllow: string[];
  systemPrompt: string;
  model?: string;
  /** fixed working directory (relative to project root); overrides repo/worktree logic */
  cwd?: string;
  /** give this employee the mcp__office__* tools (board, staff status, delegation) */
  officeTools?: boolean;
  /** always sit at the own desk (never walks to the coffee spot or the server racks) */
  stayAtDesk?: boolean;
  /** 'lead' draws the executive desk */
  deskStyle?: 'lead';
  /** overrides office.permissionMode for this employee */
  permissionMode?: PermissionSetting;
  /** run on this provider (office.providers id) instead of the Claude subscription */
  provider?: string;
}

export interface RoutineConfig {
  id: string;
  name: string;
  schedule: string;
  employee: string;
  enabled?: boolean;
  prompt: string;
  /** office skill to run (office:<skill>); prompt then becomes optional extra notes */
  skill?: string;
}

export interface SlurmOptions {
  partition?: string;
  gres?: string;
  cpus_per_task?: number;
  mem?: string;
  time?: string;
  account?: string;
  extra?: string[];
}

export interface ServerConfig {
  name: string;
  type: 'ssh' | 'slurm';
  ssh_host: string;
  workdir: string;
  setup?: string;
  slurm?: SlurmOptions;
}

function readYaml<T>(rel: string, fallback: T): T {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return fallback;
  return (parse(readFileSync(p, 'utf8')) ?? fallback) as T;
}

/**
 * Personal overrides: config/<name>.local.yaml (git-ignored) is layered on top of config/<name>.yaml.
 * Lists are merged by key: same key → fields overridden, new key → appended.
 */
export function mergeByKey<T extends Record<string, any>>(base: T[], local: T[], key: keyof T): T[] {
  const out = base.map((b) => ({ ...b }));
  for (const l of local) {
    const i = out.findIndex((b) => b[key] === l[key]);
    if (i >= 0) out[i] = { ...out[i], ...l };
    else out.push({ ...l });
  }
  return out;
}

function readLayered<T extends Record<string, any>>(name: string, listKey: string, key: keyof T): T[] {
  const base = readYaml<Record<string, T[]>>(`config/${name}.yaml`, {})[listKey] ?? [];
  const local = readYaml<Record<string, T[]>>(`config/${name}.local.yaml`, {})[listKey] ?? [];
  return mergeByKey(base, local, key);
}

export function loadOffice(): OfficeConfig {
  const base = readYaml<Partial<OfficeConfig>>('config/office.yaml', {});
  const local = readYaml<Partial<OfficeConfig>>('config/office.local.yaml', {});
  const c = { ...base, ...local };
  return {
    port: c.port ?? 8787,
    maxConcurrent: c.maxConcurrent ?? 3,
    model: c.model ?? '',
    researchRepo: c.researchRepo ? resolve(ROOT, c.researchRepo) : '',
    workspaceRoot: resolve(ROOT, c.workspaceRoot ?? './workspaces'),
    reportDirs: (c.reportDirs ?? []).map((d) => resolve(ROOT, d)),
    obsidian: c.obsidian?.vault
      ? {
          vault: resolve(ROOT, c.obsidian.vault),
          daily: c.obsidian.daily || 'Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md',
          createCommand: c.obsidian.createCommand ?? [],
        }
      : null,
    permissionMode: c.permissionMode === 'ask' ? 'ask' : 'auto',
    providers: normalizeProviders(mergeByKey(base.providers ?? [], local.providers ?? [], 'id')),
  };
}

export function normalizeProviders(list: Partial<ProviderConfig>[]): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const p of list) {
    if (!p.id || !p.ssh_host || !p.model) {
      console.warn(`⚠️ provider ${p.id ?? '(id 없음)'}: id, ssh_host, model 이 필요합니다 — 무시함`);
      continue;
    }
    if ((p.kind ?? 'ollama') !== 'ollama') {
      console.warn(`⚠️ provider ${p.id}: 지원하지 않는 kind ${p.kind} — 무시함`);
      continue;
    }
    out.push({ id: p.id, name: p.name || p.id, kind: 'ollama', ssh_host: p.ssh_host, remotePort: p.remotePort ?? 11434, localPort: p.localPort ?? 11435, model: p.model });
  }
  return out;
}

export function loadRoles(): RoleConfig[] {
  return readLayered<RoleConfig>('roles', 'employees', 'id').map((r) => ({ ...r, autoAllow: r.autoAllow ?? [], useWorktree: !!r.useWorktree }));
}

export function loadRoutines(): RoutineConfig[] {
  return readLayered<RoutineConfig>('routines', 'routines', 'id');
}

export function loadServers(): ServerConfig[] {
  // servers.yaml (legacy, git-ignored) + servers.local.yaml
  return readLayered<ServerConfig>('servers', 'servers', 'name');
}
