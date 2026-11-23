import type { ProjectView } from '../../shared/protocol.ts';
import type { AgentManager } from './agents/manager.ts';
import { bus } from './bus.ts';
import type { RoleConfig } from './config.ts';
import type { Store } from './db.ts';
import type { HostRegistry } from './hosts.ts';

/** Tools a project session gets without asking. Everything else goes through auto mode / approval. */
const PROJECT_AUTO_ALLOW = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'mcp__lab__list_servers', 'mcp__lab__gpu_status', 'mcp__lab__job_status', 'mcp__lab__tail_log'];

const prompt = (name: string, dir: string) => `당신은 "${name}" 프로젝트 폴더(${dir})에서 매니저를 돕습니다.
이 폴더가 당신의 작업 공간입니다. 고치기 전에 기존 코드와 문서를 먼저 읽으세요.
- 사실과 추측을 구분하고, 확인하지 못한 것은 "미확인"이라고 쓰세요.
- 마지막 응답에 변경한 파일과 다음 단계를 짧게 남기세요.
- 랩 서버에 닿는 호출(원격 job 제출·취소, ssh/scp)은 매니저 승인 카드가 뜹니다. 정상입니다.`;

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
  private roleFor(projectId: string, sessionId: string, label: string): RoleConfig {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`없는 프로젝트: ${projectId}`);
    const host = this.hosts.get(p.hostId);
    if (!host) throw new Error(`설정에 없는 host: ${p.hostId}`);
    const cwd = host.projectDir(p.dir);
    return {
      id: sessionId,
      name: `${p.name} · ${label}`,
      title: `${host.view.name} ${p.dir}`,
      desk: -1,
      sprite: { hair: '#3b3b3b', shirt: '#6a7f9c', pants: '#2f3440', skin: '#e8c39e' },
      useWorktree: false,
      autoAllow: [...PROJECT_AUTO_ALLOW],
      systemPrompt: prompt(p.name, cwd),
      cwd,
      host: p.hostId,
      kind: 'project',
    };
  }

  /** Re-create the workers for every open session (called once at startup). */
  restore() {
    for (const s of this.store.listProjectSessions()) {
      try {
        this.agents.addWorker(this.roleFor(s.projectId, s.id, s.label));
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
  async create(hostId: string, name: string, dir: string) {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`설정에 없는 host: ${hostId}`);
    if (!host.view.ok) throw new Error(`${host.view.name} 에 연결할 수 없습니다: ${host.view.error ?? ''}`);
    const clean = dir.trim().replace(/\/+$/, '');
    if (!clean || clean.includes('..')) throw new Error('폴더 경로가 올바르지 않습니다');
    if (!(await host.dirExists(host.projectDir(clean)))) throw new Error(`${host.view.name} 에 ${clean} 폴더가 없습니다`);
    const p = this.store.createProject(hostId, name.trim() || clean, clean);
    this.addSession(p.id);
    return p;
  }

  addSession(projectId: string) {
    const s = this.store.addProjectSession(projectId);
    this.agents.addWorker(this.roleFor(projectId, s.id, s.label));
    this.send();
    return s;
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
