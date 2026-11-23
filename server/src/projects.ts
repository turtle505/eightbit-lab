import type { ProjectView } from '../../shared/protocol.ts';
import type { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import { commonPrompt, type RoleConfig } from './config.ts';
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

const prompt = (name: string, dir: string) => `당신은 "${name}" 프로젝트 폴더(${dir})에서 매니저를 돕습니다.
이 폴더가 당신의 작업 공간입니다. 고치기 전에 기존 코드와 문서를 먼저 읽으세요.
- 사실과 추측을 구분하고, 확인하지 못한 것은 "미확인"이라고 쓰세요.
- 마지막 응답에 변경한 파일과 다음 단계를 짧게 남기세요.
- 랩 서버에 닿는 호출(원격 job 제출·취소, ssh/scp)은 매니저 승인 카드가 뜹니다. 정상입니다.
- 랩 서버 접속(ssh·scp·rsync)은 분당 횟수가 제한됩니다. 반복문으로 접속하지 말고 한 번의 접속에서 명령을 묶으세요.
- 파일은 되도록 옮기지 마세요. 이 세션이 그 서버 안에서 돌고 있으니 제자리에서 읽으면 됩니다.
  꼭 옮겨야 하면 하나씩 scp 하지 말고 tar 로 묶어 한 번에 보내세요 (개별 전송으로 연구실 IP 가 차단된 적이 있습니다).
- 대용량 파일을 통째로 읽지 말고 head/grep 으로 필요한 부분만 보세요. 큰 출력은 그대로 네트워크를 탑니다.`;

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
  ) {}

  /** Role for one session. Throws if its host is gone or not reachable yet. */
  private roleFor(projectId: string, sessionId: string, label: string, desk: number): RoleConfig {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`없는 프로젝트: ${projectId}`);
    const host = this.hosts.get(p.hostId);
    if (!host) throw new Error(`설정에 없는 host: ${p.hostId}`);
    const cwd = host.projectDir(p.dir);
    return {
      id: sessionId,
      name: `${p.name} · ${label}`,
      title: `${host.view.name} ${p.dir}`,
      desk,
      sprite: sessionSprite(projectId, sessionId),
      useWorktree: false,
      autoAllow: [...PROJECT_AUTO_ALLOW],
      systemPrompt: [commonPrompt(), prompt(p.name, cwd)].filter(Boolean).join('\n\n'),
      cwd,
      host: p.hostId,
      kind: 'project',
    };
  }

  /** Re-create the workers for every open session (called once at startup). */
  restore() {
    for (const s of this.store.listProjectSessions()) {
      try {
        this.agents.addWorker(this.roleFor(s.projectId, s.id, s.label, s.desk));
      } catch (e) {
        console.warn(`⚠️ 프로젝트 세션 ${s.id} 복구 실패: ${(e as Error).message}`);
      }
    }
  }

  views(): ProjectView[] {
    const byId = new Map(this.agents.views().map((v) => [v.id, v]));
    return this.store.listProjects().map((p) => ({
      id: p.id,
      hostId: p.hostId,
      name: p.name,
      dir: p.dir,
      sessions: this.store
        .listProjectSessions(p.id)
        .map((s) => byId.get(s.id))
        .filter((v): v is NonNullable<typeof v> => !!v),
    }));
  }

  send() {
    bus.send({ t: 'projects', data: this.views() });
  }

  /** Create a project and open its first session. The folder must already exist on the host. */
  async create(hostId: string, name: string, dir: string, label?: string) {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`설정에 없는 host: ${hostId}`);
    if (!host.view.ok) throw new Error(`${host.view.name} 에 연결할 수 없습니다: ${host.view.error ?? ''}`);
    const clean = dir.trim().replace(/\/+$/, '');
    if (!clean || clean.includes('..')) throw new Error('폴더 경로가 올바르지 않습니다');
    if (!(await host.dirExists(host.projectDir(clean)))) throw new Error(`${host.view.name} 에 ${clean} 폴더가 없습니다`);
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
