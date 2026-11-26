import type { EmployeeView, HostView, ProjectView } from '../../../shared/protocol.ts';

// Pure helpers for "who can be talked to" and "what sits under which server". No DOM, so they are unit-tested.

const chat = (e: { seat?: string }) => (e.seat === 'corner' || e.seat === 'podium' ? 1 : 0);
export const isProjectSession = (e: { kind?: string }): boolean => e.kind === 'project';

/** The staff, in desk order with the chat characters last. Project sessions are not staff. */
export function staffOf<T extends { kind?: string; seat?: string; desk: number }>(employees: T[]): T[] {
  return employees.filter((e) => !isProjectSession(e)).sort((a, b) => chat(a) - chat(b) || a.desk - b.desk);
}

/**
 * Who the command bar can instruct: the staff, then the project sessions that were given a desk in the
 * office (they stand there as characters, so clicking one has to work like clicking anyone else). A session
 * that is selected without a desk is included too, so a selection can never be something the bar cannot send to.
 */
export function commandTargets<T extends { id: string; kind?: string; seat?: string; desk: number }>(employees: T[], selected: string | null): T[] {
  const sessions = employees.filter((e) => isProjectSession(e) && (e.desk >= 0 || e.id === selected)).sort((a, b) => (a.desk < 0 ? 1 : 0) - (b.desk < 0 ? 1 : 0) || a.desk - b.desk);
  return [...staffOf(employees), ...sessions];
}

export interface HostGroup {
  /** null: projects whose host is no longer in the config */
  host: HostView | null;
  projects: ProjectView[];
}

/** The projects tab's layout: every host in config order with its projects (a host without any still gets its row). */
export function groupByHost(hosts: HostView[], projects: ProjectView[]): HostGroup[] {
  const groups: HostGroup[] = hosts.map((host) => ({ host, projects: projects.filter((p) => p.hostId === host.id) }));
  const orphans = projects.filter((p) => !hosts.some((h) => h.id === p.hostId));
  if (orphans.length) groups.push({ host: null, projects: orphans });
  return groups;
}

/** sshd's default MaxSessions: how many things one connection carries at once. Shown next to a host's session count. */
export const HOST_CHANNELS = 10;
