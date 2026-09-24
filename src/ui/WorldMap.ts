import { CHUNK } from '../core/config';
import { chunkKey, keyToCoords, worldToChunk } from '../world/chunkMath';
import { District, DISTRICT_NAMES, type ChunkData } from '../world/gen/ChunkData';
import { districtFor } from '../world/gen/district';
import { LOT0 } from '../world/gen/streets';
import type { StreamerListener } from '../world/WorldStreamer';
import { el } from './dom';
import { drawStash } from './Minimap';
import { drawChunkTopdown } from './minimapRaster';

/** Resolution of the cached per-chunk bitmaps (px per meter). */
const BITMAP_PX = 2;
/** Most chunk bitmaps kept; older ones fall back to flat district blocks. */
const MAX_BITMAPS = 400;
const MIN_SCALE = 0.35;
const MAX_SCALE = 6;
const ZONE = '#5dff7a';
const HOSTILE = '#ffc46a';
const ACTIVE = '#ff6a5a';

const DISTRICT_COLORS: Record<number, string> = {
  [District.Spawn]: '#6aa06a',
  [District.Industrial]: '#6f7c8a',
  [District.Oldtown]: '#a07e5c',
  [District.Downtown]: '#8c8fb4',
  [District.Gym]: '#888888',
};

export interface WorldMapView {
  x: number;
  z: number;
  yaw: number;
  spawnCx: number;
  spawnCz: number;
  /** Cleared chunk keys (buy zones). */
  cleared: ReadonlySet<number>;
  /** Encounter areas the player has come across. */
  encounters: { cx: number; cz: number; level: number; cleared: boolean; active: boolean }[];
  stash: { x: number; z: number } | null;
}

export interface WorldMapOptions {
  seed: number;
  /** Danger level of a chunk. */
  levelAt(cx: number, cz: number): number;
  /** Levels are forced (no rings). */
  fixedLevel: boolean;
  onClose(): void;
}

/**
 * Full-screen city map (M): the whole known city as blocks coloured by district, with the
 * explored ones drawn in detail, danger rings around the origin, buy zones, hostile areas,
 * spawn, the death stash and the player. Drag to pan, scroll to zoom.
 */
export class WorldMap implements StreamerListener {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private info: HTMLDivElement;
  private hover: HTMLDivElement;
  private status: HTMLDivElement;
  /** Chunks the player has seen (were loaded and visible). */
  readonly explored = new Set<number>();
  private bitmaps = new Map<number, HTMLCanvasElement>();
  private districts = new Map<number, number>();
  private view: WorldMapView | null = null;
  private cx = 0;
  private cz = 0;
  private scale = 1.2;
  private dpr = 1;
  private raf = 0;
  private drag: { x: number; y: number } | null = null;
  private mouse: { x: number; y: number } | null = null;

  constructor(
    parent: HTMLElement,
    private opts: WorldMapOptions,
  ) {
    this.canvas = el('canvas.worldmap-canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.info = el('div.worldmap-info');
    this.hover = el('div.worldmap-hover');
    this.status = el('div.worldmap-status');
    const centerBtn = el('button.btn', { text: 'Center on me (C)' });
    const closeBtn = el('button.btn.primary', { text: 'Close (M)' });
    centerBtn.addEventListener('click', () => this.recenter());
    closeBtn.addEventListener('click', () => opts.onClose());
    const legend = el(
      'div.worldmap-legend',
      {},
      [
        ...[District.Oldtown, District.Downtown, District.Industrial].map((d) =>
          el('div', {}, [el('span.swatch', { style: `background:${DISTRICT_COLORS[d]}` }), DISTRICT_NAMES[d]]),
        ),
        el('div', {}, [el('span.swatch.zone'), 'Buy zone (cleared)']),
        el('div', {}, [el('span.swatch.hostile'), 'Hostile area']),
        el('div', {}, [el('span.swatch.stash'), 'Your dropped gear']),
        el('div', {}, [el('span.swatch.ring'), 'Danger level ring']),
      ],
    );
    const panel = el('div.worldmap-panel', {}, [
      el('div.worldmap-title', { text: 'CITY MAP' }),
      this.info,
      this.hover,
      legend,
      el('div.worldmap-buttons', {}, [centerBtn, closeBtn]),
      this.status,
      el('div.worldmap-help', { text: 'Drag to pan · scroll to zoom' }),
    ]);
    this.root = el('div.worldmap', {}, [this.canvas, panel]);
    this.root.hidden = true;
    parent.append(this.root);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.drag) {
        this.cx -= (e.clientX - this.drag.x) / this.scale;
        this.cz -= (e.clientY - this.drag.y) / this.scale;
        this.drag = { x: e.clientX, y: e.clientY };
      }
      this.updateHover();
      this.requestDraw();
    });
    const endDrag = () => {
      this.drag = null;
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.updateHover();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Zoom around the cursor: the point under it stays put.
        const [wx, wz] = this.toWorld(e.clientX, e.clientY);
        this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * Math.exp(-e.deltaY * 0.0015)));
        const [nx, nz] = this.toWorld(e.clientX, e.clientY);
        this.cx += wx - nx;
        this.cz += wz - nz;
        this.requestDraw();
      },
      { passive: false },
    );
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  // ---- StreamerListener ----

  onChunkLoaded(data: ChunkData, visible: boolean): void {
    const bmp = document.createElement('canvas');
    bmp.width = bmp.height = CHUNK * BITMAP_PX;
    drawChunkTopdown(bmp.getContext('2d')!, data, BITMAP_PX, 0, 0);
    this.bitmaps.delete(data.key);
    this.bitmaps.set(data.key, bmp);
    if (this.bitmaps.size > MAX_BITMAPS) this.bitmaps.delete(this.bitmaps.keys().next().value!);
    if (visible) this.explored.add(data.key);
  }

  onChunkUnloaded(): void {}

  onChunkVisibility(key: number, visible: boolean): void {
    if (visible) this.explored.add(key);
  }

  // ---- open / close ----

  show(view: WorldMapView): void {
    this.view = view;
    this.root.hidden = false;
    this.status.textContent = '';
    this.recenter();
    this.updateInfo();
  }

  hide(): void {
    this.root.hidden = true;
    this.drag = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  recenter(): void {
    if (!this.view) return;
    this.cx = this.view.x;
    this.cz = this.view.z;
    this.requestDraw();
  }

  exploredKeys(): number[] {
    return [...this.explored];
  }

  restoreExplored(keys: readonly number[]): void {
    for (const k of keys) this.explored.add(k);
  }

  private districtOf(cx: number, cz: number): number {
    const key = chunkKey(cx, cz);
    let d = this.districts.get(key);
    if (d === undefined) {
      d = districtFor(this.opts.seed, cx, cz).id;
      if (this.districts.size > 20000) this.districts.clear();
      this.districts.set(key, d);
    }
    return d;
  }

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [this.cx + (clientX - r.left - r.width / 2) / this.scale, this.cz + (clientY - r.top - r.height / 2) / this.scale];
  }

  private updateInfo(): void {
    const v = this.view;
    if (!v) return;
    const pcx = worldToChunk(v.x);
    const pcz = worldToChunk(v.z);
    const spawnX = v.spawnCx * CHUNK + 32;
    const spawnZ = v.spawnCz * CHUNK + 22;
    const dist = Math.hypot(v.x - spawnX, v.z - spawnZ);
    const rows: [string, string][] = [
      ['Block', `${pcx}, ${pcz}`],
      ['District', DISTRICT_NAMES[this.districtOf(pcx, pcz)]],
      ['Danger', `Level ${this.opts.levelAt(pcx, pcz)}`],
      ['From spawn', dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(2)} km`],
      ['Areas cleared', `${v.cleared.size}`],
      ['Blocks explored', `${this.explored.size}`],
    ];
    this.info.replaceChildren(...rows.map(([k, val]) => el('div.worldmap-row', {}, [el('span', { text: k }), el('b', { text: val })])));
  }

  private updateHover(): void {
    const v = this.view;
    if (!v || !this.mouse) {
      this.hover.textContent = '';
      return;
    }
    const [wx, wz] = this.toWorld(this.mouse.x, this.mouse.y);
    const cx = worldToChunk(wx);
    const cz = worldToChunk(wz);
    const key = chunkKey(cx, cz);
    const enc = v.encounters.find((e) => e.cx === cx && e.cz === cz);
    const status =
      cx === v.spawnCx && cz === v.spawnCz
        ? 'spawn'
        : v.cleared.has(key)
          ? 'cleared'
          : enc
            ? 'hostile'
            : this.explored.has(key)
              ? 'explored'
              : 'unexplored';
    this.hover.textContent = `Cursor: ${DISTRICT_NAMES[this.districtOf(cx, cz)]} · level ${this.opts.levelAt(cx, cz)} · ${status}`;
  }

  private requestDraw(): void {
    if (this.raf || !this.open) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const v = this.view;
    if (!v) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr) || dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    const s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#23262a'; // streets
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // World space in CSS pixels: origin at the view center.
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cw / 2 - this.cx * s), dpr * (ch / 2 - this.cz * s));
    const halfW = cw / 2 / s;
    const halfH = ch / 2 / s;
    const x0 = worldToChunk(this.cx - halfW);
    const x1 = worldToChunk(this.cx + halfW);
    const z0 = worldToChunk(this.cz - halfH);
    const z1 = worldToChunk(this.cz + halfH);
    const inner = CHUNK - LOT0 * 2;
    ctx.imageSmoothingEnabled = s < BITMAP_PX;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = chunkKey(cx, cz);
        const explored = this.explored.has(key);
        const bmp = explored ? this.bitmaps.get(key) : undefined;
        if (bmp) {
          ctx.globalAlpha = 1;
          ctx.drawImage(bmp, cx * CHUNK, cz * CHUNK, CHUNK, CHUNK);
          continue;
        }
        ctx.globalAlpha = explored ? 0.8 : 0.3;
        ctx.fillStyle = DISTRICT_COLORS[this.districtOf(cx, cz)];
        ctx.fillRect(cx * CHUNK + LOT0, cz * CHUNK + LOT0, inner, inner);
      }
    }
    ctx.globalAlpha = 1;

    const px = 1 / s; // one CSS pixel in world meters

    // Danger rings around the origin (level = distance in chunks / 2).
    if (!this.opts.fixedLevel) {
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 5 * px]);
      ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let lv = 1; lv <= 10; lv++) {
        const r = lv * 2 * CHUNK;
        ctx.strokeStyle = `rgba(255, ${170 - lv * 12}, 90, ${0.25 + lv * 0.04})`;
        ctx.beginPath();
        ctx.arc(CHUNK / 2, CHUNK / 2, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`Lv ${lv}`, CHUNK / 2, CHUNK / 2 - r - 2 * px);
      }
      ctx.setLineDash([]);
    }

    // Buy zones: spawn and every cleared area.
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = ZONE;
    ctx.fillStyle = 'rgba(93, 255, 122, 0.18)';
    const zone = (cx: number, cz: number) => {
      ctx.fillRect(cx * CHUNK, cz * CHUNK, CHUNK, CHUNK);
      ctx.strokeRect(cx * CHUNK, cz * CHUNK, CHUNK, CHUNK);
    };
    zone(v.spawnCx, v.spawnCz);
    for (const key of v.cleared) {
      const [cx, cz] = keyToCoords(key);
      zone(cx, cz);
    }

    // Hostile areas the player has come across.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const e of v.encounters) {
      if (e.cleared) continue;
      const color = e.active ? ACTIVE : HOSTILE;
      ctx.fillStyle = e.active ? 'rgba(255, 106, 90, 0.2)' : 'rgba(255, 196, 106, 0.14)';
      ctx.fillRect(e.cx * CHUNK, e.cz * CHUNK, CHUNK, CHUNK);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * px;
      ctx.strokeRect(e.cx * CHUNK, e.cz * CHUNK, CHUNK, CHUNK);
      if (CHUNK * s > 22) {
        ctx.fillStyle = color;
        ctx.font = `700 ${Math.min(22, CHUNK * s * 0.3) * px}px system-ui, sans-serif`;
        ctx.fillText(`⚔${e.level}`, (e.cx + 0.5) * CHUNK, (e.cz + 0.5) * CHUNK);
      }
    }

    // Markers in screen space so they keep their size.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = (wx: number, wz: number): [number, number] => [cw / 2 + (wx - this.cx) * s, ch / 2 + (wz - this.cz) * s];
    const clampToEdge = ([sx, sy]: [number, number]): [number, number] => [
      Math.max(14, Math.min(cw - 14, sx)),
      Math.max(14, Math.min(ch - 14, sy)),
    ];

    const [sx, sy] = toScreen(v.spawnCx * CHUNK + 32, v.spawnCz * CHUNK + 22);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ZONE;
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillText('S', sx, sy + 0.5);

    if (v.stash) {
      const [tx, ty] = clampToEdge(toScreen(v.stash.x, v.stash.z));
      drawStash(ctx, tx, ty, 1.2);
    }

    // Player arrow (pinned to the edge when panned away).
    const [ax, ay] = clampToEdge(toScreen(v.x, v.z));
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-v.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // North and scale bar.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillText('N ↑', cw / 2, 16);
    const steps = [25, 50, 100, 200, 500, 1000, 2000];
    const len = steps.find((m) => m * s >= 90) ?? 2000;
    const bx = 20;
    const by = ch - 24;
    ctx.fillRect(bx, by, len * s, 2);
    ctx.fillRect(bx, by - 5, 2, 7);
    ctx.fillRect(bx + len * s - 2, by - 5, 2, 7);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, bx, by - 6);
  }
}
