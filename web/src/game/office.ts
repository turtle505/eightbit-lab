import { figureDefaultName, type FigureKey } from '../../../shared/protocol.ts';
import { tr } from '../../../shared/i18n.ts';
import type { AgentStatus, EmployeeView, Seat, ServerView, Task } from '../../../shared/protocol.ts';
import { COFFEE, COFFEE_COLORS, PLANT_COLORS, PLANT_STAGES, PROF_H, PROF_W, SPRITE_H, SPRITE_W, characterSprite, MANAGER_H, MANAGER_W, managerSprite, paintMap, professorSprite, type Pose } from './sprites.ts';

export const W = 400;
const WALL_H = 36;

// The office is a grid of desks that grows downward, with a fixed strip at the bottom for the
// manager and the two reserved seats. Height follows the number of grid rows in use.
const COLS = 3;
const COL_X = [24, 134, 244];
const GRID_TOP = 92;
const ROW_H = 72;
const MIN_ROWS = 2;
/**
 * Canvas height for a given number of grid rows. The bottom strip (manager desk, reception, lead)
 * needs room of its own below the last row, or the reception desk lands on top of it.
 */
const BOTTOM_H = 20;
export const heightFor = (rows: number) => GRID_TOP + Math.max(MIN_ROWS, rows) * ROW_H + BOTTOM_H;
/** rows needed to seat the highest grid slot in use */
export const rowsFor = (maxSlot: number) => Math.max(MIN_ROWS, Math.floor(Math.max(0, maxSlot) / COLS) + 1);
/** current canvas height; grows as desks are added (see OfficeScene.layout) */
export let H = heightFor(MIN_ROWS);
/**
 * Where the professor (the `seat: 'podium'` employee) stands: in the aisle between the last desk row and the
 * manager, right of the manager desk. Kept clear of the grid — he used to stand on the lead's desk.
 */
let PROF = { x: 346, y: 150 };
/** decorative figures (not employees): name-tag anchor and click box in canvas pixels */
/** `fromBottom` entries have y measured up from the canvas bottom, so they follow a growing office. */
const figAt = (f: { fromBottom?: boolean }, y: number) => (f.fromBottom ? H + y : y);
const askName = (k: FigureKey) => {
  const d = figureDefaultName(k);
  return tr({ ko: `이름 (비우면 "${d}")`, en: `Name (empty = "${d}")` });
};
const FIGURES: Record<FigureKey, { tag?: { x: number; y: number }; box: { x0: number; x1: number; y0: number; y1: number }; ask: () => string; fromBottom?: boolean }> = {
  manager: { tag: { x: 150, y: -13 }, box: { x0: 141, x1: 159, y0: -54, y1: -36 }, ask: () => askName('manager'), fromBottom: true },
  // whiteboard inner area (frame drawn in paintStatic); empty text → task-count stickies are shown instead
  board: { box: { x0: 104, x1: 216, y0: 4, y1: 32 }, ask: () =>
      tr({ ko: '칠판에 쓸 문구 (최대 60자, 비우면 작업 현황 스티커 표시)', en: 'Text for the whiteboard (up to 60 chars; empty shows the task stickies)' }),
  },
};

interface Spot {
  x: number;
  y: number;
}

/** A line of dialogue revealed a character at a time, like a game text box. */
interface Speech {
  chars: string[];
  shown: number;
  /** a canned greeting rather than a real reply: it goes away when the character is deselected */
  greet?: boolean;
}

interface Actor {
  id: string;
  x: number;
  y: number;
  walkPhase: number;
  view: EmployeeView;
  bubble: HTMLDivElement;
  tag: HTMLDivElement;
  /** corner (chat) characters only: their last reply */
  speech: Speech | null;
  /** corner characters: frame at which the manager last spoke to them and no reply has come yet */
  awaitingSince: number | null;
  /** last text written into the bubble, so the DOM is touched only on change */
  bubbleText: string;
  /** the greeting shown last time, so the next one differs */
  lastGreet: string;
}

/** Reserved seats sit in the bottom strip; every other desk is a slot in the grid. */
const seatPos = (seat: 'reception' | 'lead') => (seat === 'reception' ? { x: 206, y: H - 44 } : { x: 40, y: H - 36 });
/** corner characters stand (no desk) between the bottom-left plant and the manager's rug */
const cornerSpot = (i: number): Spot => ({ x: 44 + i * 32, y: H - 10 });
/** characters who stand at a fixed spot and talk in speech bubbles instead of working at a desk */
const isChat = (v: { seat?: Seat }) => v.seat === 'corner' || v.seat === 'podium';
const standSpot = (i: number, seat: Seat): Spot => (seat === 'podium' ? { x: PROF.x, y: PROF.y } : cornerSpot(i));
const deskPos = (i: number, seat?: Seat) =>
  seat === 'corner' || seat === 'podium' ? standSpot(i, seat) : seat ? seatPos(seat) : { x: COL_X[i % COLS], y: GRID_TOP + Math.floor(i / COLS) * ROW_H };
const seatSpot = (i: number, seat?: Seat): Spot =>
  seat === 'corner' || seat === 'podium' ? standSpot(i, seat) : { x: deskPos(i, seat).x + 30, y: deskPos(i, seat).y + 2 };
const besideSpot = (i: number, seat?: Seat): Spot =>
  seat === 'corner' || seat === 'podium' ? standSpot(i, seat) : { x: deskPos(i, seat).x + 60, y: deskPos(i, seat).y + 16 };
/** characters per frame for the typewriter effect (~30/s at 60 fps) */
const TYPE_SPEED = 0.5;
/** frames the manager's line stays up after the reply has finished typing */
const MANAGER_LINE_HOLD = 360;
const BUSY: AgentStatus[] = ['queued', 'thinking', 'typing', 'running', 'researching', 'remote'];
// ---- easter eggs: the time of day, and the two plants (all in the browser, no server state) ----
/** local time; `?hour=19` (optionally `&minute=30`) in the URL overrides it, for trying the evening look */
const clockNow = (): { h: number; m: number } => {
  const q = new URLSearchParams(location.search);
  const d = new Date();
  const h = q.has('hour') ? Number(q.get('hour')) : NaN;
  const m = q.has('minute') ? Number(q.get('minute')) : NaN;
  return { h: h >= 0 && h < 24 ? Math.floor(h) : d.getHours(), m: m >= 0 && m < 60 ? Math.floor(m) : q.has('hour') ? 0 : d.getMinutes() };
};
type DayPhase = 'day' | 'dusk' | 'night';
/** overtime starts at six: dusk until eight, then night until six in the morning */
const dayPhase = (): DayPhase => {
  const { h } = clockNow();
  return h >= 6 && h < 18 ? 'day' : h < 20 && h >= 18 ? 'dusk' : 'night';
};

type PlantSide = 'left' | 'right';
type PlantStage = keyof typeof PLANT_STAGES;
const PLANT_X: Record<PlantSide, number> = { left: 6, right: 372 };
const dayNumber = (d = new Date()) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
const readPlant = (side: PlantSide): { last: number; streak: number } | null => {
  try {
    const p = JSON.parse(localStorage.getItem(`office-plant-${side}`) ?? 'null');
    return p && typeof p.last === 'number' && typeof p.streak === 'number' ? p : null;
  } catch {
    return null;
  }
};
/** watered daily it grows (3 days: lush, 7: in flower); skip a day and the streak is gone; over 3 days dry it wilts */
const plantStage = (side: PlantSide): PlantStage => {
  const p = readPlant(side);
  if (!p) return 'normal';
  const dry = dayNumber() - p.last;
  if (dry > 3) return 'wilt';
  const streak = dry <= 1 ? p.streak : 0;
  return streak >= 7 ? 'flower' : streak >= 3 ? 'lush' : 'normal';
};
/** once a day counts; returns nothing, the caller re-reads the stage */
const waterPlant = (side: PlantSide) => {
  const today = dayNumber();
  const p = readPlant(side);
  if (p?.last === today) return;
  try {
    localStorage.setItem(`office-plant-${side}`, JSON.stringify({ last: today, streak: p && today - p.last === 1 ? p.streak + 1 : 1 }));
  } catch {
    /* storage unavailable: the plant just stays as it is */
  }
};

/** what the professor says while standing behind the manager (click him five times, quickly) */
const hoverLines = (): string[] => [
  tr({ ko: '신경 쓰지 말고 하던 거 하게.', en: "Don't mind me, carry on." }),
  tr({ ko: '그냥 보는 거야.', en: "I'm just watching." }),
  tr({ ko: '그 줄은 왜 그렇게 짰나?', en: 'Why did you write that line like that?' }),
  tr({ ko: '편하게 해, 편하게.', en: 'Relax. Relax.' }),
];

/** Kang notices the plants */
const plantJabs = (): string[] => {
  const st = [plantStage('left'), plantStage('right')];
  if (st.includes('wilt')) return [tr({ ko: '화분 꼴 좀 봐라, 니 연구 같다.', en: 'Look at that plant. Just like your research.' })];
  if (st.every((x) => x === 'lush' || x === 'flower'))
    return [tr({ ko: '화분은 존나 잘 키우네. 연구를 그렇게 좀 해 봐라.', en: 'You grow plants fucking well. Try doing research like that.' })];
  return [];
};

/** after six the chat characters have evening lines instead */
const nightGreetings = (v: EmployeeView): string[] | null =>
  v.seat === 'podium'
    ? [
        tr({ ko: '아직 있었나? 마침 잘됐네.', en: 'Still here? Good timing.' }),
        tr({ ko: '밤이 연구하기엔 제일 좋지.', en: 'Night is the best time for research.' }),
        tr({ ko: '나 때는 연구실에서 잤네.', en: 'In my day we slept in the lab.' }),
        tr({ ko: '내일 아침까지 볼 수 있지?', en: 'I can see it by tomorrow morning, right?' }),
      ]
    : v.id === 'thug'
      ? [
          tr({ ko: '이 시간까지 남아서 한 게 그거냐, 병신아?', en: "You stayed this late and that's all you did, you idiot?" }),
          tr({ ko: '집에 안 가냐? 갈 데도 없냐, 새끼야.', en: 'Not going home? Nowhere to go, dumbass?' }),
          tr({ ko: '야근한다고 일 잘하는 줄 아네, 씨발.', en: 'Thinks working late makes them good at it. Fuck.' }),
          tr({ ko: '낮에 처놀다가 이제 와서 바쁜 척하냐?', en: 'Screwed around all day and now you act busy?' }),
        ]
      : v.id === 'counsel'
        ? [
            tr({ ko: '늦게까지 계시네요. 저녁은 드셨어요?', en: "You're here late. Have you had dinner?" }),
            tr({ ko: '오늘은 여기까지만 해도 괜찮아요.', en: "It's all right to stop here for today." }),
            tr({ ko: '이 시간엔 생각이 더 무겁게 느껴지죠.', en: 'Thoughts feel heavier at this hour, don\'t they.' }),
            tr({ ko: '집에 가는 길에 숨 한번 크게 쉬세요.', en: 'Take one deep breath on your way home.' }),
          ]
        : null;

/** what a chat character says when you walk up to them (selected); one is picked at random each time */
const greetings = (v: EmployeeView): string[] => [
  ...((dayPhase() !== 'day' && nightGreetings(v)) || dayGreetings(v)),
  ...(v.id === 'thug' ? plantJabs() : []),
];
const dayGreetings = (v: EmployeeView): string[] =>
  v.seat === 'podium'
    ? [
        tr({ ko: '음, 그래서 결과는 나왔나?', en: 'So, any results yet?' }),
        tr({ ko: '마침 잘 왔네, 할 얘기가 있었는데.', en: 'Good timing, I had something to discuss.' }),
        tr({ ko: '지난주에 얘기한 건 어떻게 됐나?', en: 'How is the thing we talked about last week going?' }),
        tr({ ko: '오는 길에 재미있는 생각이 하나 났는데.', en: 'I had an interesting thought on the way in.' }),
        tr({ ko: '요즘 얼굴 보기 힘드네.', en: "I don't see you around much these days." }),
        tr({ ko: '그 실험, 금방 하지?', en: "That experiment won't take long, right?" }),
        tr({ ko: '주말에 잠깐 볼까?', en: "Let's talk briefly this weekend." }),
        tr({ ko: '논문은 언제쯤 볼 수 있나?', en: 'When can I see the paper?' }),
      ]
    : v.id === 'thug'
      ? [
          tr({ ko: '하… 한심한 새끼 또 왔네.', en: 'Ugh. The pathetic bastard is back.' }),
          tr({ ko: '뭘 봐 새끼야, 할 일 없냐?', en: 'What are you looking at, dumbass? Nothing to do?' }),
          tr({ ko: '또 징징대러 왔냐? 존나 지겹다 진짜.', en: "Here to whine again? I'm so fucking tired of you." }),
          tr({ ko: '니가 그러니까 졸업을 못 하는 거야, 병신아.', en: "This is exactly why you can't graduate, you idiot." }),
          tr({ ko: '논문 한 줄도 안 쓴 새끼가 여긴 왜 와.', en: 'Not one line of the paper written, and you show up here?' }),
          tr({ ko: '에휴, 그 대가리로 대학원은 어떻게 왔냐.', en: 'How the hell did you get into grad school with that brain?' }),
          tr({ ko: '변명 들어 줄 시간 없다, 꺼져.', en: 'No time for your excuses. Piss off.' }),
          tr({ ko: '오늘은 또 뭘 말아먹었냐, 씨발.', en: 'So what did you fuck up today?' }),
        ]
      : v.id === 'counsel'
        ? [
            tr({ ko: '오늘 하루 어땠어요?', en: 'How was your day?' }),
            tr({ ko: '어서 오세요. 오늘은 어떤 마음으로 오셨어요?', en: 'Welcome. What brings you here today?' }),
            tr({ ko: '요즘 잠은 좀 주무세요?', en: 'Have you been sleeping lately?' }),
            tr({ ko: '지난번 이후로 어떻게 지내셨어요?', en: 'How have you been since last time?' }),
            tr({ ko: '천천히 말씀하셔도 돼요.', en: 'Take your time.' }),
            tr({ ko: '오늘 가장 마음에 걸리는 게 뭐예요?', en: "What's weighing on you most today?" }),
            tr({ ko: '여기 앉아서 숨 한번 고르고 가세요.', en: 'Sit down and catch your breath for a moment.' }),
            tr({ ko: '밥은 챙겨 드셨어요?', en: 'Have you eaten?' }),
          ]
        : [tr({ ko: '무슨 일 있어?', en: "What's up?" })];
// lounge spots along the top wall, spaced so bubbles don't collide; it wraps to a second line
const coffeeSpot = (i: number): Spot => ({ x: 62 + (i % 7) * 46, y: 68 + Math.floor(i / 7) * 10 });

const MONITOR_GLOW: Partial<Record<AgentStatus, string>> = {
  typing: '#7fb2ff',
  running: '#6dff8e',
  researching: '#7ff0ff',
  thinking: '#c9c9ff',
};

const SEATED: AgentStatus[] = ['thinking', 'typing', 'running', 'researching'];
const BESIDE: AgentStatus[] = ['queued', 'waiting_permission', 'done', 'error'];

export class OfficeScene {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  scale = 3;
  actors = new Map<string, Actor>();
  servers: ServerView[] = [];
  tasks: Task[] = [];
  selected: string | null = null;
  onSelect: (id: string | null) => void = () => {};
  onDropTask: (taskId: number, employeeId: string) => void = () => {};
  onRenameFigure: (key: FigureKey, name: string) => void = () => {};
  private t = 0;
  /** true while the game view is hidden: skip drawing, keep state updates */
  paused = false;
  private floor: HTMLCanvasElement;
  /** grid rows currently drawn; grows as desks are handed out */
  private rows = MIN_ROWS;
  private figureTags = new Map<FigureKey, HTMLDivElement>();
  private boardText = '';
  /** the manager's line to a corner character, shown over the manager's head */
  private managerLine: { to: string; speech: Speech; hideAt: number | null } | null = null;
  private managerBubble: HTMLDivElement;
  private managerBubbleText = '';
  /** who was selected last frame, to notice a new selection (click, number key, command-bar picker) */
  private greetedSel: string | null = null;
  // easter eggs
  private phase: DayPhase = dayPhase();
  private plants: Record<PlantSide, PlantStage> = { left: plantStage('left'), right: plantStage('right') };
  /** a watering in progress: drops fall over that plant until this frame */
  private drip: { side: PlantSide; until: number } | null = null;
  /** recent clicks on the professor (ms); five within two seconds and he comes to stand behind the manager */
  private profClicks: number[] = [];
  private hoverUntil = 0;

  constructor(private host: HTMLElement, private overlay: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.className = 'office-canvas';
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.floor = this.paintStatic();
    for (const key of Object.keys(FIGURES) as FigureKey[]) {
      const tag = document.createElement('div');
      tag.className = FIGURES[key].tag ? `nametag figure-${key}` : `figure-${key}`;
      if (!FIGURES[key].tag) tag.hidden = true;
      tag.textContent = figureDefaultName(key);
      overlay.append(tag);
      this.figureTags.set(key, tag);
    }
    this.managerBubble = document.createElement('div');
    this.managerBubble.className = 'bubble speech manager-line';
    this.managerBubble.hidden = true;
    overlay.append(this.managerBubble);
    // defer to the next frame: resizing inside the observer callback re-triggers it ("ResizeObserver loop" warning)
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(host);
    this.resize();

    this.canvas.addEventListener('click', (ev) => {
      const plant = this.hitPlant(ev);
      if (plant) {
        waterPlant(plant);
        this.plants[plant] = plantStage(plant);
        this.drip = { side: plant, until: this.t + 45 };
        return;
      }
      const fig = this.hitFigure(ev);
      if (fig) {
        const name = prompt(FIGURES[fig].ask(), this.figureTags.get(fig)?.textContent ?? '');
        if (name !== null) this.onRenameFigure(fig, name);
        return;
      }
      const id = this.hit(ev);
      // clicking a character mid-line shows the rest at once, like skipping dialogue in a game
      const sp = id ? this.actors.get(id)?.speech : null;
      // clicking them again once the line is out gets another greeting
      if (id && id === this.selected && (!sp || sp.shown >= sp.chars.length)) this.greetedSel = null;
      if (sp) sp.shown = sp.chars.length;
      this.selected = id;
      this.onSelect(id);
      const hit = id ? this.actors.get(id) : null;
      if (hit?.view.seat === 'podium') this.pokeProfessor(hit);
    });
    this.canvas.addEventListener('dragover', (ev) => {
      if (this.hit(ev)) ev.preventDefault();
    });
    this.canvas.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const id = this.hit(ev);
      const taskId = Number(ev.dataTransfer?.getData('text/task-id'));
      if (id && taskId) this.onDropTask(taskId, id);
    });
    const loop = () => {
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const s = Math.min(r.width / W, (window.innerHeight * 0.62) / H);
    this.scale = s >= 1 ? Math.floor(s * 4) / 4 : s;
    this.canvas.style.width = `${W * this.scale}px`;
    this.canvas.style.height = `${H * this.scale}px`;
    this.overlay.style.width = this.canvas.style.width;
    this.overlay.style.height = this.canvas.style.height;
  }

  /** Five quick clicks and the professor comes over to watch the manager work for half a minute. */
  private pokeProfessor(a: Actor) {
    const now = performance.now();
    this.profClicks = [...this.profClicks.filter((c) => now - c < 2000), now];
    if (this.profClicks.length < 5) return;
    this.profClicks = [];
    this.hoverUntil = this.t + 1800;
    const lines = hoverLines();
    a.speech = { chars: Array.from(lines[Math.floor(Math.random() * lines.length)]), shown: 0 };
    a.awaitingSince = null;
  }

  private hitPlant(ev: MouseEvent): PlantSide | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const y = ((ev.clientY - r.top) / r.height) * H;
    for (const side of ['left', 'right'] as PlantSide[]) if (x >= PLANT_X[side] - 2 && x <= PLANT_X[side] + 10 && y >= H - 26 && y <= H - 10) return side;
    return null;
  }

  private hitFigure(ev: MouseEvent): FigureKey | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const y = ((ev.clientY - r.top) / r.height) * H;
    for (const [key, f] of Object.entries(FIGURES) as [FigureKey, (typeof FIGURES)[FigureKey]][])
      if (x >= f.box.x0 && x <= f.box.x1 && y >= figAt(f, f.box.y0) && y <= figAt(f, f.box.y1)) return key;
    return null;
  }

  setFigureNames(names: Partial<Record<FigureKey, string>>) {
    for (const [key, name] of Object.entries(names) as [FigureKey, string][]) {
      const tag = this.figureTags.get(key);
      if (!tag) continue;
      tag.textContent = name;
      if (key === 'board') {
        this.boardText = name;
        tag.hidden = !name;
      }
    }
  }

  private hit(ev: MouseEvent): string | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const y = ((ev.clientY - r.top) / r.height) * H;
    for (const a of this.actors.values()) {
      const h = a.view.seat === 'podium' ? PROF_H + 2 : SPRITE_H;
      if (x >= a.x - 9 && x <= a.x + 9 && y >= a.y - h - 3 && y <= a.y + 3) return a.id;
    }
    return null;
  }

  setEmployees(list: EmployeeView[]) {
    for (const v of list) this.upsert(v);
  }

  /**
   * Resize the room to the desks in use. The canvas, the bottom strip (manager, reserved seats)
   * and the static layer all follow the row count, so adding a session just makes the office taller.
   */
  private layout() {
    const maxSlot = Math.max(-1, ...[...this.actors.values()].filter((a) => !a.view.seat).map((a) => a.view.desk));
    const rows = rowsFor(maxSlot);
    if (rows === this.rows) return;
    this.rows = rows;
    H = heightFor(rows);
    PROF = { x: 346, y: H - 86 };
    this.canvas.height = H;
    this.floor = this.paintStatic();
    this.resize();
  }

  /** Take an actor out of the office (a project session closing, or a role removed). */
  remove(id: string) {
    const a = this.actors.get(id);
    if (!a) return;
    a.bubble.remove();
    a.tag.remove();
    this.actors.delete(id);
    this.layout();
  }

  upsert(v: EmployeeView) {
    if (v.desk < 0) return; // a session that has not been given a desk lives in the projects tab only
    let a = this.actors.get(v.id);
    if (!a) {
      const start = isChat(v) || v.stayAtDesk || v.live ? seatSpot(v.desk, v.seat) : coffeeSpot(v.desk);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const tag = document.createElement('div');
      tag.className = 'nametag';
      this.overlay.append(bubble, tag);
      a = { id: v.id, x: start.x, y: start.y, walkPhase: 0, view: v, bubble, tag, speech: null, awaitingSince: null, bubbleText: '', lastGreet: '' };
      this.actors.set(v.id, a);
    }
    a.view = v;
    this.layout();
    // corner characters speak their replies instead (see renderSpeech, called every frame)
    a.bubble.classList.toggle('speech', isChat(v));
    if (!isChat(v)) a.bubble.textContent = v.status === 'idle' ? '☕' : v.activity;
    a.bubble.title = v.activity;
    a.bubble.dataset.status = v.status;
    a.tag.textContent = v.name.replace(/^.*"(.*)".*$/, '$1');
  }

  /** A corner character's reply (an assistant log line): shown over their head, typed out. */
  say(id: string, text: string) {
    const a = this.actors.get(id);
    if (!a || !isChat(a.view) || !text.trim()) return;
    a.speech = { chars: Array.from(text.trim()), shown: 0 };
    a.awaitingSince = null;
    // one conversation at a time: the other corner characters fall quiet
    for (const o of this.actors.values()) if (o !== a && isChat(o.view)) o.speech = null;
  }

  /** What the manager said to a corner character (a user log line): shown over the manager's head. */
  managerSay(id: string, text: string) {
    const a = this.actors.get(id);
    if (!a || !isChat(a.view) || !text.trim()) return;
    a.speech = null;
    a.awaitingSince = this.t;
    for (const o of this.actors.values()) if (isChat(o.view) && o !== a) o.speech = null;
    this.managerLine = { to: id, speech: { chars: Array.from(text.trim()), shown: 0 }, hideAt: null };
  }

  /** Advance the typewriter and write each corner character's bubble (and the manager's line). */
  private renderSpeech() {
    // walking up to a chat character gets a fresh greeting; walking away drops it
    if (this.selected !== this.greetedSel) {
      const prev = this.greetedSel ? this.actors.get(this.greetedSel) : null;
      if (prev?.speech?.greet) prev.speech = null;
      const a = this.selected ? this.actors.get(this.selected) : null;
      // not while a reply is on its way or still being typed out
      if (a && isChat(a.view) && a.awaitingSince == null && (!a.speech || a.speech.shown >= a.speech.chars.length)) {
        const pool = greetings(a.view);
        const fresh = pool.filter((g) => g !== a.lastGreet);
        const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
        a.lastGreet = pick;
        a.speech = { chars: Array.from(pick), shown: 0, greet: true };
      }
      this.greetedSel = this.selected;
    }
    const ml = this.managerLine;
    if (ml) {
      ml.speech.shown = Math.min(ml.speech.chars.length, ml.speech.shown + TYPE_SPEED);
      const to = this.actors.get(ml.to);
      const reply = to?.speech?.greet ? null : to?.speech;
      // fade out a while after the reply has finished typing, or once nobody is answering any more
      if (ml.hideAt == null && reply && reply.shown >= reply.chars.length) ml.hideAt = this.t + MANAGER_LINE_HOLD;
      if (ml.hideAt == null && to && !reply && to.awaitingSince == null) ml.hideAt = this.t + MANAGER_LINE_HOLD;
      if (!to || (ml.hideAt != null && this.t >= ml.hideAt)) this.managerLine = null;
    }
    const line = this.managerLine;
    const text = line ? line.speech.chars.slice(0, Math.floor(line.speech.shown)).join('') : '';
    const head = line ? `→ ${(this.actors.get(line.to)?.view.name ?? '').replace(/^.*"(.*)".*$/, '$1')}` : '';
    const key = `${head}\n${text}`;
    if (key !== this.managerBubbleText) {
      this.managerBubbleText = key;
      this.managerBubble.hidden = !line;
      const to = document.createElement('span');
      to.className = 'speech-to';
      to.textContent = head;
      this.managerBubble.replaceChildren(to, document.createTextNode(text));
    }

    for (const a of this.actors.values()) {
      const v = a.view;
      if (!isChat(v)) continue;
      // a turn that ended without a reply (stopped, failed) stops the waiting dots
      if (a.awaitingSince != null && !BUSY.includes(v.status) && this.t - a.awaitingSince > 120) a.awaitingSince = null;
      let out: string;
      if (v.status === 'waiting_permission' || v.status === 'error') out = v.activity;
      else if (a.awaitingSince != null && !a.speech) out = '.'.repeat(1 + (Math.floor(this.t / 20) % 3));
      else if (a.speech) {
        a.speech.shown = Math.min(a.speech.chars.length, a.speech.shown + TYPE_SPEED);
        out = a.speech.chars.slice(0, Math.floor(a.speech.shown)).join('');
      } else out = '';
      if (out !== a.bubbleText) {
        a.bubbleText = out;
        a.bubble.textContent = out;
      }
      a.bubble.hidden = !out;
    }
  }

  /** GPU servers are shown in the jobs panel now, not drawn in the office. */
  setServers(list: ServerView[]) {
    this.servers = list;
  }

  // ---------- static background
  private paintStatic(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    // floor: offset planks with a seam between courses
    for (let y = WALL_H; y < H; y += 8)
      for (let x = 0; x < W; x += 16) {
        g.fillStyle = (x / 16 + y / 8) % 2 === 0 ? '#bb8d5d' : '#b08350';
        g.fillRect(x + ((y / 8) % 2) * 8 - 8, y, 16, 8);
      }
    g.fillStyle = '#9c6d40';
    for (let y = WALL_H; y < H; y += 8) g.fillRect(0, y, W, 1);
    for (let y = WALL_H; y < H; y += 8) {
      g.fillStyle = 'rgba(255,240,210,0.10)'; // a touch of light down each plank
      g.fillRect(0, y + 1, W, 1);
    }
    // wall, with a picture rail and skirting so it reads as a room
    g.fillStyle = '#e7ddca';
    g.fillRect(0, 0, W, WALL_H);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, 0, W, 6);
    g.fillStyle = '#cdbfa6';
    g.fillRect(0, WALL_H - 8, W, 2);
    g.fillStyle = '#c9bca4';
    g.fillRect(0, WALL_H - 4, W, 4);
    g.fillStyle = 'rgba(0,0,0,0.10)'; // shadow the wall casts on the floor
    g.fillRect(0, WALL_H, W, 3);
    // window
    g.fillStyle = '#6b5a45';
    g.fillRect(14, 5, 44, 24);
    if (this.phase === 'day') {
      g.fillStyle = '#9fd3f5';
      g.fillRect(16, 7, 40, 20);
      g.fillStyle = '#ffffff';
      g.fillRect(22, 11, 8, 3);
      g.fillRect(36, 16, 10, 3);
    } else if (this.phase === 'dusk') {
      // sunset: orange at the horizon up to purple, a low sun
      ['#5b4a8a', '#8a5a9a', '#c9668a', '#f08a5d', '#f7b267'].forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect(16, 7 + i * 4, 40, 4);
      });
      g.fillStyle = '#ffe9a8';
      g.fillRect(24, 20, 6, 4);
      g.fillRect(25, 19, 4, 1);
    } else {
      // night: dark sky, a moon and a few stars
      g.fillStyle = '#1b2440';
      g.fillRect(16, 7, 40, 20);
      g.fillStyle = '#f4f1d0';
      g.fillRect(43, 10, 5, 5);
      g.fillStyle = '#1b2440';
      g.fillRect(45, 10, 3, 3); // bite out of the moon → a crescent
      g.fillStyle = '#e8ecff';
      for (const [sx, sy] of [[20, 10], [27, 16], [31, 9], [38, 21], [50, 22], [22, 22]]) g.fillRect(sx, sy, 1, 1);
    }
    g.fillStyle = '#6b5a45';
    g.fillRect(35, 7, 2, 20);
    // whiteboard frame (task counts drawn dynamically)
    g.fillStyle = '#8c8c8c';
    g.fillRect(104, 4, 112, 28);
    g.fillStyle = '#fbfbf7';
    g.fillRect(106, 6, 108, 24);
    // poster: a bar chart
    g.fillStyle = '#2e3440';
    g.fillRect(236, 6, 40, 24);
    const bars = [6, 10, 8, 14, 12, 17];
    bars.forEach((h, i) => {
      g.fillStyle = i === bars.length - 1 ? '#ffd27b' : '#7bc4ff';
      g.fillRect(241 + i * 5, 27 - h, 3, h);
    });
    g.fillStyle = '#d8dee9';
    g.fillRect(239, 27, 34, 1);
    // ceiling lights: a pool of warm light under each one
    for (const lx of COL_X.map((x) => x + 30)) {
      g.fillStyle = '#6e6456';
      g.fillRect(lx - 1, 0, 2, 5);
      g.fillStyle = '#d9cfa8';
      g.fillRect(lx - 9, 5, 18, 3);
      g.fillStyle = '#fff4cf';
      g.fillRect(lx - 7, 8, 14, 1);
      const grad = g.createRadialGradient(lx, WALL_H, 4, lx, WALL_H, 70);
      grad.addColorStop(0, 'rgba(255,240,200,0.16)');
      grad.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = grad;
      g.fillRect(lx - 70, WALL_H, 140, 90);
    }
    // bookshelf against the right wall, where the server room used to be
    g.fillStyle = '#6b4a2f';
    g.fillRect(366, 44, 28, 54);
    g.fillStyle = '#50371f';
    g.fillRect(366, 44, 28, 2);
    for (let r = 0; r < 3; r++) {
      const sy = 48 + r * 17;
      g.fillStyle = '#3f2c19';
      g.fillRect(367, sy + 14, 26, 2);
      const books = ['#c0504d', '#4f81bd', '#9bbb59', '#e8c55a', '#8064a2'];
      for (let b = 0; b < 6; b++) {
        g.fillStyle = books[(r * 6 + b) % books.length];
        const bh = 10 + ((r + b) % 3);
        g.fillRect(368 + b * 4, sy + 14 - bh, 3, bh);
      }
    }
    // clock on the far right of the wall
    g.fillStyle = '#6e6456';
    g.fillRect(352, 10, 16, 16);
    g.fillStyle = '#fbfbf7';
    g.fillRect(353, 11, 14, 14);
    // (the hands are drawn per frame in drawClock, at the real time)
    // counter + coffee machine
    g.fillStyle = '#7a5537';
    g.fillRect(6, 44, 40, 14);
    g.fillStyle = '#5e4029';
    g.fillRect(6, 56, 40, 2);
    paintMap(g, COFFEE, COFFEE_COLORS, 12, 33);
    g.fillStyle = '#ffffff';
    g.fillRect(28, 40, 4, 4);
    g.fillRect(34, 40, 4, 4);
    // plants
    // (the plants are drawn per frame in drawPlant: they grow)
    // water cooler beside the lounge, so the coffee corner is not alone
    g.fillStyle = '#cfd8dc';
    g.fillRect(54, 40, 10, 8);
    g.fillStyle = '#7fb2ff';
    g.fillRect(55, 41, 8, 6);
    g.fillStyle = '#90a4ae';
    g.fillRect(55, 48, 8, 10);
    g.fillStyle = '#607d8b';
    g.fillRect(55, 58, 8, 1);
    // manager desk ("you") is drawn per frame in drawBossRug/drawBossChair/drawBossDesk (y-sorted with the actors)
    // rug under desks
    // rug under the desk grid, with a border — follows the row count
    const rugY = GRID_TOP - 14;
    const rugH = this.rows * ROW_H - 10;
    const rugX = COL_X[0] - 14;
    const rugW = COL_X[2] + 60 + 14 - rugX;
    g.fillStyle = 'rgba(70,100,130,0.16)';
    g.fillRect(rugX, rugY, rugW, rugH);
    g.fillStyle = 'rgba(70,100,130,0.22)';
    g.fillRect(rugX, rugY, rugW, 2);
    g.fillRect(rugX, rugY + rugH - 2, rugW, 2);
    g.fillRect(rugX, rugY, 2, rugH);
    g.fillRect(rugX + rugW - 2, rugY, 2, rugH);
    // after six the room goes dim and the ceiling lights do the work
    if (this.phase !== 'day') {
      g.fillStyle = this.phase === 'dusk' ? 'rgba(60,30,60,0.14)' : 'rgba(14,18,48,0.30)';
      g.fillRect(0, WALL_H, W, H - WALL_H);
      g.fillStyle = this.phase === 'dusk' ? 'rgba(60,30,60,0.08)' : 'rgba(14,18,48,0.18)';
      g.fillRect(0, 0, W, WALL_H);
      for (const lx of COL_X.map((x) => x + 30)) {
        const grad = g.createRadialGradient(lx, WALL_H, 4, lx, WALL_H, 80);
        grad.addColorStop(0, this.phase === 'dusk' ? 'rgba(255,236,190,0.16)' : 'rgba(255,236,190,0.30)');
        grad.addColorStop(1, 'rgba(255,236,190,0)');
        g.fillStyle = grad;
        g.fillRect(lx - 80, WALL_H, 160, 100);
      }
    }
    return c;
  }

  private drawDesk(i: number, status: AgentStatus | null, local = false, seat?: Seat) {
    const g = this.g;
    const { x, y } = deskPos(i, seat);
    // desk top
    g.fillStyle = '#8b5e3c';
    g.fillRect(x, y, 60, 14);
    g.fillStyle = '#6e4a2f';
    g.fillRect(x, y + 12, 60, 3);
    g.fillRect(x + 2, y + 15, 3, 6);
    g.fillRect(x + 55, y + 15, 3, 6);
    // monitor (back side) + glow
    g.fillStyle = '#30343c';
    g.fillRect(x + 6, y - 10, 18, 12);
    g.fillRect(x + 13, y + 2, 4, 2);
    const glow = status ? MONITOR_GLOW[status] : undefined;
    if (glow) {
      g.fillStyle = glow;
      g.globalAlpha = 0.35 + 0.15 * Math.sin(this.t / 6);
      g.fillRect(x + 4, y - 12, 22, 2);
      g.globalAlpha = 1;
    }
    // papers / mug
    g.fillStyle = '#f2f2f2';
    g.fillRect(x + 40, y + 3, 8, 6);
    g.fillStyle = '#d0d0d0';
    g.fillRect(x + 41, y + 5, 6, 1);
    g.fillStyle = '#c0504d';
    g.fillRect(x + 51, y + 3, 4, 4);
    if (local) this.drawLocalBox(x, y, status);
  }

  /** desk of an employee on a local model: a small GPU tower under the desk, LED blinks while working */
  private drawLocalBox(x: number, y: number, status: AgentStatus | null) {
    const g = this.g;
    g.fillStyle = '#23262d';
    g.fillRect(x + 44, y + 9, 10, 13);
    g.fillStyle = '#3a3f4a';
    g.fillRect(x + 45, y + 10, 8, 1);
    const busy = status != null && status in MONITOR_GLOW;
    g.fillStyle = busy && Math.floor(this.t / 8) % 2 ? '#6dff8e' : '#2e8b57';
    g.fillRect(x + 46, y + 13, 2, 2);
    g.fillStyle = '#76b900';
    g.fillRect(x + 46, y + 18, 6, 1);
  }

  // ---- team lead's desk: a regular desk plus a simple office chair and a small brass nameplate (kept modest
  // so the manager's desk next to it stays the showpiece)
  private drawLeadChair(i: number, seat?: Seat) {
    const g = this.g;
    const s = seatSpot(i, seat);
    g.fillStyle = '#2f3440';
    g.fillRect(s.x - 6, s.y - 15, 12, 13);
    g.fillStyle = '#3d4352';
    g.fillRect(s.x - 5, s.y - 14, 10, 2);
  }

  private drawLeadDesk(i: number, status: AgentStatus | null, seat?: Seat) {
    this.drawDesk(i, status, false, seat);
    const g = this.g;
    const { x, y } = deskPos(i, seat);
    g.fillStyle = '#b8892e';
    g.fillRect(x + 24, y + 8, 12, 3);
    g.fillStyle = '#e8c55a';
    g.fillRect(x + 24, y + 8, 12, 1);
  }


  private drawWhiteboard() {
    const g = this.g;
    if (this.boardText) return; // the manager's message replaces the task-count stickies
    const cols: Array<[string, string]> = [
      ['todo', '#f6d365'],
      ['doing', '#7fb2ff'],
      ['review', '#f59f9f'],
      ['done', '#9bd49b'],
    ];
    cols.forEach(([state, color], ci) => {
      const n = this.tasks.filter((t) => t.state === state).length;
      g.fillStyle = '#c8c8c8';
      g.fillRect(108 + ci * 27, 8, 24, 1);
      for (let k = 0; k < Math.min(n, 6); k++) {
        g.fillStyle = color;
        g.fillRect(110 + ci * 27 + (k % 3) * 7, 11 + Math.floor(k / 3) * 8, 6, 6);
      }
    });
  }

  private target(a: Actor): Spot {
    const v = a.view;
    // the professor, poked five times, stands right behind the manager's chair for a while
    if (v.seat === 'podium' && this.hoverUntil > this.t) return { x: 150, y: H - 44 };
    if (v.stayAtDesk || isChat(v)) return seatSpot(v.desk, v.seat);
    // the server room is gone from the drawing; remote work just shows in the bubble
    if (SEATED.includes(v.status) || v.status === 'remote') return seatSpot(v.desk, v.seat);
    if (BESIDE.includes(v.status)) return besideSpot(v.desk, v.seat);
    // session still open = still at the desk, ready for the next instruction; closed = off to the lounge
    return v.live ? seatSpot(v.desk, v.seat) : coffeeSpot(v.desk);
  }

  private tick() {
    if (this.paused) return;
    this.t++;
    const g = this.g;
    g.imageSmoothingEnabled = false;
    // the look follows the clock: checked a few times a minute
    if (this.t % 600 === 1) {
      const ph = dayPhase();
      if (ph !== this.phase) {
        this.phase = ph;
        this.floor = this.paintStatic();
      }
      this.plants = { left: plantStage('left'), right: plantStage('right') };
    }
    g.drawImage(this.floor, 0, 0);
    this.drawWhiteboard();
    this.drawClock();

    // move actors
    for (const a of this.actors.values()) {
      const tg = this.target(a);
      const dx = tg.x - a.x;
      const dy = tg.y - a.y;
      const sp = 0.9;
      if (Math.abs(dx) > 0.5) a.x += Math.sign(dx) * Math.min(sp, Math.abs(dx));
      else if (Math.abs(dy) > 0.5) a.y += Math.sign(dy) * Math.min(sp, Math.abs(dy));
      else {
        a.x = tg.x;
        a.y = tg.y;
      }
      a.walkPhase = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 ? a.walkPhase + 1 : 0;
    }

    // draw desks and actors sorted by y (desks drawn after seated actor so they occlude legs)
    type Item = { y: number; draw: () => void };
    const items: Item[] = [];
    // one desk per (seat, slot): a reserved seat and a grid slot can share a number
    type Desk = { i: number; seat?: Seat; lead: boolean; local: boolean; status: AgentStatus | null };
    const desks = new Map<string, Desk>();
    const key = (i: number, seat?: string) => `${seat ?? ''}#${i}`;
    // only occupied desks are drawn — an office of empty furniture looks abandoned

    for (const a of this.actors.values()) {
      const v = a.view;
      const spot = seatSpot(v.desk, v.seat);
      const seated = a.x === spot.x && a.y === spot.y;
      items.push({ y: a.y + (seated ? -0.5 : 0), draw: () => this.drawActor(a, seated) });
      if (isChat(v)) continue; // they stand; no desk
      desks.set(key(v.desk, v.seat), {
        i: v.desk,
        seat: v.seat,
        lead: v.deskStyle === 'lead',
        local: !!v.provider,
        status: seated ? v.status : null,
      });
    }
    for (const d of desks.values()) {
      const p = deskPos(d.i, d.seat);
      if (d.lead) {
        items.push({ y: seatSpot(d.i, d.seat).y - 1, draw: () => this.drawLeadChair(d.i, d.seat) }); // behind the seated actor
        items.push({ y: p.y + 2, draw: () => this.drawLeadDesk(d.i, d.status, d.seat) });
      } else items.push({ y: p.y + 2, draw: () => this.drawDesk(d.i, d.status, d.local, d.seat) });
    }
    // the corner characters' rug, under everything
    if ([...this.actors.values()].some((a) => a.view.seat === 'corner')) items.push({ y: -1e9, draw: () => this.drawCornerRug() });
    // the manager (you) behind the manager desk
    items.push({ y: -1e9 + 1, draw: () => this.drawBossRug() });
    items.push({ y: H - 35, draw: () => this.drawBossChair() });
    items.push({ y: H - 34, draw: () => this.drawBoss() });
    items.push({ y: H - 33, draw: () => this.drawBossDesk() });
    // the professor's podium stays where it is, with or without him on it
    if ([...this.actors.values()].some((a) => a.view.seat === 'podium')) items.push({ y: PROF.y - 0.1, draw: () => this.drawPodium() });
    if (this.hoverUntil > this.t) items.push({ y: H - 32, draw: () => this.drawSweat() });
    for (const side of ['left', 'right'] as PlantSide[]) items.push({ y: H - 12, draw: () => this.drawPlant(side) });
    items.sort((p, q) => p.y - q.y).forEach((it) => it.draw());

    this.renderSpeech();
    this.layoutOverlay();
  }

  /** a small round-cornered rug for the corner characters, between the plant and the manager's rug */
  private drawCornerRug() {
    const g = this.g;
    const x = 22, y = H - 26, w = 76, h = 22;
    g.fillStyle = '#8a5a3b';
    g.fillRect(x + 1, y, w - 2, h);
    g.fillRect(x, y + 1, w, h - 2);
    g.fillStyle = '#c47a4a';
    g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.fillStyle = '#e0a366';
    for (let k = 0; k < 3; k++) g.fillRect(x + 6, y + 6 + k * 4, w - 12, 1);
  }

  private drawPodium() {
    const g = this.g;
    g.fillStyle = '#c9a227';
    g.fillRect(PROF.x - 12, PROF.y - 2, 24, 1);
    g.fillStyle = '#4e3020';
    g.fillRect(PROF.x - 12, PROF.y - 1, 24, 4);
    g.fillStyle = '#3b2418';
    g.fillRect(PROF.x - 12, PROF.y + 3, 24, 1);
  }

  /** the professor, feet at (px, py - 2); returns the sprite's top-left for the status glyphs */
  private drawProfessor(px: number, py: number) {
    const g = this.g;
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(px - 5, py - 3, PROF_W - 2, 1);
    // hair flutters in gusts: a few seconds of wind every ~7 s
    const gust = this.t % 420 < 150;
    const frame = gust && Math.floor(this.t / 10) % 2 ? 1 : 0;
    const x = px - PROF_W / 2, y = py - 2 - PROF_H;
    g.drawImage(professorSprite(this.t % 300 < 5, frame), x, y);
    return { x, y };
  }

  /** wall clock hands at the real time (the face is in the static layer) */
  private drawClock() {
    const g = this.g;
    const { h, m } = clockNow();
    const hand = (turn: number, len: number) => {
      const a = turn * Math.PI * 2;
      for (let k = 0; k <= len; k++) g.fillRect(Math.round(359.5 + Math.sin(a) * k - 0.5), Math.round(17.5 - Math.cos(a) * k - 0.5), 1, 1);
    };
    g.fillStyle = '#2e3440';
    hand(m / 60, 5);
    hand(((h % 12) + m / 60) / 12, 3);
  }

  /** a plant at its current stage, bottom-aligned so taller stages grow upward; drops while being watered */
  private drawPlant(side: PlantSide) {
    const g = this.g;
    const rows = PLANT_STAGES[this.plants[side]];
    const x = PLANT_X[side];
    paintMap(g, rows, PLANT_COLORS, x, H - 12 - rows.length);
    if (this.drip?.side === side && this.drip.until > this.t) {
      const k = 45 - (this.drip.until - this.t);
      g.fillStyle = '#7fc8ff';
      for (let d = 0; d < 3; d++) {
        const fall = (k + d * 5) % 15;
        g.fillRect(x + 1 + d * 3, H - 12 - rows.length - 12 + fall, 1, 2);
      }
    }
  }

  /** the manager sweats while the professor is standing behind them */
  private drawSweat() {
    if (Math.floor(this.t / 20) % 2) return;
    const g = this.g;
    const x = 150 + MANAGER_W / 2 + 1, y = H - 34 - MANAGER_H + 3 + (Math.floor(this.t / 40) % 2);
    g.fillStyle = '#9fd8ff';
    g.fillRect(x, y, 1, 1);
    g.fillRect(x - 1, y + 1, 3, 2);
  }

  // ---- the manager (you): wine rug with gold border, high-back leather chair, wide walnut desk,
  // dual monitors, brass lamp, gold nameplate, trophy
  private drawBossRug() {
    const g = this.g;
    const x = 106, y = H - 42;
    g.fillStyle = '#c9a227';
    g.fillRect(x, y, 88, 46);
    g.fillStyle = '#6b2737';
    g.fillRect(x + 1, y + 1, 86, 44);
    g.fillStyle = '#7d3044';
    g.fillRect(x + 4, y + 4, 80, 38);
    g.fillStyle = 'rgba(201,162,39,0.55)';
    for (let k = 0; k < 9; k++) g.fillRect(x + 6 + k * 9, y + 37, 3, 1);
    // a slow golden spotlight behind the chair
    const glow = g.createRadialGradient(150, H - 44, 2, 150, H - 44, 30);
    const a = 0.16 + 0.06 * Math.sin(this.t / 40);
    glow.addColorStop(0, `rgba(255,220,120,${a.toFixed(3)})`);
    glow.addColorStop(1, 'rgba(255,220,120,0)');
    g.fillStyle = glow;
    g.fillRect(x + 1, y + 1, 86, 44);
  }

  private drawBossChair() {
    const g = this.g;
    const x = 150 - 8;
    const top = H - 34 - 19;
    g.fillStyle = '#3a1712';
    g.fillRect(x, top + 1, 16, 18);
    g.fillRect(x + 1, top, 14, 1);
    g.fillStyle = '#5a2a22';
    g.fillRect(x + 2, top + 2, 12, 15);
    g.fillStyle = '#7a3a2e';
    g.fillRect(x + 3, top + 2, 10, 2);
    g.fillStyle = '#3a1712'; // tufting
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) g.fillRect(x + 5 + c * 5, top + 6 + r * 5, 1, 1);
    g.fillStyle = '#e8c55a'; // brass studs
    g.fillRect(x, top + 2, 1, 1);
    g.fillRect(x + 15, top + 2, 1, 1);
  }

  private drawBossDesk() {
    const g = this.g;
    const x = 114, y = H - 36; // 72 px wide, centred on the manager
    // brass lamp on the far left with a soft warm cone
    g.fillStyle = 'rgba(255,214,120,0.16)';
    g.beginPath();
    g.moveTo(x + 4, y - 9);
    g.lineTo(x - 2, y + 8);
    g.lineTo(x + 16, y + 8);
    g.closePath();
    g.fill();
    g.fillStyle = '#b8892e';
    g.fillRect(x + 4, y - 9, 1, 12);
    g.fillRect(x + 2, y + 2, 5, 1);
    g.fillStyle = '#2f6b4f';
    g.fillRect(x + 1, y - 13, 9, 4);
    g.fillStyle = '#e8c55a';
    g.fillRect(x + 1, y - 10, 9, 1);
    // dual monitors (backs)
    for (const mx of [x + 12, x + 44]) {
      g.fillStyle = '#23262d';
      g.fillRect(mx, y - 11, 16, 12);
      g.fillStyle = '#3a3f4a';
      g.fillRect(mx + 1, y - 10, 14, 1);
      g.fillStyle = '#23262d';
      g.fillRect(mx + 6, y + 1, 4, 2);
    }
    // walnut desk top + gold moulding
    g.fillStyle = '#4e3020';
    g.fillRect(x, y, 72, 14);
    g.fillStyle = '#5f3a27';
    g.fillRect(x + 1, y + 1, 70, 2);
    g.fillStyle = '#c9a227';
    g.fillRect(x, y + 11, 72, 1);
    // front panel, drawers with gold pulls
    g.fillStyle = '#3b2418';
    g.fillRect(x, y + 12, 72, 4);
    g.fillRect(x + 2, y + 16, 12, 6);
    g.fillRect(x + 58, y + 16, 12, 6);
    g.fillStyle = '#e8c55a';
    g.fillRect(x + 7, y + 18, 2, 1);
    g.fillRect(x + 63, y + 18, 2, 1);
    // gold nameplate
    g.fillStyle = '#8a6d1c';
    g.fillRect(x + 28, y + 6, 16, 4);
    g.fillStyle = '#e8c55a';
    g.fillRect(x + 28, y + 6, 16, 3);
    g.fillStyle = '#5a4512';
    g.fillRect(x + 31, y + 7, 10, 1);
    // papers + fountain pen
    g.fillStyle = '#f2f2f2';
    g.fillRect(x + 14, y + 4, 9, 6);
    g.fillStyle = '#d0d0d0';
    g.fillRect(x + 15, y + 6, 7, 1);
    g.fillStyle = '#1c1c1c';
    g.fillRect(x + 24, y + 5, 1, 4);
    // trophy
    g.fillStyle = '#e8c55a';
    g.fillRect(x + 62, y + 1, 5, 3);
    g.fillRect(x + 64, y + 4, 1, 3);
    g.fillRect(x + 62, y + 7, 5, 2);
    g.fillStyle = '#fff3b0';
    g.fillRect(x + 63, y + 1, 1, 2);
  }

  private drawBoss() {
    const g = this.g;
    const t = this.t;
    const cx = 150;
    const x = cx - MANAGER_W / 2;
    const y = H - 34 - MANAGER_H; // sits up a little so the chain shows above the desk, which hides the legs
    // crimson cape with gold trim, hem swaying a little
    const sway = Math.round(Math.sin(t / 22));
    for (let r = 0; r < 10; r++) {
      const half = 7 + Math.floor(r / 3);
      const dx = r > 5 ? sway : 0;
      g.fillStyle = '#8e1a2e';
      g.fillRect(cx - half + dx, y + 9 + r, half * 2, 1);
      g.fillStyle = '#e8c55a';
      g.fillRect(cx - half + dx, y + 9 + r, 1, 1);
      g.fillRect(cx + half - 1 + dx, y + 9 + r, 1, 1);
    }
    g.drawImage(managerSprite(t % 240 < 6), x, y);
    // sparkles twinkling around, each on its own phase
    const spots = [[-13, 2], [12, -3], [-10, 14], [14, 10], [0, -6]];
    spots.forEach(([sx, sy], k) => {
      const ph = (t + k * 37) % 120;
      if (ph > 24) return;
      const px = cx + sx, py = y + sy;
      const big = ph > 6 && ph < 18;
      g.fillStyle = '#ffe680';
      g.fillRect(px, py - (big ? 2 : 1), 1, big ? 5 : 3);
      g.fillRect(px - (big ? 2 : 1), py, big ? 5 : 3, 1);
      g.fillStyle = '#ffffff';
      g.fillRect(px, py, 1, 1);
    });
  }

  /** A small gold crown above the lead's head. */
  private drawCrown(cx: number, headTop: number) {
    const g = this.g;
    const x = Math.round(cx) - 4;
    const y = Math.round(headTop) - 4;
    g.fillStyle = '#b8892e'; // band
    g.fillRect(x, y + 3, 9, 2);
    g.fillStyle = '#e8c55a'; // points
    g.fillRect(x, y, 2, 3);
    g.fillRect(x + 4, y - 1, 2, 4);
    g.fillRect(x + 7, y, 2, 3);
    g.fillRect(x, y + 2, 9, 1);
    g.fillStyle = '#ff6b6b'; // jewel
    g.fillRect(x + 4, y + 3, 1, 1);
  }

  private drawActor(a: Actor, seated: boolean) {
    const g = this.g;
    const v = a.view;
    let pose: Pose = 'stand';
    if (a.walkPhase) pose = Math.floor(a.walkPhase / 8) % 2 ? 'walkA' : 'walkB';
    // corner characters have no desk to type at: they just stand there and talk
    else if (isChat(v) && v.status !== 'waiting_permission') pose = 'stand';
    else if (seated && ['typing', 'running', 'researching'].includes(v.status)) pose = Math.floor(this.t / 7) % 2 ? 'typeA' : 'typeB';
    else if (v.status === 'remote') pose = Math.floor(this.t / 9) % 2 ? 'typeA' : 'typeB';
    else if (v.status === 'waiting_permission') pose = 'handUp';
    else if (v.status === 'idle') pose = Math.floor(this.t / 90) % 3 === 0 ? 'cup' : 'stand';
    const blink = this.t % 200 < 6;
    const bob = v.status === 'waiting_permission' ? Math.round(Math.sin(this.t / 5)) : 0;
    let x = Math.round(a.x - SPRITE_W / 2);
    let y = Math.round(a.y - SPRITE_H + bob);
    if (v.seat === 'podium') {
      // the professor keeps his own look (and never raises a hand): podium, suit, hair in the wind
      ({ x, y } = this.drawProfessor(Math.round(a.x), Math.round(a.y)));
    } else {
      // shadow
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(x + 1, Math.round(a.y) - 1, SPRITE_W - 2, 2);
      g.drawImage(characterSprite(v.sprite, pose, blink), x, y);
    }
    if (v.deskStyle === 'lead') this.drawCrown(x + SPRITE_W / 2, y);
    // selection marker
    if (this.selected === a.id) {
      g.fillStyle = '#ffe066';
      const ty = y - 6 + Math.round(Math.sin(this.t / 8));
      g.fillRect(x + 4, ty, 4, 2);
      g.fillRect(x + 5, ty + 2, 2, 1);
    }
    // status glyphs
    if (v.status === 'thinking' && !a.walkPhase) {
      g.fillStyle = '#ffffff';
      for (let k = 0; k < 3; k++) if (Math.floor(this.t / 15) % 4 > k) g.fillRect(x + 12 + k * 3, y - 2, 2, 2);
    }
    if (v.status === 'waiting_permission' || v.status === 'error') {
      g.fillStyle = v.status === 'error' ? '#ff4d4d' : '#ffcc00';
      g.fillRect(x + 13, y - 6 + bob, 2, 5);
      g.fillRect(x + 13, y + bob, 2, 2);
    }
    if (v.status === 'done' && Math.floor(this.t / 10) % 2) {
      g.fillStyle = '#fff59d';
      g.fillRect(x - 2, y + 2, 1, 1);
      g.fillRect(x + 13, y + 4, 1, 1);
      g.fillRect(x + 6, y - 3, 1, 1);
    }
    if (v.status === 'queued') {
      g.fillStyle = '#d8dee9';
      g.fillRect(x + 13, y - 5, 4, 1);
      g.fillRect(x + 14, y - 4, 2, 2);
      g.fillRect(x + 13, y - 2, 4, 1);
    }
  }

  private layoutOverlay() {
    const s = this.scale;
    for (const [key, tag] of this.figureTags) {
      const f = FIGURES[key];
      if (f.tag) {
        tag.style.left = `${f.tag.x * s}px`;
        tag.style.top = `${figAt(f, f.tag.y) * s}px`;
      } else {
        // text overlay sized to the inner whiteboard
        tag.style.left = `${(f.box.x0 + 3) * s}px`;
        tag.style.top = `${(figAt(f, f.box.y0) + 2) * s}px`;
        tag.style.width = `${(f.box.x1 - f.box.x0 - 6) * s}px`;
        tag.style.height = `${(f.box.y1 - f.box.y0 - 4) * s}px`;
        tag.style.fontSize = `${Math.max(12, 9 * s)}px`;
      }
    }
    const width = W * s;
    // speech bubbles are wide and wrap: keep them inside the canvas and point the tail at the speaker's head
    const placeSpeech = (b: HTMLDivElement, headX: number, headY: number, anchor: number) => {
      const w = b.offsetWidth;
      const left = Math.max(4, Math.min(width - w - 4, headX - w * anchor));
      b.style.left = `${left}px`;
      b.style.top = `${headY}px`;
      b.style.setProperty('--tail-x', `${headX - left}px`);
    };
    for (const a of this.actors.values()) {
      if (isChat(a.view)) {
        const top = a.view.seat === 'podium' ? a.y - 2 - PROF_H - 5 : a.y - SPRITE_H - 5;
        if (!a.bubble.hidden) placeSpeech(a.bubble, a.x * s, top * s, 0.5);
      } else {
        a.bubble.style.left = `${a.x * s}px`;
        a.bubble.style.top = `${(a.y - SPRITE_H - 5) * s}px`;
      }
      a.bubble.classList.toggle('selected', this.selected === a.id);
      a.tag.style.left = `${a.x * s}px`;
      a.tag.style.top = `${(a.y + 2) * s}px`;
      // off his podium (standing behind the manager) the professor's tag would sit on the manager's face
      a.tag.hidden = a.view.seat === 'podium' && (a.x !== PROF.x || a.y !== PROF.y);
    }
    // the manager's line: if a reply bubble is in the way, it moves up above it (older line on top, like a chat log)
    const mb = this.managerBubble;
    mb.classList.remove('stacked');
    if (!mb.hidden) {
      placeSpeech(mb, 150 * s, (H - 34 - MANAGER_H - 2) * s, 0.15);
      const m = mb.getBoundingClientRect();
      for (const a of this.actors.values()) {
        if (!isChat(a.view) || a.bubble.hidden) continue;
        const r = a.bubble.getBoundingClientRect();
        if (r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom) {
          mb.style.top = `${parseFloat(mb.style.top) - (m.bottom - r.top) - 6}px`;
          mb.classList.add('stacked');
        }
      }
    }
  }
}
