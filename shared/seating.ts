// Where project sessions sit in the office. They do not get a desk of their own: each project has one
// shared table in the strip right of the desk grid, and its sessions sit along it. The room has space
// for two such tables of four, so it never has to grow with the number of sessions.
// Shared by the server (which refuses a session there is no seat for) and the scene (which draws them).

export const TABLES = 2;
export const SEATS_PER_TABLE = 4;

/** The project a session belongs to, from its id `p:<projectId>:<n>`; null for anything else. */
export const projectOfSession = (id: string): string | null => {
  const m = /^p:(.+):\d+$/.exec(id);
  return m ? m[1] : null;
};

export interface Seated {
  id: string;
  /** the number handed out when the session was brought in (lower = earlier); < 0 = not in the office */
  desk: number;
}

export interface TablePlan {
  /** project id per table, in table order */
  tables: string[];
  /** session id → which table and which seat along it */
  seats: Map<string, { table: number; seat: number }>;
}

/**
 * Who sits where: projects take tables in the order their first session came in, and a project's
 * sessions sit along its table in the order they came in. A session leaving closes the gap.
 */
export function tablePlan(sessions: Seated[]): TablePlan {
  const inOffice = sessions.filter((s) => s.desk >= 0 && projectOfSession(s.id)).sort((a, b) => a.desk - b.desk || a.id.localeCompare(b.id));
  const tables: string[] = [];
  const seats = new Map<string, { table: number; seat: number }>();
  const taken = new Map<string, number>();
  for (const s of inOffice) {
    const project = projectOfSession(s.id)!;
    if (!tables.includes(project)) tables.push(project);
    const seat = taken.get(project) ?? 0;
    taken.set(project, seat + 1);
    seats.set(s.id, { table: tables.indexOf(project), seat });
  }
  return { tables, seats };
}

/** Is there a seat for this session? 'tables': every table belongs to another project; 'seats': its project's table is full. */
export function canSeat(sessions: Seated[], id: string): { ok: true } | { ok: false; why: 'tables' | 'seats' } {
  const project = projectOfSession(id);
  if (!project) return { ok: true };
  const others = sessions.filter((s) => s.id !== id);
  const plan = tablePlan(others);
  const table = plan.tables.indexOf(project);
  if (table < 0) return plan.tables.length < TABLES ? { ok: true } : { ok: false, why: 'tables' };
  const used = [...plan.seats.values()].filter((v) => v.table === table).length;
  return used < SEATS_PER_TABLE ? { ok: true } : { ok: false, why: 'seats' };
}
