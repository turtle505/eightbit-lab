// Procedurally drawn pixel sprites (original art, no external assets).
// Palette keys: H hair, S skin, E eye, T shirt, P pants, B shoes, W white, K dark, . transparent

export interface Palette {
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
  /** one big thing that tells a character apart: a hairstyle or a hat (see LOOKS); omitted = the plain head */
  look?: string;
}

const HEAD = [
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HSSSSSSH..',
  '..SSESSESS..',
  '..SSSSSSSS..',
  '...SSSSSS...',
  '....SSSS....',
];

const BODY_STAND = [
  '..TTTTTTTT..',
  '.TTTTTTTTTT.',
  '.STTTTTTTTS.',
  '.STTTTTTTTS.',
  '..TTTTTTTT..',
];
const BODY_HAND_UP = [
  '..TTTTTTTTS.',
  '.TTTTTTTTTS.',
  '.STTTTTTTTT.',
  '.STTTTTTTT..',
  '..TTTTTTTT..',
];
const BODY_TYPE_A = [
  '..TTTTTTTT..',
  '.TTTTTTTTTT.',
  'STTTTTTTTTTS',
  '.S.TTTTTT.S.',
  '..TTTTTTTT..',
];
const BODY_TYPE_B = [
  '..TTTTTTTT..',
  '.TTTTTTTTTT.',
  'STTTTTTTTTT.',
  '.S.TTTTTT..S',
  '..TTTTTTTT..',
];
const BODY_CUP = [
  '..TTTTTTTT..',
  '.TTTTTTTTTT.',
  '.STTTTTTTSWW',
  '.STTTTTTTTWW',
  '..TTTTTTTT..',
];

const LEGS_STAND = ['..PPPPPPPP..', '..PPP..PPP..', '..PPP..PPP..', '..BBB..BBB..'];
const LEGS_WALK_A = ['..PPPPPPPP..', '..PPP...PP..', '.PPP....PP..', '.BBB....BB..'];
const LEGS_WALK_B = ['..PPPPPPPP..', '..PP...PPP..', '..PP....PPP.', '..BB....BBB.'];

const LEGS_SHAKE = ['..PPPPPPPP..', '..PPP..PPP..', '..PPP...PPP.', '..BBB...BBB.'];
/** squatting: the body and legs fold into three rows */
const SQUAT = ['.STTTTTTTTS.', 'PPTTTTTTTTPP', 'BBPPPPPPPPBB'];

/**
 * Looks: a head to use instead of HEAD. Deliberately one large shape each (hair or a hat) and nothing small:
 * at this size glasses, beards and props turn to mush. Rows above the usual eight make the figure taller.
 * `C` is the hat colour (taken from the trousers or the shirt), `W` white; `extra` paints over the body.
 */
const LOOKS: Record<string, { head: string[]; hat?: 'pants' | 'shirt'; extra?: [number, number, string][] }> = {
  // three spikes standing straight up
  spikes: { head: ['...H..H..H..', '..HH.HH.HH..', '..HHHHHHHH..', '..HHHHHHHH..', '..HHHHHHHH..', '..HSSSSSSH..', '..SSESSESS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'] },
  // a round bun on top
  bun: { head: ['.....HH.....', '....HHHH....', ...HEAD] },
  // long hair framing the face and down to the shoulders
  long: {
    head: ['....HHHH....', '...HHHHHH...', '..HHHHHHHH..', '.HHSSSSSSHH.', '.HHSESSESHH.', '.HHSSSSSSHH.', '.HHHSSSSHHH.', '.HH.SSSS.HH.'],
    extra: [[1, 8, 'H'], [10, 8, 'H'], [1, 9, 'H'], [10, 9, 'H']],
  },
  // a flat cap with the brim out to one side
  cap: { head: ['....CCCC....', '...CCCCCC...', '..CCCCCCCCCC', '..HSSSSSSH..', '..SSESSESS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'], hat: 'pants' },
  // a beanie with a pom-pom
  beanie: { head: ['.....WW.....', '....CCCC....', '...CCCCCC...', '..CCCCCCCC..', '..CCCCCCCC..', '..SSESSESS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'], hat: 'shirt' },
  // a big ponytail sticking out behind
  ponytail: { head: ['....HHHH....', '...HHHHHH.HH', '..HHHHHHHHHH', '..HSSSSSSH.H', '..SSESSESS.H', '..SSSSSSSS.H', '...SSSSSS...', '....SSSS....'] },
  // a wide bob down to the jaw
  bob: { head: ['....HHHH....', '...HHHHHH...', '.HHHHHHHHHH.', '.HHSSSSSSHH.', '.HHSESSESHH.', '.HHSSSSSSHH.', '..HHSSSSHH..', '....SSSS....'] },
};
/** how tall a standing figure with this look is */
export const spriteHeight = (look?: string): number => ((look && LOOKS[look]?.head.length) || HEAD.length) + 9;

export type Pose = 'stand' | 'walkA' | 'walkB' | 'typeA' | 'typeB' | 'handUp' | 'cup' | 'shake' | 'squat';

export const SPRITE_W = 12;
export const SPRITE_H = 17;

function rows(pose: Pose, head: string[]): string[] {
  if (pose === 'squat') return [...head, ...SQUAT];
  const body =
    pose === 'handUp' ? BODY_HAND_UP : pose === 'typeA' ? BODY_TYPE_A : pose === 'typeB' ? BODY_TYPE_B : pose === 'cup' ? BODY_CUP : BODY_STAND;
  const legs = pose === 'walkA' ? LEGS_WALK_A : pose === 'walkB' ? LEGS_WALK_B : pose === 'shake' ? LEGS_SHAKE : LEGS_STAND;
  return [...head, ...body, ...legs];
}

const cache = new Map<string, HTMLCanvasElement>();

/**
 * `nod` lowers the head a pixel (the neck disappears into the collar). The canvas is as tall as the figure:
 * taller for a look that rises above the head, shorter when squatting — draw it from the feet up.
 */
export function characterSprite(p: Palette, pose: Pose, blink = false, nod = false): HTMLCanvasElement {
  const key = `${p.hair}${p.shirt}${p.pants}${p.skin}${p.look ?? ''}${pose}${blink}${nod}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const look = p.look ? LOOKS[p.look] : undefined;
  let head = look?.head ?? HEAD;
  if (nod) head = ['............', ...head.slice(0, -1)];
  const all = rows(pose, head);
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = all.length;
  const g = c.getContext('2d')!;
  const color: Record<string, string> = {
    H: p.hair,
    S: p.skin,
    E: blink ? p.skin : '#1b1b1b',
    T: p.shirt,
    P: p.pants,
    B: '#2a2018',
    W: '#f4f4f4',
    K: '#1b1b1b',
    C: look?.hat === 'shirt' ? p.shirt : p.pants,
  };
  all.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = color[ch];
      g.fillRect(x, y, 1, 1);
    }),
  );
  if (pose !== 'squat')
    for (const [x, y, ch] of look?.extra ?? []) {
      g.fillStyle = color[ch];
      g.fillRect(x, y + head.length - HEAD.length, 1, 1);
    }
  cache.set(key, c);
  return c;
}

// The professor (the `seat: 'podium'` employee). Messy black hair that flutters, dark-rimmed glasses,
// dark suit with white shirt and tie, hands clasped behind the back. 12x20, two hair frames.
const PROF_HAIR = [
  ['..H..H..H...', '..HHHHHHHHH.', '.HHhhHHHHHHH', 'HHHHHHHHHHH.'],
  ['...H..H..H..', '.HHHHHHHHH..', 'HHHhhHHHHHH.', '.HHHHHHHHHHH'],
];
const PROF_BODY = [
  '.HSSSSSSSSH.',
  '.SKKKSSKKKS.',
  '.SKLEKKELKS.',
  '.SKKKSSKKKS.',
  '.SSSSmmSSSS.',
  '..SSSSSSSS..',
  '....SSSS....',
  '..DdwRRwdD..',
  '.DDDdwRwdDD.',
  '.DDDDdRdDDD.',
  '.DDDDDRDDDD.',
  '..DDDDDDDD..',
  '..PPPPPPPP..',
  '..PPP..PPP..',
  '..PPP..PPP..',
  '..BBB..BBB..',
];
export const PROF_W = 12;
export const PROF_H = PROF_HAIR[0].length + PROF_BODY.length;

/** frame 0/1 = hair blown one way or the other */
export function professorSprite(blink = false, frame: 0 | 1 = 0, angry = false): HTMLCanvasElement {
  const key = `professor${blink}${frame}${angry}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = PROF_W;
  c.height = PROF_H;
  const skin = angry ? '#ee7b6a' : '#f0c9a0'; // red in the face
  paintMap(c.getContext('2d')!, [...PROF_HAIR[frame], ...PROF_BODY], {
    H: '#1f1f24', h: '#3a3a44', S: skin, K: '#4a4a52', E: blink && !angry ? '#cfe6f5' : '#1b1b1b', L: angry ? '#ffd0c8' : '#cfe6f5', m: angry ? '#4a1410' : '#8a5a4a',
    D: '#2c3440', d: '#46536a', w: '#fafafa', R: '#8e2430', P: '#262c36', B: '#151515',
  }, 0, 0);
  cache.set(key, c);
  return c;
}

// The manager (you): a showpiece. Same head as everyone (black hair),
// royal-purple velvet suit with gold lapels, crimson tie, pink pocket square, gold chain and belt buckle.
// 14x19. Cape and sparkles are drawn around it per frame in office.ts.
const MANAGER = [
  '.....HHHH.....',
  '....HHHHHH....',
  '...HHHHHHHH...',
  '...HSSSSSSH...',
  '...SSESSESS...',
  '...SSSSSSSS...',
  '....SSSSSS....',
  '.....SSSS.....',
  '....WWSSWW....',
  '..VVLWRRWLVV..',
  '.VVVVLWRWLVVV.',
  '.VVQVVLRLVVVV.',
  '.SVVVVCRCVVVS.',
  '.SVVVVVYVVVVS.',
  '..VVVVvvVVVV..',
  '..PPPPYYPPPP..',
  '..PPPP..PPPP..',
  '..PPP....PPP..',
  '..BBB....BBB..',
];
export const MANAGER_W = 14;
export const MANAGER_H = MANAGER.length;

export function managerSprite(blink = false): HTMLCanvasElement {
  const key = `manager${blink}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = MANAGER_W;
  c.height = MANAGER_H;
  const skin = '#f1c27d';
  paintMap(c.getContext('2d')!, MANAGER, {
    H: '#2e2e2e', S: skin, E: blink ? skin : '#1b1b1b',
    W: '#fafafa', V: '#5b2a86', v: '#46206a', L: '#e8c55a', R: '#c0283c', Q: '#ff7eb6', C: '#ffd966',
    P: '#2b2140', B: '#111111',
  }, 0, 0);
  cache.set(key, c);
  return c;
}

/** Tiny helper to paint an ascii pixel map at (x, y). */
export function paintMap(g: CanvasRenderingContext2D, map: string[], colors: Record<string, string>, x: number, y: number) {
  map.forEach((row, dy) =>
    [...row].forEach((ch, dx) => {
      const col = colors[ch];
      if (!col) return;
      g.fillStyle = col;
      g.fillRect(x + dx, y + dy, 1, 1);
    }),
  );
}

export const PLANT = ['..GG.G..', '.GGGGGG.', 'GGgGGgGG', '.GGGGGG.', '..GgGG..', '..BBBB..', '..BBBB..', '...BB...'];
export const PLANT_COLORS = { G: '#4f8a3b', g: '#6fae4f', B: '#8a5a3b', y: '#9a7b3c', F: '#ff8fb1', Y: '#ffe066' };
/** the office plants grow when watered (see OfficeScene plants): wilted, normal, lush, in flower */
export const PLANT_STAGES: Record<'wilt' | 'normal' | 'lush' | 'flower', string[]> = {
  wilt: ['........', '..y..y..', '.yy..yy.', '.y.yy.y.', '..yyyy..', '..BBBB..', '..BBBB..', '...BB...'],
  normal: PLANT,
  lush: ['...GG...', '.GGgGGG.', ...PLANT],
  flower: ['..F...F.', '.FYF.FYF', '..FGGGF.', '.GGgGGG.', ...PLANT],
};

export const COFFEE = [
  'KKKKKKKKKK',
  'KMMMMMMMMK',
  'KMRRMMGGMK',
  'KMMMMMMMMK',
  'KKKKKKKKKK',
  'KMMKKKKMMK',
  'KMMK..KMMK',
  'KMMKWWKMMK',
  'KMMKWWKMMK',
  'KMMMMMMMMK',
  'KKKKKKKKKK',
];
export const COFFEE_COLORS = { K: '#2b2b2b', M: '#7d7d86', R: '#e05050', G: '#50e070', W: '#f4f4f4' };
