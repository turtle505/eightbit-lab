import type { AgentStatus, EmployeeView, ServerView, Task } from '../../../shared/protocol.ts';
import { COFFEE, COFFEE_COLORS, PLANT, PLANT_COLORS, SPRITE_H, SPRITE_W, characterSprite, paintMap, type Pose } from './sprites.ts';

export const W = 400;
export const H = 240;
const WALL_H = 36;
const ROOM_X = 300; // server room starts here

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

// desks 0-3: 2x2 grid; desk 4: reception desk next to the manager (secretary)
const deskPos = (i: number) => (i === 4 ? { x: 206, y: 196 } : { x: 40 + (i % 2) * 130, y: 92 + Math.floor(i / 2) * 72 });
const seatSpot = (i: number): Spot => ({ x: deskPos(i).x + 30, y: deskPos(i).y + 2 });
const besideSpot = (i: number): Spot => ({ x: deskPos(i).x + 60, y: deskPos(i).y + 16 });
// lounge spots along the top wall, spaced so bubbles don't collide
const coffeeSpot = (i: number): Spot => ({ x: 62 + i * 44, y: 72 });
const rackPos = (i: number) => ({ x: ROOM_X + 12 + (i % 3) * 30, y: 56 + Math.floor(i / 3) * 78 });
const rackSpot = (i: number, k: number): Spot => ({ x: rackPos(i).x + 11 + (k % 2) * 6, y: rackPos(i).y + 60 });

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
  private serverLabels = new Map<string, HTMLDivElement>();
  private t = 0;
  /** true while the game view is hidden: skip drawing, keep state updates */
  paused = false;
  private floor: HTMLCanvasElement;

  constructor(private host: HTMLElement, private overlay: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.className = 'office-canvas';
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.floor = this.paintStatic();
    // defer to the next frame: resizing inside the observer callback re-triggers it ("ResizeObserver loop" warning)
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(host);
    this.resize();

    this.canvas.addEventListener('click', (ev) => {
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

  upsert(v: EmployeeView) {
    let a = this.actors.get(v.id);
    if (!a) {
      const start = coffeeSpot(v.desk);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const tag = document.createElement('div');
      tag.className = 'nametag';
      this.overlay.append(bubble, tag);
      a = { id: v.id, x: start.x, y: start.y, walkPhase: 0, view: v, bubble, tag };
      this.actors.set(v.id, a);
    }
    a.view = v;
    a.bubble.textContent = v.status === 'idle' ? '☕' : v.activity;
    a.bubble.title = v.activity;
    a.bubble.dataset.status = v.status;
    a.tag.textContent = v.name.replace(/^.*"(.*)".*$/, '$1');
  }

  setServers(list: ServerView[]) {
    this.servers = list;
    list.forEach((s, i) => {
      let el = this.serverLabels.get(s.name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rack-label';
        this.overlay.append(el);
        this.serverLabels.set(s.name, el);
      }
      const p = rackPos(i);
      el.textContent = s.name;
      el.title = `${s.type} · ${s.online ? 'online' : 'offline'}\n${s.note}\n${s.gpus.map((g) => `GPU${g.index} ${g.util}% ${g.memUsed}/${g.memTotal}MiB`).join('\n')}`;
      el.dataset.x = String(p.x + 11);
      el.dataset.y = String(p.y + 47);
      el.dataset.online = String(s.online);
    });
  }

  // ---------- static background
  private paintStatic(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    // floor
    for (let y = WALL_H; y < H; y += 8)
      for (let x = 0; x < ROOM_X; x += 16) {
        g.fillStyle = ((x / 16 + y / 8) % 2 === 0) ? '#b98a5a' : '#b0814f';
        g.fillRect(x + ((y / 8) % 2) * 8 - 8, y, 16, 8);
      }
    g.fillStyle = '#9c6d40';
    for (let y = WALL_H; y < H; y += 8) g.fillRect(0, y, ROOM_X, 1);
    // server room floor
    for (let y = WALL_H; y < H; y += 10)
      for (let x = ROOM_X; x < W; x += 10) {
        g.fillStyle = ((x + y) / 10) % 2 === 0 ? '#3b4252' : '#363c4a';
        g.fillRect(x, y, 10, 10);
      }
    // walls
    g.fillStyle = '#e3d9c6';
    g.fillRect(0, 0, ROOM_X, WALL_H);
    g.fillStyle = '#c9bca4';
    g.fillRect(0, WALL_H - 4, ROOM_X, 4);
    g.fillStyle = '#4c566a';
    g.fillRect(ROOM_X, 0, W - ROOM_X, WALL_H);
    g.fillStyle = '#3b4252';
    g.fillRect(ROOM_X, WALL_H - 4, W - ROOM_X, 4);
    // glass divider
    g.fillStyle = 'rgba(170,210,240,0.55)';
    g.fillRect(ROOM_X - 3, WALL_H, 3, H - WALL_H);
    g.fillStyle = '#5e6a7a';
    g.fillRect(ROOM_X - 3, WALL_H, 3, 2);
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
    // poster: protein ribbon
    g.fillStyle = '#2e3440';
    g.fillRect(236, 6, 40, 24);
    const helix = '#ff7b7b';
    for (let i = 0; i < 18; i++) {
      g.fillStyle = i % 6 < 3 ? helix : '#ffd27b';
      g.fillRect(240 + i * 2, 18 + Math.round(Math.sin(i * 0.9) * 5), 2, 2);
    }
    g.fillStyle = '#7bc4ff';
    g.fillRect(242, 26, 10, 2);
    g.fillRect(258, 26, 12, 2);
    // server room sign
    g.fillStyle = '#88c0d0';
    g.fillRect(ROOM_X + 30, 10, 40, 12);
    g.fillStyle = '#2e3440';
    g.fillRect(ROOM_X + 33, 13, 34, 6);
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
    paintMap(g, PLANT, PLANT_COLORS, 284, 40);
    paintMap(g, PLANT, PLANT_COLORS, 6, 220);
    paintMap(g, PLANT, PLANT_COLORS, 284, 220);
    // manager desk ("you")
    g.fillStyle = '#6d4c33';
    g.fillRect(120, 206, 60, 16);
    g.fillStyle = '#5a3d28';
    g.fillRect(120, 220, 60, 3);
    g.fillStyle = '#d9d9d9';
    g.fillRect(140, 200, 20, 7);
    g.fillStyle = '#e8c55a';
    g.fillRect(166, 203, 8, 3);
    // rug under desks
    g.fillStyle = 'rgba(80,110,140,0.18)';
    g.fillRect(24, 80, 262, 150);
    return c;
  }

  private drawDesk(i: number, status: AgentStatus | null) {
    const g = this.g;
    const { x, y } = deskPos(i);
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
  }

  private drawRacks() {
    const g = this.g;
    const list = this.servers.length ? this.servers : [];
    list.forEach((s, i) => {
      const { x, y } = rackPos(i);
      g.fillStyle = '#1f232b';
      g.fillRect(x, y, 22, 46);
      g.fillStyle = '#2b303b';
      for (let k = 0; k < 6; k++) g.fillRect(x + 2, y + 3 + k * 7, 18, 5);
      // LEDs: one per GPU (util → color), or status lights for slurm/offline
      const leds = s.gpus.length ? s.gpus.map((gp) => gp.util) : [s.online ? -1 : -2];
      leds.slice(0, 12).forEach((u, k) => {
        const blink = Math.floor(this.t / (u > 50 ? 4 : 12) + k) % 2 === 0;
        g.fillStyle = u === -2 ? '#bf616a' : u === -1 ? '#a3be8c' : u > 80 ? '#ff6b6b' : u > 30 ? '#ebcb8b' : '#a3be8c';
        if (u >= 0 && u > 5 && !blink) g.fillStyle = '#4c566a';
        g.fillRect(x + 4 + (k % 4) * 4, y + 4 + Math.floor(k / 4) * 7, 2, 2);
      });
      // memory bar
      const mem = s.gpus.reduce((a, b) => a + b.memUsed, 0) / Math.max(1, s.gpus.reduce((a, b) => a + b.memTotal, 0));
      g.fillStyle = '#4c566a';
      g.fillRect(x + 2, y + 42, 18, 2);
      g.fillStyle = '#88c0d0';
      g.fillRect(x + 2, y + 42, Math.round(18 * mem), 2);
    });
    if (!list.length) {
      g.fillStyle = '#4c566a';
      g.fillRect(ROOM_X + 20, 80, 60, 40);
      g.fillStyle = '#d8dee9';
      g.fillRect(ROOM_X + 46, 96, 8, 8);
    }
  }

  private drawWhiteboard() {
    const g = this.g;
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
    if (v.status === 'remote') {
      const m = /🖥️\s*(\S+)에/.exec(v.activity);
      let idx = m ? this.servers.findIndex((s) => s.name === m[1]) : -1;
      if (idx < 0) idx = 0;
      if (this.servers.length) return rackSpot(idx, v.desk);
    }
    if (SEATED.includes(v.status) || (v.status === 'remote' && !this.servers.length)) return seatSpot(v.desk);
    if (BESIDE.includes(v.status)) return besideSpot(v.desk);
    return coffeeSpot(v.desk);
  }

  private tick() {
    if (this.paused) return;
    this.t++;
    const g = this.g;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.floor, 0, 0);
    this.drawWhiteboard();
    this.drawRacks();

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
    const deskStatus = new Map<number, AgentStatus>();
    for (const a of this.actors.values()) {
      const seat = seatSpot(a.view.desk);
      const seated = a.x === seat.x && a.y === seat.y;
      if (seated) deskStatus.set(a.view.desk, a.view.status);
      items.push({ y: a.y + (seated ? -0.5 : 0), draw: () => this.drawActor(a, seated) });
    }
    const desks = new Set([0, 1, 2, 3, ...[...this.actors.values()].map((a) => a.view.desk)]);
    for (const i of desks) {
      const p = deskPos(i);
      items.push({ y: p.y + 2, draw: () => this.drawDesk(i, deskStatus.get(i) ?? null) });
    }
    // the manager (you) behind the manager desk
    items.push({ y: 206, draw: () => this.drawBoss() });
    items.sort((p, q) => p.y - q.y).forEach((it) => it.draw());

    this.layoutOverlay();
  }

  private drawBoss() {
    const spr = characterSprite({ hair: '#2e2e2e', shirt: '#4a4a5a', pants: '#2b2b33', skin: '#f1c27d' }, 'stand', this.t % 240 < 6);
    this.g.drawImage(spr, 150 - SPRITE_W / 2, 206 - SPRITE_H + 4);
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
    for (const el of this.serverLabels.values()) {
      el.style.left = `${Number(el.dataset.x) * s}px`;
      el.style.top = `${Number(el.dataset.y) * s}px`;
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
