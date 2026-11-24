import { figureDefaultName, type FigureKey } from '../../../shared/protocol.ts';
import { tr } from '../../../shared/i18n.ts';
import type { AgentStatus, EmployeeView, ServerView, Task } from '../../../shared/protocol.ts';
import { COFFEE, COFFEE_COLORS, PLANT, PLANT_COLORS, PROF_H, PROF_W, SPRITE_H, SPRITE_W, characterSprite, paintMap, professorSprite, type Pose } from './sprites.ts';

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
 * Where the (decorative) professor stands: in the aisle between the last desk row and the manager,
 * right of the manager desk. Kept clear of the grid — he used to stand on the lead's desk.
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
  professor: { tag: { x: 346, y: -82 }, box: { x0: 337, x1: 355, y0: -110, y1: -82 }, ask: () => askName('professor'), fromBottom: true },
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

interface Actor {
  id: string;
  x: number;
  y: number;
  walkPhase: number;
  view: EmployeeView;
  bubble: HTMLDivElement;
  tag: HTMLDivElement;
}

/** Reserved seats sit in the bottom strip; every other desk is a slot in the grid. */
const seatPos = (seat: 'reception' | 'lead') => (seat === 'reception' ? { x: 206, y: H - 44 } : { x: 40, y: H - 36 });
const deskPos = (i: number, seat?: 'reception' | 'lead') =>
  seat ? seatPos(seat) : { x: COL_X[i % COLS], y: GRID_TOP + Math.floor(i / COLS) * ROW_H };
const seatSpot = (i: number, seat?: 'reception' | 'lead'): Spot => ({ x: deskPos(i, seat).x + 30, y: deskPos(i, seat).y + 2 });
const besideSpot = (i: number, seat?: 'reception' | 'lead'): Spot => ({ x: deskPos(i, seat).x + 60, y: deskPos(i, seat).y + 16 });
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
    // defer to the next frame: resizing inside the observer callback re-triggers it ("ResizeObserver loop" warning)
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(host);
    this.resize();

    this.canvas.addEventListener('click', (ev) => {
      const fig = this.hitFigure(ev);
      if (fig) {
        const name = prompt(FIGURES[fig].ask(), this.figureTags.get(fig)?.textContent ?? '');
        if (name !== null) this.onRenameFigure(fig, name);
        return;
      }
      const id = this.hit(ev);
      this.selected = id;
      this.onSelect(id);
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
      if (x >= a.x - 9 && x <= a.x + 9 && y >= a.y - SPRITE_H - 3 && y <= a.y + 3) return a.id;
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
      const start = v.stayAtDesk || v.live ? seatSpot(v.desk, v.seat) : coffeeSpot(v.desk);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const tag = document.createElement('div');
      tag.className = 'nametag';
      this.overlay.append(bubble, tag);
      a = { id: v.id, x: start.x, y: start.y, walkPhase: 0, view: v, bubble, tag };
      this.actors.set(v.id, a);
    }
    a.view = v;
    this.layout();
    a.bubble.textContent = v.status === 'idle' ? '☕' : v.activity;
    a.bubble.title = v.activity;
    a.bubble.dataset.status = v.status;
    a.tag.textContent = v.name.replace(/^.*"(.*)".*$/, '$1');
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
    g.fillStyle = '#9fd3f5';
    g.fillRect(16, 7, 40, 20);
    g.fillStyle = '#ffffff';
    g.fillRect(22, 11, 8, 3);
    g.fillRect(36, 16, 10, 3);
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
    g.fillStyle = '#2e3440';
    g.fillRect(359, 14, 1, 5);
    g.fillRect(359, 18, 4, 1);
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
    paintMap(g, PLANT, PLANT_COLORS, 6, H - 20);
    paintMap(g, PLANT, PLANT_COLORS, 372, H - 20);
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
    return c;
  }

  private drawDesk(i: number, status: AgentStatus | null, local = false, seat?: 'reception' | 'lead') {
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
  private drawLeadChair(i: number, seat?: 'reception' | 'lead') {
    const g = this.g;
    const s = seatSpot(i, seat);
    g.fillStyle = '#2f3440';
    g.fillRect(s.x - 6, s.y - 15, 12, 13);
    g.fillStyle = '#3d4352';
    g.fillRect(s.x - 5, s.y - 14, 10, 2);
  }

  private drawLeadDesk(i: number, status: AgentStatus | null, seat?: 'reception' | 'lead') {
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
    if (v.stayAtDesk) return seatSpot(v.desk, v.seat);
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
    g.drawImage(this.floor, 0, 0);
    this.drawWhiteboard();

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
    type Desk = { i: number; seat?: 'reception' | 'lead'; lead: boolean; local: boolean; status: AgentStatus | null };
    const desks = new Map<string, Desk>();
    const key = (i: number, seat?: string) => `${seat ?? ''}#${i}`;
    // only occupied desks are drawn — an office of empty furniture looks abandoned

    for (const a of this.actors.values()) {
      const v = a.view;
      const spot = seatSpot(v.desk, v.seat);
      const seated = a.x === spot.x && a.y === spot.y;
      items.push({ y: a.y + (seated ? -0.5 : 0), draw: () => this.drawActor(a, seated) });
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
    // the professor: just stands there, solemnly
    items.push({ y: PROF.y, draw: () => this.drawProfessor() });
    // the manager (you) behind the manager desk
    items.push({ y: -1e9 + 1, draw: () => this.drawBossRug() });
    items.push({ y: H - 35, draw: () => this.drawBossChair() });
    items.push({ y: H - 34, draw: () => this.drawBoss() });
    items.push({ y: H - 33, draw: () => this.drawBossDesk() });
    items.sort((p, q) => p.y - q.y).forEach((it) => it.draw());

    this.layoutOverlay();
  }

  private drawProfessor() {
    const g = this.g;
    // small podium
    g.fillStyle = '#c9a227';
    g.fillRect(PROF.x - 12, PROF.y - 2, 24, 1);
    g.fillStyle = '#4e3020';
    g.fillRect(PROF.x - 12, PROF.y - 1, 24, 4);
    g.fillStyle = '#3b2418';
    g.fillRect(PROF.x - 12, PROF.y + 3, 24, 1);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(PROF.x - 5, PROF.y - 3, PROF_W - 2, 1);
    // hair flutters in gusts: a few seconds of wind every ~7 s
    const gust = this.t % 420 < 150;
    const frame = gust && Math.floor(this.t / 10) % 2 ? 1 : 0;
    g.drawImage(professorSprite(this.t % 300 < 5, frame), PROF.x - PROF_W / 2, PROF.y - 2 - PROF_H);
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
  }

  private drawBossChair() {
    const g = this.g;
    const x = 150 - 8;
    const top = 206 - 19;
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
    const spr = characterSprite({ hair: '#2e2e2e', shirt: '#4a4a5a', pants: '#2b2b33', skin: '#f1c27d' }, 'stand', this.t % 240 < 6);
    this.g.drawImage(spr, 150 - SPRITE_W / 2, 206 - SPRITE_H + 2);
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
    else if (seated && ['typing', 'running', 'researching'].includes(v.status)) pose = Math.floor(this.t / 7) % 2 ? 'typeA' : 'typeB';
    else if (v.status === 'remote') pose = Math.floor(this.t / 9) % 2 ? 'typeA' : 'typeB';
    else if (v.status === 'waiting_permission') pose = 'handUp';
    else if (v.status === 'idle') pose = Math.floor(this.t / 90) % 3 === 0 ? 'cup' : 'stand';
    const blink = this.t % 200 < 6;
    const spr = characterSprite(v.sprite, pose, blink);
    const bob = v.status === 'waiting_permission' ? Math.round(Math.sin(this.t / 5)) : 0;
    const x = Math.round(a.x - SPRITE_W / 2);
    const y = Math.round(a.y - SPRITE_H + bob);
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(x + 1, Math.round(a.y) - 1, SPRITE_W - 2, 2);
    g.drawImage(spr, x, y);
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
    for (const a of this.actors.values()) {
      a.bubble.style.left = `${a.x * s}px`;
      a.bubble.style.top = `${(a.y - SPRITE_H - 5) * s}px`;
      a.bubble.classList.toggle('selected', this.selected === a.id);
      a.tag.style.left = `${a.x * s}px`;
      a.tag.style.top = `${(a.y + 2) * s}px`;
    }
  }
}
