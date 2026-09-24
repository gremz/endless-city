import { CHUNK } from '../core/config';
import { keyToCoords } from '../world/chunkMath';
import type { ChunkData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import { el } from './dom';
import { drawChunkTopdown } from './minimapRaster';

/** CSS pixels across the radar. */
const SIZE = 200;
/** CSS pixels per meter on the radar (the radius covers ~60 m). */
const SCALE = 1.6;
/** Resolution of the cached per-chunk bitmaps. */
const BITMAP_PX = 3;
const ZONE = '#5dff7a';

export interface MinimapView {
  x: number;
  z: number;
  yaw: number;
  /** Chunk keys where buying is allowed. */
  buyZones: Iterable<number>;
  showZones: boolean;
  encounters: { cx: number; cz: number; active: boolean }[];
  enemies: { x: number; z: number }[];
  /** Other players (co-op); dead ones are drawn as crosses. */
  allies?: { x: number; z: number; alive: boolean }[];
  /** Items on the ground. */
  pickups: readonly { pos: { x: number; z: number }; item: { kind: string }; stash: boolean }[];
  /** Where the player's death stash lies. */
  stash: { x: number; z: number } | null;
  /** Cars free to drive. */
  cars?: { x: number; z: number; yaw: number }[];
}

const STASH = '#7fd4ff';

/**
 * CS-style radar in the HUD corner: rotates with the view, shows the streamed city top-down,
 * buy zones (with an edge pointer to the nearest one when it's off the radar), uncleared
 * encounter areas, health packs, dropped guns, the death stash (with an edge pointer too) and
 * enemies that are engaging the player.
 */
export class Minimap implements StreamerListener {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chunks = new Map<number, { cx: number; cz: number; bmp: HTMLCanvasElement }>();
  private dpr = 1;

  constructor(parent: HTMLElement) {
    this.canvas = el('canvas.minimap');
    this.ctx = this.canvas.getContext('2d')!;
    parent.append(this.canvas);
    this.resize();
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(SIZE * this.dpr);
  }

  onChunkLoaded(data: ChunkData): void {
    const bmp = document.createElement('canvas');
    bmp.width = bmp.height = CHUNK * BITMAP_PX;
    drawChunkTopdown(bmp.getContext('2d')!, data, BITMAP_PX, 0, 0);
    this.chunks.set(data.key, { cx: data.cx, cz: data.cz, bmp });
  }

  onChunkUnloaded(key: number): void {
    this.chunks.delete(key);
  }

  onChunkVisibility(): void {}

  draw(v: MinimapView): void {
    if (Math.min(2, window.devicePixelRatio || 1) !== this.dpr) this.resize();
    const ctx = this.ctx;
    const c = (SIZE / 2) * this.dpr;
    const scale = SCALE * this.dpr;
    const range = SIZE / 2 / SCALE;
    const cos = Math.cos(v.yaw);
    const sin = Math.sin(v.yaw);
    // World offset from the player -> radar pixels (view direction is up).
    const toScreen = (dx: number, dz: number): [number, number] => [c + (dx * cos - dz * sin) * scale, c + (dx * sin + dz * cos) * scale];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(12, 14, 16, 0.72)';
    ctx.fillRect(0, 0, c * 2, c * 2);

    // World space: meters, rotated so the view direction points up.
    ctx.translate(c, c);
    ctx.scale(scale, scale);
    ctx.rotate(v.yaw);
    ctx.translate(-v.x, -v.z);
    const near = (cx: number, cz: number) =>
      Math.abs((cx + 0.5) * CHUNK - v.x) < range + CHUNK && Math.abs((cz + 0.5) * CHUNK - v.z) < range + CHUNK;

    ctx.globalAlpha = 0.85;
    for (const ch of this.chunks.values()) {
      if (near(ch.cx, ch.cz)) ctx.drawImage(ch.bmp, ch.cx * CHUNK, ch.cz * CHUNK, CHUNK, CHUNK);
    }
    ctx.globalAlpha = 1;

    for (const e of v.encounters) {
      ctx.fillStyle = e.active ? 'rgba(255, 106, 90, 0.22)' : 'rgba(255, 196, 106, 0.14)';
      ctx.fillRect(e.cx * CHUNK, e.cz * CHUNK, CHUNK, CHUNK);
    }

    // Buy zones, and the nearest one for the edge pointer.
    let nearest: [number, number] | null = null;
    let nearestD = Infinity;
    if (v.showZones) {
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = ZONE;
      ctx.fillStyle = 'rgba(93, 255, 122, 0.16)';
      for (const key of v.buyZones) {
        const [cx, cz] = keyToCoords(key);
        const x0 = cx * CHUNK;
        const z0 = cz * CHUNK;
        // Closest point of the zone to the player.
        const px = Math.max(x0, Math.min(x0 + CHUNK, v.x));
        const pz = Math.max(z0, Math.min(z0 + CHUNK, v.z));
        const d = Math.hypot(px - v.x, pz - v.z);
        if (d < nearestD) {
          nearestD = d;
          nearest = [px - v.x, pz - v.z];
        }
        if (!near(cx, cz)) continue;
        ctx.fillRect(x0, z0, CHUNK, CHUNK);
        ctx.strokeRect(x0, z0, CHUNK, CHUNK);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Health packs: small red crosses on a white tile.
    const arm = 3.5 * this.dpr;
    const bar = 1.4 * this.dpr;
    for (const it of v.pickups) {
      const dx = it.pos.x - v.x;
      const dz = it.pos.z - v.z;
      if (it.stash || Math.hypot(dx, dz) > range) continue;
      const [sx, sy] = toScreen(dx, dz);
      if (it.item.kind === 'weapon') {
        // Dropped gun: a small grey dash.
        ctx.fillStyle = 'rgba(210, 210, 200, 0.85)';
        ctx.fillRect(sx - 3 * this.dpr, sy - 0.8 * this.dpr, 6 * this.dpr, 1.6 * this.dpr);
        continue;
      }
      ctx.fillStyle = '#f2f2ee';
      ctx.fillRect(sx - arm - this.dpr, sy - arm - this.dpr, (arm + this.dpr) * 2, (arm + this.dpr) * 2);
      ctx.fillStyle = '#d8262c';
      ctx.fillRect(sx - arm, sy - bar, arm * 2, bar * 2);
      ctx.fillRect(sx - bar, sy - arm, bar * 2, arm * 2);
    }

    // Driveable cars: little yellow cars pointing the way they face.
    for (const car of v.cars ?? []) {
      const dx = car.x - v.x;
      const dz = car.z - v.z;
      if (Math.hypot(dx, dz) > range) continue;
      const [sx, sy] = toScreen(dx, dz);
      const [fx, fy] = toScreen(dx - Math.sin(car.yaw), dz - Math.cos(car.yaw));
      drawCar(ctx, sx, sy, Math.atan2(fy - sy, fx - sx), this.dpr);
    }

    const dot = 3 * this.dpr;
    ctx.fillStyle = '#ff4a3a';
    for (const e of v.enemies) {
      const dx = e.x - v.x;
      const dz = e.z - v.z;
      if (Math.hypot(dx, dz) > range) continue;
      const [sx, sy] = toScreen(dx, dz);
      ctx.beginPath();
      ctx.arc(sx, sy, dot, 0, Math.PI * 2);
      ctx.fill();
    }

    // Teammates: blue dots, pinned to the rim when out of range.
    for (const t of v.allies ?? []) {
      let dx = t.x - v.x;
      let dz = t.z - v.z;
      const l = Math.hypot(dx, dz);
      if (l > range * 0.9) {
        dx = (dx / l) * range * 0.9;
        dz = (dz / l) * range * 0.9;
      }
      const [sx, sy] = toScreen(dx, dz);
      drawAlly(ctx, sx, sy, this.dpr, t.alive);
    }

    // Nearest buy zone off the radar: a "$" on the rim pointing at it.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (nearest && nearestD > range * 0.92) {
      const l = Math.hypot(nearest[0], nearest[1]);
      const [sx, sy] = toScreen((nearest[0] / l) * range * 0.86, (nearest[1] / l) * range * 0.86);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.beginPath();
      ctx.arc(sx, sy, 8 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ZONE;
      ctx.font = `700 ${12 * this.dpr}px system-ui, sans-serif`;
      ctx.fillText('$', sx, sy + 0.5 * this.dpr);
    }

    // Death stash: a bag marker, pinned to the rim when it's off the radar.
    if (v.stash) {
      let dx = v.stash.x - v.x;
      let dz = v.stash.z - v.z;
      const l = Math.hypot(dx, dz);
      if (l > range * 0.86) {
        dx = (dx / l) * range * 0.86;
        dz = (dz / l) * range * 0.86;
      }
      const [sx, sy] = toScreen(dx, dz);
      drawStash(ctx, sx, sy, this.dpr);
    }

    // North marker on the rim.
    const [nx, ny] = toScreen(0, -range * 0.88);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = `700 ${11 * this.dpr}px system-ui, sans-serif`;
    ctx.fillText('N', nx, ny);

    // Player arrow, always pointing up.
    const a = 7 * this.dpr;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = this.dpr;
    ctx.beginPath();
    ctx.moveTo(c, c - a);
    ctx.lineTo(c + a * 0.7, c + a * 0.7);
    ctx.lineTo(c, c + a * 0.3);
    ctx.lineTo(c - a * 0.7, c + a * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export const ALLY = '#5aa9ff';

/** Teammate marker: a blue dot with a dark rim (a cross when they're down). */
export function drawAlly(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, alive: boolean): void {
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 1.5 * k;
  if (!alive) {
    ctx.strokeStyle = ALLY;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(x - 3.5 * k, y - 3.5 * k);
    ctx.lineTo(x + 3.5 * k, y + 3.5 * k);
    ctx.moveTo(x + 3.5 * k, y - 3.5 * k);
    ctx.lineTo(x - 3.5 * k, y + 3.5 * k);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = ALLY;
  ctx.beginPath();
  ctx.arc(x, y, 4 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Car marker (shared with the world map): a yellow body with a dark windshield towards `angle`. */
export function drawCar(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, dpr: number): void {
  const l = 5.5 * dpr;
  const w = 3 * dpr;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(-l - dpr, -w - dpr, (l + dpr) * 2, (w + dpr) * 2);
  ctx.fillStyle = '#ffd24a';
  ctx.fillRect(-l, -w, l * 2, w * 2);
  ctx.fillStyle = '#2a2f36';
  ctx.fillRect(l * 0.2, -w * 0.75, l * 0.35, w * 1.5);
  ctx.restore();
}

/** Death stash marker: a dark disc with a light-blue bag, shared with the world map. */
export function drawStash(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.beginPath();
  ctx.arc(x, y, 8 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = STASH;
  ctx.fillRect(x - 4.5 * k, y - 2.5 * k, 9 * k, 7 * k);
  ctx.strokeStyle = STASH;
  ctx.lineWidth = 1.5 * k;
  ctx.beginPath();
  ctx.arc(x, y - 2.5 * k, 2.5 * k, Math.PI, 0);
  ctx.stroke();
}
