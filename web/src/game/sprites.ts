// Procedurally drawn pixel sprites (original art, no external assets).
// Palette keys: H hair, S skin, E eye, T shirt, P pants, B shoes, W white, K dark, . transparent

export interface Palette {
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
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

export type Pose = 'stand' | 'walkA' | 'walkB' | 'typeA' | 'typeB' | 'handUp' | 'cup';

export const SPRITE_W = 12;
export const SPRITE_H = 17;

function rows(pose: Pose): string[] {
  const body =
    pose === 'handUp' ? BODY_HAND_UP : pose === 'typeA' ? BODY_TYPE_A : pose === 'typeB' ? BODY_TYPE_B : pose === 'cup' ? BODY_CUP : BODY_STAND;
  const legs = pose === 'walkA' ? LEGS_WALK_A : pose === 'walkB' ? LEGS_WALK_B : LEGS_STAND;
  return [...HEAD, ...body, ...legs];
}

const cache = new Map<string, HTMLCanvasElement>();

export function characterSprite(p: Palette, pose: Pose, blink = false): HTMLCanvasElement {
  const key = `${p.hair}${p.shirt}${p.pants}${p.skin}${pose}${blink}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = SPRITE_H;
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
  };
  rows(pose).forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = color[ch];
      g.fillRect(x, y, 1, 1);
    }),
  );
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
export const PLANT_COLORS = { G: '#4f8a3b', g: '#6fae4f', B: '#8a5a3b' };

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
