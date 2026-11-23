// Minimal 5-field cron: "minute hour day-of-month month day-of-week" in local time.
// Supports *, numbers, lists (1,3), ranges (1-5), steps (*/15, 0-30/10). Day-of-week 0 or 7 = Sunday.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${spec}"`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number) as [number, number];
    else {
      lo = Number(range);
      hi = stepStr ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`bad field "${spec}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const dow = field(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: field(f[0], 0, 59),
    hour: field(f[1], 0, 23),
    dom: field(f[2], 1, 31),
    month: field(f[3], 1, 12),
    dow,
    domAny: f[2] === '*',
    dowAny: f[4] === '*',
  };
}

export function cronMatches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // classic cron: if both restricted, either may match
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** Next matching minute strictly after `from` (searches up to ~1 year). */
export function nextRun(c: Cron, from: Date): Date | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
