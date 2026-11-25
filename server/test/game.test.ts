// The office game's rules and lines (web/src/game/rules.ts, lines.ts): pure functions, no browser needed.
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../shared/i18n.ts';
import type { EmployeeView } from '../../shared/protocol.ts';
import * as lines from '../../web/src/game/lines.ts';
import {
  MAX_THROW, arcOf, bumpedDayCount, dayCountOf, dayNumber, dayPhaseOf, flightFrames, landingPoint, parsePlant, pickNew, plantStageOf, reachOf, stackBubbles,
  throwDistAt, tiredStage, wateredPlant,
} from '../../web/src/game/rules.ts';

describe('game rules: time of day', () => {
  it('overtime starts at six in the evening and ends at six in the morning', () => {
    expect(dayPhaseOf(5)).toBe('night');
    expect(dayPhaseOf(6)).toBe('day');
    expect(dayPhaseOf(17)).toBe('day');
    expect(dayPhaseOf(18)).toBe('dusk');
    expect(dayPhaseOf(19)).toBe('dusk');
    expect(dayPhaseOf(20)).toBe('night');
    expect(dayPhaseOf(0)).toBe('night');
  });

  it('two moments on the same local date share a day number, the next date is one more', () => {
    const morning = dayNumber(new Date(2026, 10, 26, 0, 5));
    expect(dayNumber(new Date(2026, 10, 26, 23, 55))).toBe(morning);
    expect(dayNumber(new Date(2026, 10, 27, 0, 0))).toBe(morning + 1);
  });
});

describe('game rules: a counter that starts again every day', () => {
  it('adds up within a day and starts from zero on the next', () => {
    let raw: string | null = null;
    for (const want of [1, 2, 3]) {
      const next = bumpedDayCount(raw, 100);
      expect(next.n).toBe(want);
      raw = next.raw;
    }
    expect(dayCountOf(raw, 100)).toBe(3);
    expect(dayCountOf(raw, 101)).toBe(0);
    expect(bumpedDayCount(raw, 101).n).toBe(1);
  });

  it('treats a missing or broken value as zero', () => {
    expect(dayCountOf(null, 100)).toBe(0);
    expect(dayCountOf('not json', 100)).toBe(0);
    expect(dayCountOf('{"day":100}', 100)).toBe(0);
    expect(dayCountOf('{"day":100,"n":"7"}', 100)).toBe(0);
  });
});

describe('game rules: the plants', () => {
  const water = (days: number[]) => days.reduce<ReturnType<typeof wateredPlant>>((p, d) => wateredPlant(p, d) ?? p, null);

  it('grows with a daily streak: lush after three days, in flower after seven', () => {
    expect(plantStageOf(null, 10)).toBe('normal');
    expect(plantStageOf(water([1, 2]), 2)).toBe('normal');
    expect(plantStageOf(water([1, 2, 3]), 3)).toBe('lush');
    expect(plantStageOf(water([1, 2, 3, 4, 5, 6]), 6)).toBe('lush');
    expect(plantStageOf(water([1, 2, 3, 4, 5, 6, 7]), 7)).toBe('flower');
  });

  it('still shows yesterday\'s streak today, loses it after a skipped day, and wilts after more than three dry days', () => {
    const p = water([1, 2, 3, 4, 5, 6, 7]);
    expect(plantStageOf(p, 8)).toBe('flower'); // not watered yet today
    expect(plantStageOf(p, 9)).toBe('normal'); // a day was skipped
    expect(plantStageOf(p, 10)).toBe('normal');
    expect(plantStageOf(p, 11)).toBe('wilt'); // four days dry
    expect(wateredPlant(p, 9)).toEqual({ last: 9, streak: 1 }); // watering again starts over
  });

  it('counts one watering a day', () => {
    const p = water([1, 2, 3]);
    expect(wateredPlant(p, 3)).toBeNull();
    expect(water([1, 1, 1, 2, 2, 3])).toEqual({ last: 3, streak: 3 });
  });

  it('reads only a well-formed record', () => {
    expect(parsePlant('{"last":3,"streak":2}')).toEqual({ last: 3, streak: 2 });
    expect(parsePlant(null)).toBeNull();
    expect(parsePlant('{"last":"3"}')).toBeNull();
    expect(parsePlant('garbage')).toBeNull();
  });
});

describe('game rules: throwing a ball of paper', () => {
  it('the sweep goes a little past the pointer, never very short and never past the longest throw', () => {
    expect(reachOf(100)).toBe(125);
    expect(reachOf(5)).toBe(40);
    expect(reachOf(1000)).toBe(MAX_THROW);
  });

  it('the distance goes out to the reach and comes back, over and over', () => {
    const reach = 120;
    const out = 120 / 1.5; // frames to get there
    expect(throwDistAt(0, reach)).toBe(0);
    expect(throwDistAt(out / 2, reach)).toBeCloseTo(60);
    expect(throwDistAt(out, reach)).toBeCloseTo(120);
    expect(throwDistAt(out * 1.5, reach)).toBeCloseTo(60);
    expect(throwDistAt(out * 2, reach)).toBeCloseTo(0);
    expect(throwDistAt(out * 2.5, reach)).toBeCloseTo(60);
    for (let f = 0; f < 600; f++) {
      const d = throwDistAt(f, reach);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(reach);
    }
  });

  it('lands along the line from the hand to the pointer, and inside the room', () => {
    const room = { w: 400, h: 256 };
    const hand = { x: 158, y: 206 };
    expect(landingPoint(hand, { x: 258, y: 206 }, 50, room)).toMatchObject({ x: 208, y: 206 });
    const up = landingPoint(hand, { x: 158, y: 106 }, 80, room);
    expect(up.x).toBeCloseTo(158);
    expect(up.y).toBeCloseTo(126);
    // thrown hard at a corner, it stops at the wall
    const far = landingPoint(hand, { x: 400, y: 0 }, 330, room);
    expect(far.x).toBeLessThanOrEqual(396);
    expect(far.y).toBeGreaterThanOrEqual(4);
    // no direction to speak of (pointer on the hand): it goes right, and at least a little way
    expect(landingPoint(hand, hand, 0, room)).toMatchObject({ x: 166, y: 206, dist: 8 });
  });

  it('a longer throw arcs higher and stays in the air longer', () => {
    expect(arcOf(200)).toBeCloseTo(22);
    expect(arcOf(100)).toBeLessThan(arcOf(200));
    expect(flightFrames(80)).toBe(24);
    expect(flightFrames(80)).toBeLessThan(flightFrames(240));
  });
});

describe('game rules: how tired the manager is', () => {
  it('follows the time put in, is worse in the evening, and a coffee takes one stage off', () => {
    const table: [number, boolean, boolean, number][] = [
      [0, false, false, 0],
      [179, false, false, 0],
      [180, false, false, 1],
      [359, false, false, 1],
      [360, false, false, 2],
      [179, true, false, 0],
      [180, true, false, 2],
      [180, false, true, 0],
      [360, false, true, 1],
      [0, true, true, 0],
    ];
    for (const [minutes, evening, coffee, want] of table) expect(tiredStage(minutes, evening, coffee), `${minutes} min, evening ${evening}, coffee ${coffee}`).toBe(want);
  });
});

describe('game rules: which line comes next', () => {
  it('never repeats the last one while there is another', () => {
    const pool = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(pickNew(pool, 'b', () => i / 50)).not.toBe('b');
    expect(pickNew(pool, 'b', () => 0)).toBe('a');
    expect(pickNew(pool, 'b', () => 0.99)).toBe('c');
  });

  it('gives the only line there is, even if it was the last one', () => {
    expect(pickNew(['only'], 'only')).toBe('only');
    expect(pickNew(['x'], '')).toBe('x');
  });
});

describe('game rules: speech bubbles do not overlap', () => {
  const bubble = (headX: number, headY: number, since: number, w = 200, h = 30) => ({ headX, headY, anchor: 0.5, since, size: { w, h }, stackedSize: { w, h: h + 12 } });
  const overlap = (a: { left: number; bottom: number }, ah: number, b: { left: number; bottom: number }, bh: number, w = 200) =>
    a.left < b.left + w && a.left + w > b.left && a.bottom - ah < b.bottom && a.bottom > b.bottom - bh;

  it('leaves bubbles that are apart where they are', () => {
    const [a, b] = stackBubbles([bubble(150, 300, 1), bubble(550, 300, 2)], 700);
    expect(a).toEqual({ left: 50, bottom: 300, stacked: false });
    expect(b).toEqual({ left: 450, bottom: 300, stacked: false });
  });

  it('of two at the same height the newer stays by its speaker and the older moves up, like a chat log', () => {
    const [older, newer] = stackBubbles([bubble(80, 400, 1), bubble(130, 400, 2)], 700);
    expect(newer).toMatchObject({ bottom: 400, stacked: false });
    expect(older.stacked).toBe(true);
    expect(older.bottom).toBe(400 - 30 - 6); // above the newer one, with the gap
    expect(overlap(older, 42, newer, 30)).toBe(false);
  });

  it('stacks three in order, the lowest on screen settled first', () => {
    const out = stackBubbles([bubble(100, 400, 1), bubble(110, 400, 2), bubble(120, 350, 3)], 700);
    // settled from the bottom: #2 (newer of the two low ones), then #1 above it, then #3 above that
    expect(out[1]).toMatchObject({ bottom: 400, stacked: false });
    expect(out[0]).toMatchObject({ bottom: 364, stacked: true });
    expect(out[2].stacked).toBe(true);
    expect(out[2].bottom).toBeLessThan(out[0].bottom - 42);
    expect(overlap(out[2], 42, out[0], 42)).toBe(false);
  });

  it('keeps a bubble inside the canvas: clamped at the sides, and never off the top', () => {
    const [left] = stackBubbles([bubble(20, 300, 1)], 700);
    expect(left.left).toBe(4);
    const [right] = stackBubbles([bubble(690, 300, 1)], 700);
    expect(right.left).toBe(700 - 200 - 4);
    const tall = stackBubbles([bubble(100, 20, 1), bubble(100, 20, 2)], 700);
    for (const o of tall) expect(o.bottom).toBeGreaterThanOrEqual(32);
  });
});

describe('game lines', () => {
  afterEach(() => setLang('en'));
  const who = (id: string, seat?: EmployeeView['seat']) => ({ id, seat }) as EmployeeView;
  const ctx = { angry: false, night: false, plants: ['normal', 'normal'], cups: 0 };
  const nonEmpty = (list: string[]) => list.length > 0 && list.every((l) => typeof l === 'string' && l.trim().length > 0);

  it('every pool has lines in both languages', () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      const pools: string[][] = [
        lines.angryLines(),
        lines.posterLines(false),
        lines.posterLines(true),
        lines.bookTitles(),
        lines.kangReturnLines(),
        lines.banterPairs(false).flat(),
        ...(['thug', 'counsel'] as const).flatMap((w) => [lines.coffeeLines(w), lines.sleepLines(w)]),
        ...(['prof', 'thug', 'counsel'] as const).flatMap((w) => [lines.paperLines(w), lines.slamLines(w)]),
        lines.caughtLines('prof', false),
        lines.caughtLines('prof', true),
        lines.caughtLines('thug', false),
        ...['lit', 'eval', 'aide1', 'aide2', 'sec', 'exec', 'someone-else'].map((id) => lines.staffQuips(id)),
        [1, 2, 3, 4, 5, 6, 7].map((n) => lines.onNote(n)),
        [10, 50, 100].map((n) => lines.bagMilestone(n) ?? ''),
      ];
      for (const pool of pools) expect(nonEmpty(pool), `${lang}: ${JSON.stringify(pool).slice(0, 60)}`).toBe(true);
    }
  });

  it('greetings change with who it is, the hour, the plants, the coffee and the professor\'s temper', () => {
    setLang('en');
    const kangDay = lines.greetings(who('thug', 'corner'), ctx);
    const kangNight = lines.greetings(who('thug', 'corner'), { ...ctx, night: true });
    expect(nonEmpty(kangDay) && nonEmpty(kangNight)).toBe(true);
    expect(kangNight).not.toEqual(kangDay);
    expect(lines.greetings(who('counsel', 'corner'), ctx)).not.toEqual(kangDay);
    // a wilted plant, or two thriving ones, give Kang one more line; in between, nothing extra
    expect(lines.greetings(who('thug', 'corner'), { ...ctx, plants: ['wilt', 'normal'] })).toHaveLength(kangDay.length + 1);
    expect(lines.greetings(who('thug', 'corner'), { ...ctx, plants: ['lush', 'flower'] })).toHaveLength(kangDay.length + 1);
    expect(lines.greetings(who('thug', 'corner'), { ...ctx, plants: ['lush', 'normal'] })).toHaveLength(kangDay.length);
    expect(lines.greetings(who('counsel', 'corner'), { ...ctx, plants: ['wilt', 'wilt'] })).toHaveLength(lines.greetings(who('counsel', 'corner'), ctx).length);
    // from the fifth cup both of them mention it
    expect(lines.greetings(who('thug', 'corner'), { ...ctx, cups: 4 })).toHaveLength(kangDay.length);
    expect(lines.greetings(who('thug', 'corner'), { ...ctx, cups: 5 })).toHaveLength(kangDay.length + 1);
    // the professor has his own lines, and only angry ones while angry
    const prof = lines.greetings(who('prof', 'podium'), ctx);
    expect(lines.greetings(who('prof', 'podium'), { ...ctx, angry: true })).toEqual(lines.angryLines());
    expect(prof).not.toEqual(lines.angryLines());
    // an unknown chat character still says something
    expect(nonEmpty(lines.greetings(who('new-one', 'corner'), ctx))).toBe(true);
  });

  it('there is one more exchange between Kang and On in the evening', () => {
    expect(lines.banterPairs(true)).toHaveLength(lines.banterPairs(false).length + 1);
  });

  it('On\'s notes count the hits of the day, then cycle', () => {
    setLang('en');
    expect(new Set([1, 2, 3].map((n) => lines.onNote(n))).size).toBe(3);
    expect(lines.onNote(4)).not.toBe(lines.onNote(5));
    expect(lines.onNote(4)).toBe(lines.onNote(8));
  });

  it('a thought fits what is going on, and there is always something to think', () => {
    setLang('en');
    const quiet = { night: false, approvals: 0, justDone: false, working: 1, tired: false };
    expect(nonEmpty(lines.mutterLines(quiet))).toBe(true); // nothing in particular: the fallback
    const base = lines.mutterLines(quiet);
    expect(lines.mutterLines({ ...quiet, night: true })).not.toEqual(base);
    expect(lines.mutterLines({ ...quiet, approvals: 3 })).not.toEqual(base);
    expect(lines.mutterLines({ ...quiet, approvals: 2 })).toEqual(base);
    expect(lines.mutterLines({ ...quiet, working: 0 })).not.toEqual(base);
    expect(lines.mutterLines({ ...quiet, night: true, tired: true }).length).toBeGreaterThan(lines.mutterLines({ ...quiet, night: true }).length);
  });

  it('the bag only has something to say at 10, 50 and 100 hits', () => {
    expect([1, 9, 11, 49, 99, 101].map((n) => lines.bagMilestone(n))).toEqual([null, null, null, null, null, null]);
  });
});
