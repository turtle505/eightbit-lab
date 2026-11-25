// Procedurally drawn pixel sprites (original art, no external assets).
// Palette keys: H hair, S skin, E eye, T shirt, P pants, B shoes, W white, K dark, . transparent

export interface Palette {
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
  /** a hairstyle and a prop on top of the shared body (see LOOKS); omitted = the plain figure */
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

/**
 * Looks: a head (8 rows, same layout as HEAD) and a few pixels painted over the body in every pose.
 * Extra keys: G round glasses frame, K dark (square glasses, headset), C a look's accent colour, W white, Z zip.
 */
const LOOKS: Record<string, { head: string[]; extra: [number, number, string][]; accent?: string }> = {
  // long hair to the shoulders, round glasses, a book under the arm
  scholar: {
    head: ['....HHHH....', '...HHHHHH...', '..HHHHHHHH..', '..HHSSSSHH..', '..HGEGGEGH..', '..HSSSSSSH..', '..HHSSSSHH..', '..H.SSSS.H..'],
    extra: [[2, 8, 'H'], [9, 8, 'H'], [0, 10, 'C'], [1, 10, 'C'], [0, 11, 'C'], [1, 11, 'W'], [0, 12, 'C'], [1, 12, 'C']],
    accent: '#8e2430',
  },
  // neat side parting, square glasses, a pen in the shirt pocket
  analyst: {
    head: ['....HHHH....', '...HHHHHHH..', '..HHHHHHHH..', '..HHHSSSSH..', '..SKEKKEKS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'],
    extra: [[7, 9, 'C'], [7, 10, 'W']],
    accent: '#4f81bd',
  },
  // messy hair with a cowlick, a hoodie (hood at the neck, two strings)
  rookie: {
    head: ['.....H.H....', '...HHHHHH...', '..HHHHHHHHH.', '..HHSSSSSH..', '..SSESSESS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'],
    extra: [[2, 8, 'C'], [9, 8, 'C'], [4, 9, 'W'], [4, 10, 'W'], [7, 9, 'W'], [7, 10, 'W']],
    accent: 'rgba(0,0,0,0.25)',
  },
  // high ponytail, sleeves rolled up, a wristwatch
  runner: {
    head: ['....HHHH.HH.', '...HHHHHHHH.', '..HHHHHHHH.H', '..HSSSSSSH.H', '..SSESSESS..', '..SSSSSSSS..', '...SSSSSS...', '....SSSS....'],
    extra: [[1, 9, 'S'], [10, 9, 'S'], [1, 11, 'K']],
  },
  // bob cut, a headset with a mic, a scarf
  assistant: {
    head: ['....HHHH....', '...HHHHHH...', '..HHHHHHHH..', '.HHSSSSSSHH.', '.KHSESSESHH.', '.KHSSSSSSHH.', '..KSSSSSSH..', '...KSSSS....'],
    extra: [[4, 8, 'C'], [5, 8, 'C'], [6, 8, 'C'], [7, 8, 'C'], [7, 9, 'C'], [7, 10, 'C']],
    accent: '#e05a6a',
  },
  // short hair, a beard, a zip-up hoodie
  engineer: {
    head: ['............', '...HHHHHH...', '..HHHHHHHH..', '..HSSSSSSH..', '..SSESSESS..', '..HSSSSSSH..', '...HHSSHH...', '....HHHH....'],
    extra: [[2, 8, 'C'], [9, 8, 'C'], [6, 8, 'Z'], [6, 9, 'Z'], [6, 10, 'Z'], [6, 11, 'Z'], [6, 12, 'Z']],
    accent: 'rgba(0,0,0,0.25)',
  },
};
export const LOOK_NAMES = Object.keys(LOOKS);

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
  const look = p.look ? LOOKS[p.look] : undefined;
  const key = `${p.hair}${p.shirt}${p.pants}${p.skin}${p.look ?? ''}${pose}${blink}`;
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
    G: '#8a6a45',
    Z: '#d8dee9',
    C: look?.accent ?? '#1b1b1b',
  };
  const all = rows(pose);
  (look ? [...look.head, ...all.slice(HEAD.length)] : all).forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = color[ch];
      g.fillRect(x, y, 1, 1);
    }),
  );
  for (const [x, y, ch] of look?.extra ?? []) {
    g.fillStyle = color[ch];
    g.fillRect(x, y, 1, 1);
  }
  cache.set(key, c);
  return c;
}

// ---- Kang, the street punk: bleached spikes, shades, a lollipop stick, a striped tracksuit, hands in pockets ----
// Keys: H hair, h shaved sides, S skin, K shades, W white (glint, stripes, stick, trainers), Y gold chain, T jacket, P trousers
const KANG_HEAD = [
  '...H..H..H..',
  '..HH.HH.HH..',
  '..HHHHHHHH..',
  '..HHHHHHHH..',
  '..hHHHHHHh..',
  '..hSSSSSSh..',
  '..SKWKKKKS..',
  '..SSSSSSSS..',
];
const KANG_JAW = { right: ['...SSSSSSW..', '....SSSS....'], left: ['..WSSSSSS...', '....SSSS....'] };
const KANG_BODY = ['..TTYYTTTT..', '.WTTTTTTTTW.', '.WTTTTTTTTW.', '.TTTTTTTTTT.', '..TTTTTTTT..'];
const KANG_BODY_UP = ['..TTYYTTTTW.', '.WTTTTTTTTW.', '.WTTTTTTTT..', '.TTTTTTTTT..', '..TTTTTTTT..'];
const KANG_LEGS = ['..PPPPPPPP..', '..WPP..PPW..', '..WPP..PPW..', '..WWW..WWW..'];
const KANG_LEGS_SHAKE = ['..PPPPPPPP..', '..WPP..PPW..', '..WPP...PPW.', '..WWW...WWW.'];
const KANG_SQUAT = ['.WTTYYTTTTW.', 'PPTTTTTTTTPP', 'WWPPPPPPPPWW'];
export type KangPose = 'stand' | 'shake' | 'handUp' | 'squat';
export const KANG_H = KANG_HEAD.length + 2 + KANG_BODY.length + KANG_LEGS.length;

export function kangSprite(p: Palette, pose: KangPose, stickLeft = false): HTMLCanvasElement {
  const key = `kang${p.hair}${p.shirt}${p.pants}${p.skin}${pose}${stickLeft}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const jaw = [...KANG_JAW[stickLeft ? 'left' : 'right']];
  if (pose === 'handUp') jaw[1] = '....SSSS..S.'; // the raised hand, above the shoulder
  const rows =
    pose === 'squat'
      ? [...KANG_HEAD, ...jaw, ...KANG_SQUAT]
      : [...KANG_HEAD, ...jaw, ...(pose === 'handUp' ? KANG_BODY_UP : KANG_BODY), ...(pose === 'shake' ? KANG_LEGS_SHAKE : KANG_LEGS)];
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = rows.length;
  paintMap(c.getContext('2d')!, rows, { H: p.hair, h: '#5a4a2a', S: p.skin, K: '#141418', W: '#f4f4f4', Y: '#e8c55a', T: p.shirt, P: p.pants }, 0, 0);
  cache.set(key, c);
  return c;
}

// ---- On, the counselor: a bun, round glasses, a cardigan over a white blouse, a long skirt, a mug of tea ----
// Keys: H hair, S skin, E eye, G glasses, T cardigan, W blouse, M mug, C clipboard, c paper, P skirt, B shoes
const ON_HEAD = [
  '.....HH.....',
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HHHSSSSH..',
  '..SGEGGEGS..',
  '..SSSSSSSS..',
  '...SSSSSS...',
  '....SSSS....',
];
const ON_BODY = ['..TTTWWTTT..', '.TTTTWWTTTT.', '.TTTSMMSTTT.', '.TTTTMMTTTT.', '..TTTWWTTT..'];
const ON_SKIRT = ['..PPPPPPPP..', '..PPPPPPPP..', '.PPPPPPPPPP.', '...BB..BB...'];
export type OnPose = 'stand' | 'sip' | 'nod' | 'writeA' | 'writeB' | 'handUp';
export const ON_H = ON_HEAD.length + ON_BODY.length + ON_SKIRT.length;

export function onSprite(p: Palette, pose: OnPose, blink = false): HTMLCanvasElement {
  const key = `on${p.hair}${p.shirt}${p.pants}${p.skin}${pose}${blink}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let head = [...ON_HEAD];
  let body = ON_BODY;
  if (pose === 'sip') {
    // the mug at her lips, both hands under it
    head[7] = '...SSMMSS...';
    head[8] = '....SMMS....';
    body = ['..TTTSSTTT..', '.TTTTWWTTTT.', '.TTTTWWTTTT.', '.TTTTWWTTTT.', '..TTTWWTTT..'];
  } else if (pose === 'nod') head = ['............', ...ON_HEAD.slice(0, 8)]; // the head a pixel lower, the neck hidden
  else if (pose === 'writeA' || pose === 'writeB')
    body = ['..TTTWWTTT..', '.TTTTWWTTTT.', pose === 'writeA' ? '.TSCcccCSTT.' : '.TSCcccCTST.', '.TTCcccCTTT.', '..TTCCCTTT..'];
  else if (pose === 'handUp') {
    head[8] = '....SSSS..S.';
    body = ['..TTTWWTTTT.', '.TTTTWWTTTT.', '.STTTWWTTT..', '.STTTWWTTT..', '..TTTWWTTT..'];
  }
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = ON_H;
  paintMap(
    c.getContext('2d')!,
    [...head, ...body, ...ON_SKIRT],
    { H: p.hair, S: p.skin, E: blink ? p.skin : '#1b1b1b', G: '#b98d5a', T: p.shirt, W: '#fbfbf7', M: '#fbfbf7', C: '#8a5a3b', c: '#fbfbf7', P: p.pants, B: '#3a2a22' },
    0,
    0,
  );
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
