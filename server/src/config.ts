import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { PermissionSetting } from '../../shared/protocol.ts';
import { tr, type Lang } from '../../shared/i18n.ts';
import { DEFAULT_NOTE_FORMAT, type NoteFormat } from './obsidian.ts';

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
  /** close an idle employee session after this many minutes (0 = never close) */
  sessionIdleMinutes: number;
  /** machines sessions can run on; `local` is this machine */
  hosts: HostConfig[];
  /** shared secret the browser/scripts must present; empty = no lock (loopback only) */
  authToken: string;
  /** most ssh/scp runs the office starts per host per minute (shared servers ban noisy clients) */
  sshPerMinute: number;
  /** language of the UI and of what agents report in (prompts stay English); the UI toggle overrides it */
  language: Lang;
  /** what the team works on, one line; put in front of every prompt as "About this team: …" (empty = left out) */
  domain: string;
}

/**
 * A model backend other than the Claude subscription. Only `ollama` exists now: an Ollama server reached
 * through an SSH tunnel and spoken to through its Anthropic-compatible API. A future kind (e.g. codex)
 * needs its own runner in AgentManager.
 */
/** A machine the office starts Claude Code sessions on. */
export interface HostConfig {
  id: string;
  /** label in the UI, e.g. "🖥 desktop" */
  name: string;
  /** 'local' = the machine the backend runs on; otherwise an ssh alias from ~/.ssh/config */
  ssh: string;
  /** where this host's project folders live, e.g. ~/project */
  projectRoot: string;
  /** absolute path to the CLI — a non-login ssh often lacks ~/.local/bin on PATH */
  claudePath?: string;
  /** ssh/scp runs per minute for this host; omitted = office.sshPerMinute, 0 = no limit */
  sshPerMinute?: number;
}

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

/** `sections` / `schedule` (NoteFormat): which "## " headings are read, and which of them are a schedule */
export interface ObsidianConfig extends NoteFormat {
  vault: string;
  /** daily note path inside the vault: {YYYY} {MM} {DD} {ddd}(Mon); default Obsidian's own "{YYYY}-{MM}-{DD}.md" */
  daily: string;
  /** argv run (no shell, cwd = vault) by the "create today's note" button; "{vault}" is substituted. Empty = no button */
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
  /** a fixed seat instead of a slot in the desk grid */
  seat?: 'reception' | 'lead';
  deskStyle?: 'lead';
  /** overrides office.permissionMode for this employee */
  permissionMode?: PermissionSetting;
  /** machine this employee's sessions run on (office.hosts id); omitted = local */
  host?: string;
  /** 'project' employees are created at runtime for a project folder, not read from roles.yaml */
  kind?: 'staff' | 'project';
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
          daily: c.obsidian.daily || '{YYYY}-{MM}-{DD}.md',
          createCommand: c.obsidian.createCommand ?? [],
          sections: (c.obsidian.sections ?? DEFAULT_NOTE_FORMAT.sections).map(String),
          schedule: (c.obsidian.schedule ?? DEFAULT_NOTE_FORMAT.schedule).map(String),
        }
      : null,
    permissionMode: c.permissionMode === 'ask' ? 'ask' : 'auto',
    sessionIdleMinutes: c.sessionIdleMinutes ?? 30,
    authToken: String(c.authToken ?? '').trim(),
    sshPerMinute: Math.max(1, c.sshPerMinute ?? 5),
    language: c.language === 'ko' ? 'ko' : 'en',
    domain: String(c.domain ?? '').trim(),
    hosts: normalizeHosts(mergeByKey(base.hosts ?? [], local.hosts ?? [], 'id')),
    providers: normalizeProviders(mergeByKey(base.providers ?? [], local.providers ?? [], 'id')),
  };
}

export function normalizeHosts(list: Partial<HostConfig>[]): HostConfig[] {
  const out: HostConfig[] = [];
  for (const h of list) {
    if (!h.id || !h.ssh) {
      console.warn(
        tr({
          ko: `⚠️ host ${h.id ?? '(id 없음)'}: id 와 ssh 가 필요합니다 — 무시함`,
          en: `⚠️ host ${h.id ?? '(no id)'}: id and ssh are required — ignored`,
        }),
      );
      continue;
    }
    out.push({
      id: h.id,
      name: h.name || h.id,
      ssh: h.ssh,
      projectRoot: h.projectRoot || '~/project',
      claudePath: h.claudePath,
      sshPerMinute: h.sshPerMinute,
    });
  }
  return out;
}

export function normalizeProviders(list: Partial<ProviderConfig>[]): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const p of list) {
    if (!p.id || !p.ssh_host || !p.model) {
      console.warn(
        tr({
          ko: `⚠️ provider ${p.id ?? '(id 없음)'}: id, ssh_host, model 이 필요합니다 — 무시함`,
          en: `⚠️ provider ${p.id ?? '(no id)'}: id, ssh_host and model are required — ignored`,
        }),
      );
      continue;
    }
    if ((p.kind ?? 'ollama') !== 'ollama') {
      console.warn(tr({ ko: `⚠️ provider ${p.id}: 지원하지 않는 kind ${p.kind} — 무시함`, en: `⚠️ provider ${p.id}: unsupported kind ${p.kind} — ignored` }));
      continue;
    }
    out.push({ id: p.id, name: p.name || p.id, kind: 'ollama', ssh_host: p.ssh_host, remotePort: p.remotePort ?? 11434, localPort: p.localPort ?? 11435, model: p.model });
  }
  return out;
}

/** A top-level text block of roles.yaml (`common`, `servers`); roles.local.yaml replaces it whole, "" turns it off. */
function rolesBlock(key: 'common' | 'servers'): string {
  const base = readYaml<Record<string, string>>('config/roles.yaml', {})[key] ?? '';
  const local = readYaml<Record<string, string>>('config/roles.local.yaml', {})[key];
  return (local ?? base).trim();
}

/**
 * What every session's prompt starts with: the team's field (office.domain), the shared rules (`common`), and the
 * remote-server etiquette (`servers`) only when there are servers to be careful with.
 */
export function teamPrompt(domain: string, withServers: boolean): string {
  return [domain && `About this team: ${domain}`, rolesBlock('common'), withServers ? rolesBlock('servers') : '']
    .filter(Boolean)
    .join('\n\n');
}

export function loadRoles(domain = '', withServers = false): RoleConfig[] {
  const common = teamPrompt(domain, withServers);
  return readLayered<RoleConfig>('roles', 'employees', 'id').map((r) => ({
    ...r,
    autoAllow: r.autoAllow ?? [],
    useWorktree: !!r.useWorktree,
    systemPrompt: common ? `${common}\n\n${(r.systemPrompt ?? '').trim()}` : r.systemPrompt,
  }));
}

export function loadRoutines(): RoutineConfig[] {
  return readLayered<RoutineConfig>('routines', 'routines', 'id');
}

export function loadServers(): ServerConfig[] {
  // servers.yaml (legacy, git-ignored) + servers.local.yaml
  return readLayered<ServerConfig>('servers', 'servers', 'name');
}
