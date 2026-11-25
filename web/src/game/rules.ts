// The office's little rules, as plain functions: time of day, daily counters, plants, throwing a ball of paper,
// how tired the manager is, which line comes next, and where speech bubbles go. No DOM, no storage, no clock:
// the caller passes those in, so all of this runs (and is tested) under Node.

export type DayPhase = 'day' | 'dusk' | 'night';
/** overtime starts at six: dusk until eight, then night until six in the morning */
export const dayPhaseOf = (hour: number): DayPhase => (hour >= 6 && hour < 18 ? 'day' : hour >= 18 && hour < 20 ? 'dusk' : 'night');

/** local calendar days since the epoch: two moments on the same local date give the same number */
export const dayNumber = (d = new Date()): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);

// ---- a counter that starts again every day, stored as `{ day, n }` ----
/** today's count from the stored text (missing, broken or another day's = 0) */
export const dayCountOf = (raw: string | null, today: number): number => {
  try {
    const c = JSON.parse(raw ?? 'null');
    return c && c.day === today && typeof c.n === 'number' ? c.n : 0;
  } catch {
    return 0;
  }
};
/** the text to store after counting one more today */
export const bumpedDayCount = (raw: string | null, today: number): { n: number; raw: string } => {
  const n = dayCountOf(raw, today) + 1;
  return { n, raw: JSON.stringify({ day: today, n }) };
};

// ---- the plants ----
export type PlantStage = 'wilt' | 'normal' | 'lush' | 'flower';
export interface PlantRecord {
  /** day number it was last watered */
  last: number;
  /** days in a row */
  streak: number;
}
export const parsePlant = (raw: string | null): PlantRecord | null => {
  try {
    const p = JSON.parse(raw ?? 'null');
    return p && typeof p.last === 'number' && typeof p.streak === 'number' ? p : null;
  } catch {
    return null;
  }
};
/** watered daily it grows (3 days: lush, 7: in flower); skip a day and the streak is gone; over 3 days dry it wilts */
export const plantStageOf = (p: PlantRecord | null, today: number): PlantStage => {
  if (!p) return 'normal';
  const dry = today - p.last;
  if (dry > 3) return 'wilt';
  const streak = dry <= 1 ? p.streak : 0;
  return streak >= 7 ? 'flower' : streak >= 3 ? 'lush' : 'normal';
};
/** the record after watering today, or null if it was already watered today (once a day counts) */
export const wateredPlant = (p: PlantRecord | null, today: number): PlantRecord | null =>
  p?.last === today ? null : { last: today, streak: p && today - p.last === 1 ? p.streak + 1 : 1 };

// ---- throwing a ball of paper ----
/** how far a full-power throw goes, in canvas pixels */
export const MAX_THROW = 330;
/**
 * While aiming, the distance sweeps out along the aim line and back at this many canvas pixels per frame
 * (~90 px/s), as far as a little past the pointer. A fixed speed keeps the release window the same (about a
 * quarter of a second on the bin) whether the target is near or far; sweeping the whole range left only ~50 ms.
 */
export const MARKER_SPEED = 1.5;
export const OVERSHOOT = 1.25;
/** how far the sweep goes before turning back, given the distance from the hand to the pointer */
export const reachOf = (handToPointer: number): number => Math.max(40, Math.min(MAX_THROW, handToPointer * OVERSHOOT));
/** distance the ball would go if released `frames` after the sweep began: out to `reach` and back, at a steady speed */
export const throwDistAt = (frames: number, reach: number): number => {
  const d = (frames * MARKER_SPEED) % (reach * 2);
  return d < reach ? d : reach * 2 - d;
};
export interface Point {
  x: number;
  y: number;
}
/** where a throw of `dist` from `hand` towards `aim` comes down, kept inside the room */
export const landingPoint = (hand: Point, aim: Point, dist: number, room: { w: number; h: number }): Point & { dist: number } => {
  let dx = aim.x - hand.x, dy = aim.y - hand.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) (dx = 1), (dy = 0);
  else (dx /= len), (dy /= len);
  const d = Math.max(8, dist);
  return { x: Math.max(4, Math.min(room.w - 4, hand.x + dx * d)), y: Math.max(4, Math.min(room.h - 4, hand.y + dy * d)), dist: d };
};
/**
 * A thrown ball of paper, roughly as it really flies: a flat toss (about 20–25° up), so the peak is about a
 * ninth of the distance, and a longer throw stays in the air longer.
 */
export const arcOf = (dist: number): number => dist * 0.11;
export const flightFrames = (dist: number): number => Math.round(14 + dist / 8);

// ---- the manager ----
/** 0 fresh, 1 yawning, 2 nodding off: from the minutes put in today, worse in the evening; coffee takes one off */
export const tiredStage = (workedMinutes: number, evening: boolean, coffee: boolean): number => {
  const base = workedMinutes >= 360 || (evening && workedMinutes >= 180) ? 2 : workedMinutes >= 180 ? 1 : 0;
  return Math.max(0, base - (coffee ? 1 : 0));
};

/** a random line from the pool, but not the one said last (unless it is the only one) */
export const pickNew = (pool: string[], last: string, rnd: () => number = Math.random): string => {
  const fresh = pool.filter((x) => x !== last);
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rnd() * from.length)];
};

// ---- speech bubbles ----
export interface BubbleIn {
  /** where the speaker's head is: the bubble wants its bottom edge here, its tail on `headX` */
  headX: number;
  headY: number;
  /** 0..1: which part of the bubble's width sits on `headX` (0.5 = centred) */
  anchor: number;
  /** frame its text appeared: of two at the same height the newer one stays by its speaker */
  since: number;
  /** its size where it is, and its size once moved away from its speaker (it then shows a name, so it is taller) */
  size: { w: number; h: number };
  stackedSize: { w: number; h: number };
}
export interface BubbleOut {
  left: number;
  /** the bottom edge */
  bottom: number;
  /** moved up to clear another bubble: no tail, the speaker's name on top */
  stacked: boolean;
}
/**
 * Place speech bubbles so that none overlap. They are settled from the bottom of the screen up, at the same
 * height the newer one first; one that would overlap a settled bubble moves up above it. So two people talking
 * read top to bottom like a chat log. Results are in the order of `entries`.
 */
export const stackBubbles = (entries: BubbleIn[], canvasWidth: number, gap = 6): BubbleOut[] => {
  const out: BubbleOut[] = new Array(entries.length);
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const order = entries.map((_, i) => i).sort((p, q) => entries[q].headY - entries[p].headY || entries[q].since - entries[p].since);
  for (const i of order) {
    const e = entries[i];
    const fit = (s: { w: number; h: number }) => {
      const left = Math.max(4, Math.min(canvasWidth - s.w - 4, e.headX - s.w * e.anchor));
      return { left, right: left + s.w, h: s.h };
    };
    let box = fit(e.size);
    let bottom = e.headY;
    let stacked = false;
    const hits = () => placed.find((p) => box.left < p.right && box.right > p.left && bottom - box.h < p.bottom && bottom > p.top);
    for (let guard = 0, p = hits(); p && guard < 8; guard++, p = hits()) {
      if (!stacked) {
        stacked = true;
        box = fit(e.stackedSize);
      }
      bottom = p.top - gap;
    }
    bottom = Math.max(bottom, box.h + 2); // not off the top of the canvas
    out[i] = { left: box.left, bottom, stacked };
    placed.push({ left: box.left, right: box.right, top: bottom - box.h, bottom });
  }
  return out;
};
