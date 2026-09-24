import { chunkKey } from '../../world/chunkMath';
import { NAV_CELL, NAV_RES, type ChunkData } from '../../world/gen/ChunkData';
import { NAV_LINK_STRIDE, NAV_STEP, spanColumns } from '../../world/gen/navBake';
import type { StreamerListener } from '../../world/WorldStreamer';

/** One resident chunk's layered nav (see navBake.ts). Span ids are chunk-local. */
export interface NavChunk {
  cx: number;
  cz: number;
  col: Uint16Array;
  floor: Int16Array;
  flags: Uint8Array;
  cover: Uint8Array;
  /** Column of each span. */
  spanCol: Uint16Array;
  /** Ladder link records (NAV_LINK_STRIDE floats), and link record indices by from-span. */
  links: Float32Array;
  linksFrom: Map<number, number[]>;
}

function linkIndex(links: Float32Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let k = 0; k * NAV_LINK_STRIDE < links.length; k++) {
    const from = links[k * NAV_LINK_STRIDE];
    const list = out.get(from);
    if (list) list.push(k);
    else out.set(from, [k]);
  }
  return out;
}

/** Global cell index for a world coordinate. */
export const toCell = (v: number) => Math.floor(v / NAV_CELL);
export const cellCenter = (c: number) => (c + 0.5) * NAV_CELL;

/** How far above a floor something can be and still count as standing on it. */
const STAND = 0.6;

/**
 * Seamless view over the layered nav of all resident chunks, addressed by global cell
 * coordinates (0.5 m) plus a height, since a column can hold several floors (street, upper
 * storeys, roofs). Unloaded cells read as unwalkable.
 *
 * Queries fill `qSpan`/`qFloor`/`qFlags`/`qCover`/`qChunk` instead of allocating.
 */
export class NavGrid implements StreamerListener {
  private chunks = new Map<number, NavChunk>();
  private lastKey = -1;
  private last: NavChunk | undefined;

  qChunk: NavChunk | undefined;
  qSpan = -1;
  qFloor = NaN;
  qFlags = 0;
  qCover = 0;

  onChunkLoaded(d: ChunkData): void {
    if (!d.navCol.length) return;
    this.chunks.set(d.key, {
      cx: d.cx,
      cz: d.cz,
      col: d.navCol,
      floor: d.navFloor,
      flags: d.navFlags,
      cover: d.navCover,
      spanCol: spanColumns(d.navCol),
      links: d.navLinks,
      linksFrom: linkIndex(d.navLinks),
    });
    this.lastKey = -1;
  }

  onChunkUnloaded(key: number): void {
    this.chunks.delete(key);
    this.lastKey = -1;
  }

  onChunkVisibility(): void {}

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  chunkByCoord(cx: number, cz: number): NavChunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** The chunk holding global cell (gx, gz). */
  chunkAt(gx: number, gz: number): NavChunk | undefined {
    const cx = Math.floor(gx / NAV_RES);
    const cz = Math.floor(gz / NAV_RES);
    const key = chunkKey(cx, cz);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.last = this.chunks.get(key);
    }
    return this.last;
  }

  /** Chunk-local column index of global cell (gx, gz). */
  local(gx: number, gz: number): number {
    const i = gx - Math.floor(gx / NAV_RES) * NAV_RES;
    const j = gz - Math.floor(gz / NAV_RES) * NAV_RES;
    return j * NAV_RES + i;
  }

  private fill(c: NavChunk | undefined, s: number): boolean {
    this.qChunk = c;
    this.qSpan = s;
    if (s < 0 || !c) {
      this.qFloor = NaN;
      this.qFlags = 0;
      this.qCover = 0;
      return false;
    }
    this.qFloor = c.floor[s] / 100;
    this.qFlags = c.flags[s];
    this.qCover = c.cover[s];
    return true;
  }

  /** Select the span in column (gx, gz) whose floor is nearest `y`, within `tol` meters. */
  near(gx: number, gz: number, y: number, tol = NAV_STEP): boolean {
    const c = this.chunkAt(gx, gz);
    if (!c) return this.fill(c, -1);
    const l = this.local(gx, gz);
    let best = -1;
    let bestD = tol * 100 + 1e-6;
    const ycm = y * 100;
    for (let s = c.col[l], e = c.col[l + 1]; s < e; s++) {
      const d = Math.abs(c.floor[s] - ycm);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return this.fill(c, best);
  }

  /** Select the span something at height `y` stands on: the highest floor not far above y. */
  under(gx: number, gz: number, y: number): boolean {
    const c = this.chunkAt(gx, gz);
    if (!c) return this.fill(c, -1);
    const l = this.local(gx, gz);
    let best = -1;
    const lim = (y + STAND) * 100;
    for (let s = c.col[l], e = c.col[l + 1]; s < e && c.floor[s] <= lim; s++) best = s;
    return this.fill(c, best);
  }

  /** Floor (m) of the span in (gx, gz) within a step of `from`, or NaN. */
  stepFloor(gx: number, gz: number, from: number): number {
    this.near(gx, gz, from);
    return this.qFloor;
  }

  /**
   * Nearest walkable cell to (x, z) within a small radius whose floor is within `tol` of y:
   * [gx, gz, floor] or null.
   */
  nearestWalkable(x: number, y: number, z: number, radiusCells = 6, tol = 1.2): [number, number, number] | null {
    const gx = toCell(x);
    const gz = toCell(z);
    let best: [number, number, number] | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= radiusCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!this.near(gx + dx, gz + dz, y, tol)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = [gx + dx, gz + dz, this.qFloor];
          }
        }
      }
      if (best) return best;
    }
    return best;
  }
}
