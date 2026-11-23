import type { RoutineView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import type { RoutineConfig } from './config.ts';
import { type Cron, cronMatches, nextRun, parseCron } from './cron.ts';
import type { RoutineRow, Store } from './db.ts';

interface Entry {
  row: RoutineRow;
  cron: Cron;
}

export interface RoutineInput {
  name: string;
  schedule: string;
  employee: string;
  prompt?: string;
  skill?: string | null;
  enabled?: boolean;
}

/**
 * Fires routines (cron, local time) by sending their prompt to an employee.
 * Definitions live in the DB; config/routines*.yaml only seeds ids that were never stored
 * (a routine deleted in the UI stays deleted even if it is still in the YAML).
 */
export class RoutineScheduler {
  private entries: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    seed: RoutineConfig[],
    private store: Store,
    private fire: (employeeId: string, prompt: string, routineName: string, skill: string | null) => void,
    private isEmployee: (id: string) => boolean,
    private hasSkill: (name: string) => boolean = () => false,
  ) {
    for (const cfg of seed) {
      const legacy = store.getRoutineState(cfg.id).enabled; // toggle saved before routines moved to the DB
      store.seedRoutine({
        id: cfg.id,
        name: cfg.name,
        schedule: cfg.schedule,
        employee: cfg.employee,
        prompt: cfg.prompt ?? '',
        skill: cfg.skill || null,
        enabled: legacy ?? cfg.enabled !== false,
      });
    }
    for (const row of store.listRoutines()) {
      try {
        this.entries.push(this.entry(row));
      } catch (e) {
        console.warn(`[routines] skip ${row.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Validates and parses; throws a Korean message for the UI / secretary. */
  private entry(row: RoutineRow): Entry {
    if (!row.name.trim()) throw new Error('루틴 이름이 비어 있습니다.');
    if (row.skill) {
      if (!this.hasSkill(row.skill)) throw new Error(`없는 스킬입니다: "${row.skill}" (먼저 save_skill로 만드세요)`);
    } else if (!row.prompt.trim()) throw new Error('루틴 지시 내용(prompt)이 비어 있습니다. 스킬을 지정하거나 지시문을 쓰세요.');
    if (!this.isEmployee(row.employee)) throw new Error(`없는 직원입니다: "${row.employee}"`);
    let cron: Cron;
    try {
      cron = parseCron(row.schedule);
    } catch (e) {
      throw new Error(`일정(cron) 형식이 잘못되었습니다: ${(e as Error).message}`);
    }
    return { row, cron };
  }

  view(e: Entry, now = new Date()): RoutineView {
    const { row } = e;
    return {
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      employee: row.employee,
      prompt: row.prompt,
      skill: row.skill,
      enabled: row.enabled,
      lastRun: this.store.getRoutineState(row.id).lastRun,
      nextRun: row.enabled ? (nextRun(e.cron, now)?.getTime() ?? null) : null,
    };
  }

  list(): RoutineView[] {
    return this.entries.map((e) => this.view(e));
  }

  private find(id: string): Entry {
    const e = this.entries.find((x) => x.row.id === id);
    if (!e) throw new Error(`루틴 ${id}을(를) 찾을 수 없습니다.`);
    return e;
  }

  private newId(): string {
    let id = `r-${Date.now().toString(36)}`;
    for (let i = 2; this.entries.some((e) => e.row.id === id); i++) id = `r-${Date.now().toString(36)}-${i}`;
    return id;
  }

  create(input: RoutineInput): RoutineView {
    const draft: RoutineRow = {
      id: this.newId(),
      name: input.name.trim(),
      schedule: input.schedule.trim(),
      employee: input.employee,
      prompt: input.prompt ?? '',
      skill: input.skill || null,
      enabled: input.enabled !== false,
      createdAt: 0,
      updatedAt: 0,
    };
    const { cron } = this.entry(draft);
    const e = { row: this.store.upsertRoutine(draft), cron };
    this.entries.push(e);
    const v = this.view(e);
    bus.send({ t: 'routine', data: v });
    return v;
  }

  update(id: string, patch: Partial<RoutineInput>): RoutineView {
    const e = this.find(id);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<RoutineInput>;
    const draft: RoutineRow = { ...e.row, ...clean, skill: clean.skill === undefined ? e.row.skill : clean.skill || null, prompt: clean.prompt ?? e.row.prompt };
    draft.name = draft.name.trim();
    draft.schedule = draft.schedule.trim();
    const { cron } = this.entry(draft);
    e.row = this.store.upsertRoutine(draft);
    e.cron = cron;
    const v = this.view(e);
    bus.send({ t: 'routine', data: v });
    return v;
  }

  remove(id: string): RoutineView {
    const e = this.find(id);
    const v = this.view(e);
    this.store.softDeleteRoutine(id);
    this.entries = this.entries.filter((x) => x !== e);
    bus.send({ t: 'routineDeleted', id });
    return v;
  }

  run(id: string, now = new Date()) {
    const e = this.find(id);
    this.store.setRoutineState(id, { lastRun: now.getTime() });
    this.fire(e.row.employee, routinePrompt(e.row, now), e.row.name, e.row.skill);
    bus.send({ t: 'routine', data: this.view(e, now) });
  }

  setEnabled(id: string, enabled: boolean) {
    const e = this.find(id);
    this.store.setRoutineEnabled(id, enabled);
    e.row = { ...e.row, enabled };
    bus.send({ t: 'routine', data: this.view(e) });
  }

  /** Check once; fires each enabled routine at most once per matching minute. */
  tick(now = new Date()) {
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    for (const e of [...this.entries]) {
      const v = this.view(e, now);
      if (!v.enabled || !cronMatches(e.cron, now)) continue;
      if (v.lastRun != null && v.lastRun >= minuteStart.getTime()) continue;
      this.run(e.row.id, now);
    }
  }

  start() {
    this.timer = setInterval(() => this.tick(), 20_000);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/** The instruction an employee receives when a routine fires. */
export function routinePrompt(row: Pick<RoutineRow, 'name' | 'prompt' | 'skill'>, now: Date): string {
  const stamp = now.toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' });
  const head = `[루틴: ${row.name} · ${stamp}]`;
  if (!row.skill) return `${head}\n${row.prompt}`;
  const notes = row.prompt.trim() ? `\n\n추가 메모: ${row.prompt.trim()}` : '';
  return (
    `${head}\nSkill 도구로 \`office:${row.skill}\` 스킬을 실행하세요. ` +
    `예약(무인) 실행이므로 질문하지 말고 스킬 지침대로 진행한 뒤 결과만 짧게 보고하세요. ` +
    `실패하면 추측해서 채우지 말고 무엇이 왜 실패했는지 보고하세요.${notes}`
  );
}
