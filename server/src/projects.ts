import { tr } from '../../shared/i18n.ts';
import type { EmployeeView, ProjectView } from '../../shared/protocol.ts';
import type { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import type { RoleConfig } from './config.ts';
import type { Store } from './db.ts';
import type { HostRegistry } from './hosts.ts';

/** Deterministic colour from a string, so a session always looks the same. */
const hashOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
};
const hsl = (h: number, s: number, l: number) => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

const HAIR = ['#2b1d14', '#3b2a1a', '#111111', '#5b3a29', '#6b4f2a', '#8a7a5c'];
const SKIN = ['#f1c27d', '#e8c39e', '#eac086', '#d9a066', '#f3d2b3'];

/** Shirt hue of a project: its sessions all wear this hue, in different shades. */
export const projectHue = (projectId: string) => (hashOf(projectId) * 47) % 360;

/**
 * A session's look. The shirt hue comes from the project, so sessions of one project read as a
 * group, while the shade and the rest come from the session id so no two look identical.
 */
export function sessionSprite(projectId: string, sessionId: string) {
  const sh = hashOf(sessionId);
  return {
    hair: HAIR[sh % HAIR.length],
    shirt: hsl(projectHue(projectId), 45 + (sh % 3) * 12, 42 + (sh % 4) * 7),
    pants: ['#2f3440', '#3a3a3a', '#2a2a3a', '#3d3326'][sh % 4],
    skin: SKIN[(sh >> 3) % SKIN.length],
  };
}

/** Tools a project session gets without asking. Everything else goes through auto mode / approval. */
const PROJECT_AUTO_ALLOW = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'mcp__lab__list_servers', 'mcp__lab__gpu_status', 'mcp__lab__job_status', 'mcp__lab__tail_log'];

const prompt = (name: string, dir: string) => `You help the manager in the "${name}" project folder (${dir}).
This folder is your workspace. Read the existing code and docs before changing anything.
- Separate facts from guesses, and mark anything you could not verify as "unverified".
- End your final reply with a short list of the files you changed and the next steps.
- Calls that reach a lab server (submitting/cancelling remote jobs, ssh/scp) bring up an approval card for the manager. That is expected.
- Connections to lab servers (ssh/scp/rsync) are rate-limited per minute. Don't connect in a loop; batch commands into one connection.
- Avoid moving files. This session runs on that server, so read them in place.
  If you must move them, don't scp them one by one: bundle them with tar and send once (individual transfers have gotten the lab's IP banned before).
- Don't read large files whole; look at just the parts you need with head/grep. Big output goes over the network as-is.`;

/**
 * Projects are folders on a host; each can hold several independent Claude Code sessions.
 * A session is just an employee created at runtime, so approvals, logs and the report feed
 * all work on it unchanged.
 */
export class ProjectRegistry {
  constructor(
    private store: Store,
    private agents: AgentManager,
    private hosts: HostRegistry,
    /** teamPrompt(): the field, shared rules and server etiquette every session starts with */
    private team = '',
  ) {}

  /** Role for one session. Throws if its host is gone or not reachable yet. */
  private roleFor(projectId: string, sessionId: string, label: string, desk: number): RoleConfig {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(tr({ ko: `없는 프로젝트: ${projectId}`, en: `No such project: ${projectId}` }));
    const host = this.hosts.get(p.hostId);
    if (!host) throw new Error(tr({ ko: `설정에 없는 host: ${p.hostId}`, en: `Host not in config: ${p.hostId}` }));
    const cwd = host.projectDir(p.dir);
    return {
      id: sessionId,
      name: `${p.name} · ${label}`,
      title: `${host.view.name} ${p.dir}`,
      desk,
      sprite: sessionSprite(projectId, sessionId),
      useWorktree: false,
      autoAllow: [...PROJECT_AUTO_ALLOW],
      systemPrompt: [this.team, prompt(p.name, cwd)].filter(Boolean).join('\n\n'),
      cwd,
      host: p.hostId,
      kind: 'project',
    };
  }

  /** sessions whose host is not in the config any more: warned about once, not on every pass */
  private warned = new Set<string>();

  /**
   * Bring back the workers of the open sessions whose host is ready (its home folder is known), and
   * tell the browsers when any came back. Safe to call again: sessions that already have a worker are
   * skipped. It runs at startup and each time a host turns reachable, so a session on a server that
   * answers late shows up when it does instead of staying lost until the next restart.
   */
  restore(): number {
    let added = 0;
    for (const s of this.store.listProjectSessions()) {
      if (this.agents.has(s.id)) continue;
      const p = this.store.getProject(s.projectId);
      const host = p ? this.hosts.get(p.hostId) : undefined;
      if (host && !host.view.ok) continue; // its turn comes when the host answers
      try {
        this.agents.addWorker(this.roleFor(s.projectId, s.id, s.label, s.desk));
        added++;
      } catch (e) {
        if (this.warned.has(s.id)) continue;
        this.warned.add(s.id);
        console.warn(
          tr({
            ko: `⚠️ 프로젝트 세션 ${s.id} 복구 실패: ${(e as Error).message}`,
            en: `⚠️ Failed to restore project session ${s.id}: ${(e as Error).message}`,
          }),
        );
      }
    }
    if (added) this.send();
    return added;
  }

  /** Is this an open session that has no worker yet (its host has not answered)? */
  isWaiting(id: string): boolean {
    return !this.agents.has(id) && this.store.listProjectSessions().some((s) => s.id === id);
  }

  /** What a session looks like before its host has answered: there, but not startable yet. */
  private waitingView(p: { id: string; hostId: string; name: string; dir: string }, s: { id: string; label: string }): EmployeeView {
    return {
      id: s.id,
      engine: 'claude',
      turnEngine: null,
      name: `${p.name} · ${s.label}`,
      title: p.dir,
      desk: -1, // not drawn in the office until it is really there
      sprite: sessionSprite(p.id, s.id),
      status: 'idle',
      activity: tr({ ko: '⏳ 서버 연결을 기다리는 중', en: '⏳ Waiting for the server' }),
      taskId: null,
      sessionId: null,
      cwd: '',
      costUsd: 0,
      permission: 'auto',
      live: false,
      hostId: p.hostId,
      kind: 'project',
    };
  }

  views(): ProjectView[] {
    const byId = new Map(this.agents.views().map((v) => [v.id, v]));
    return this.store.listProjects().map((p) => ({
      id: p.id,
      hostId: p.hostId,
      name: p.name,
      dir: p.dir,
      // a session whose worker is not back yet is still listed, so it never looks as if it had vanished
      sessions: this.store.listProjectSessions(p.id).map((s) => byId.get(s.id) ?? this.waitingView(p, s)),
    }));
  }

  send() {
    bus.send({ t: 'projects', data: this.views() });
  }

  /** Create a project and open its first session. The folder must already exist on the host. */
  async create(hostId: string, name: string, dir: string, label?: string) {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(tr({ ko: `설정에 없는 host: ${hostId}`, en: `Host not in config: ${hostId}` }));
    if (!host.view.ok) throw new Error(tr({ ko: `${host.view.name} 에 연결할 수 없습니다: ${host.view.error ?? ''}`, en: `Cannot reach ${host.view.name}: ${host.view.error ?? ''}` }));
    const clean = dir.trim().replace(/\/+$/, '');
    if (!clean || clean.includes('..')) throw new Error(tr({ ko: '폴더 경로가 올바르지 않습니다', en: 'Invalid folder path' }));
    if (!(await host.dirExists(host.projectDir(clean)))) throw new Error(tr({ ko: `${host.view.name} 에 ${clean} 폴더가 없습니다`, en: `${host.view.name} has no folder ${clean}` }));
    const p = this.store.createProject(hostId, name.trim() || clean, clean);
    this.addSession(p.id, label);
    return p;
  }

  addSession(projectId: string, label?: string) {
    const s = this.store.addProjectSession(projectId, label);
    this.agents.addWorker(this.roleFor(projectId, s.id, s.label, s.desk));
    this.send();
    return s;
  }

  /** Give a session a desk in the office, or send it back to the projects tab. */
  setInOffice(id: string, inOffice: boolean) {
    const desk = this.store.setSessionDesk(id, inOffice, this.staffDesks());
    this.agents.updateWorker(id, { desk });
    this.send();
  }

  /** Desk slots the configured staff hold (employees with a fixed seat don't take one). */
  private staffDesks(): number[] {
    return this.agents.views().filter((v) => v.kind !== 'project' && !v.seat).map((v) => v.desk);
  }

  closeSession(id: string) {
    this.agents.removeWorker(id);
    this.store.closeProjectSession(id);
    this.send();
  }

  archive(id: string) {
    for (const s of this.store.listProjectSessions(id)) this.agents.removeWorker(s.id);
    this.store.archiveProject(id);
    this.send();
  }
}
