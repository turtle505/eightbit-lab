import type { RoutineView } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import type { RoutineConfig } from './config.ts';
import { type Cron, cronMatches, nextRun, parseCron } from './cron.ts';
import type { Store } from './db.ts';

interface Entry {
  cfg: RoutineConfig;
  cron: Cron;
}

/** Fires configured routines (cron, local time) by sending their prompt to an employee. */
export class RoutineScheduler {
  private entries: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    configs: RoutineConfig[],
    private store: Store,
    private fire: (employeeId: string, prompt: string, routineName: string) => void,
    isEmployee: (id: string) => boolean,
  ) {
    for (const cfg of configs) {
      try {
        if (!isEmployee(cfg.employee)) throw new Error(`unknown employee "${cfg.employee}"`);
        this.entries.push({ cfg, cron: parseCron(cfg.schedule) });
      } catch (e) {
        console.warn(`[routines] skip ${cfg.id}: ${(e as Error).message}`);
      }
    }
  }

  view(e: Entry, now = new Date()): RoutineView {
    const st = this.store.getRoutineState(e.cfg.id);
    const enabled = st.enabled ?? e.cfg.enabled !== false;
    return {
      id: e.cfg.id,
      name: e.cfg.name,
      schedule: e.cfg.schedule,
      employee: e.cfg.employee,
      enabled,
      lastRun: st.lastRun,
      nextRun: enabled ? (nextRun(e.cron, now)?.getTime() ?? null) : null,
    };
  }

  list(): RoutineView[] {
    return this.entries.map((e) => this.view(e));
  }

  private find(id: string): Entry {
    const e = this.entries.find((x) => x.cfg.id === id);
    if (!e) throw new Error(`routine ${id} 없음`);
    return e;
  }

  run(id: string, now = new Date()) {
    const e = this.find(id);
    this.store.setRoutineState(id, { lastRun: now.getTime() });
    const stamp = now.toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' });
    this.fire(e.cfg.employee, `[루틴: ${e.cfg.name} · ${stamp}]\n${e.cfg.prompt}`, e.cfg.name);
    bus.send({ t: 'routine', data: this.view(e, now) });
  }

  setEnabled(id: string, enabled: boolean) {
    const e = this.find(id);
    this.store.setRoutineState(id, { enabled });
    bus.send({ t: 'routine', data: this.view(e) });
  }

  /** Check once; fires each enabled routine at most once per matching minute. */
  tick(now = new Date()) {
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    for (const e of this.entries) {
      const v = this.view(e, now);
      if (!v.enabled || !cronMatches(e.cron, now)) continue;
      if (v.lastRun != null && v.lastRun >= minuteStart.getTime()) continue;
      this.run(e.cfg.id, now);
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
