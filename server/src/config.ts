import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface OfficeConfig {
  port: number;
  maxConcurrent: number;
  model: string;
  researchRepo: string;
  workspaceRoot: string;
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
}

export interface RoutineConfig {
  id: string;
  name: string;
  schedule: string;
  employee: string;
  enabled?: boolean;
  prompt: string;
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
  const c = {
    ...readYaml<Partial<OfficeConfig>>('config/office.yaml', {}),
    ...readYaml<Partial<OfficeConfig>>('config/office.local.yaml', {}),
  };
  return {
    port: c.port ?? 8787,
    maxConcurrent: c.maxConcurrent ?? 3,
    model: c.model ?? '',
    researchRepo: c.researchRepo ? resolve(ROOT, c.researchRepo) : '',
    workspaceRoot: resolve(ROOT, c.workspaceRoot ?? './workspaces'),
  };
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
