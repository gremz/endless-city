import { vec3, type Vec3 } from '../core/math';
import type { Brush } from '../physics/brush';
import { BRUSH_STRIDE, NAV_PATCH_STRIDE, PIECE_STRIDE, PieceKind, wordContents, type ChunkData, type PieceKindId } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import type { Simulation } from './Simulation';

/** Panes within this distance of an HE blast shatter. */
export const BLAST_GLASS_RADIUS = 6;
/** An HE this close to a breachable plug blows it out (point blank only). */
export const HE_BREACH_RADIUS = 1;

/** A piece's id in saves and on the wire: its chunk and its brush index there. */
export type PieceRef = [chunkKey: number, index: number];

export interface Piece {
  chunkKey: number;
  /** Brush index in the chunk. */
  index: number;
  kind: PieceKindId;
  brush: Brush;
  /** Nav patch records [lo, hi) in the chunk's navPatch. */
  patchLo: number;
  patchHi: number;
}

interface ResidentChunk {
  data: ChunkData;
  byIndex: Map<number, Piece>;
}

const keyOf = (chunkKey: number, index: number) => `${chunkKey}:${index}`;

/**
 * Chunk pieces: parts of the city that stay destroyed (window panes, breachable wall plugs).
 * They are chunk brushes; destroying one clears its contents in place, and the destroyed set is
 * remembered so a reloaded chunk comes back the same. A piece that changes where bots can walk
 * carries a nav patch, applied to the chunk's nav arrays (shared with NavGrid) when it goes.
 * The host (or solo game) decides what breaks; online clients apply the host's breaks.
 */
export class ChunkPieces implements StreamerListener {
  /** Destroyed pieces, "chunkKey:index". */
  private broken = new Set<string>();
  private pieces = new Map<Brush, Piece>();
  private chunks = new Map<number, ResidentChunk>();
  /** Bumped whenever a piece breaks (renderers resync). */
  version = 0;

  constructor(private sim: Simulation) {}

  onChunkLoaded(d: ChunkData): void {
    if (!d.pieces.length) return;
    const brushes = this.sim.world.chunkBrushes(d.key);
    if (!brushes) return;
    const byIndex = new Map<number, Piece>();
    for (let o = 0; o < d.pieces.length; o += PIECE_STRIDE) {
      const index = d.pieces[o + 1];
      const brush = brushes[index];
      if (!brush) continue;
      const piece: Piece = { chunkKey: d.key, index, kind: d.pieces[o] as PieceKindId, brush, patchLo: d.pieces[o + 2], patchHi: d.pieces[o + 3] };
      this.pieces.set(brush, piece);
      byIndex.set(index, piece);
      if (this.broken.has(keyOf(d.key, index))) {
        brush.contents = 0;
        applyPatch(d, piece, true);
      }
    }
    this.chunks.set(d.key, { data: d, byIndex });
  }

  onChunkUnloaded(key: number): void {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const p of c.byIndex.values()) this.pieces.delete(p.brush);
    this.chunks.delete(key);
  }

  onChunkVisibility(): void {}

  isBroken(chunkKey: number, index: number): boolean {
    return this.broken.has(keyOf(chunkKey, index));
  }

  /** The resident piece a brush belongs to, if any. */
  pieceOf(b: Brush): Piece | undefined {
    return this.pieces.get(b);
  }

  /** A bullet or grenade hit a brush: panes break (on the host; predicting clients leave it to the host). */
  hit(b: Brush): void {
    const p = this.pieces.get(b);
    if (!p || p.kind !== PieceKind.Glass || !this.authoritative) return;
    this.breakPiece(p.chunkKey, p.index, true);
  }

  /** Destroy every standing piece of `kind` within `radius` of a point (explosions). */
  breakNear(pos: Vec3, radius: number, kind: PieceKindId): void {
    if (!this.authoritative) return;
    for (const [b, p] of this.pieces) {
      if (p.kind !== kind || !b.contents) continue;
      const x = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const y = Math.max(b.minY, Math.min(pos.y, b.maxY));
      const z = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      if (Math.hypot(x - pos.x, y - pos.y, z - pos.z) < radius) this.breakPiece(p.chunkKey, p.index, true);
    }
  }

  /** Destroy a piece. `announce` emits the event and noise (the host); replicas apply silently. */
  breakPiece(chunkKey: number, index: number, announce: boolean): void {
    const key = keyOf(chunkKey, index);
    if (this.broken.has(key)) return;
    this.broken.add(key);
    this.version++;
    const c = this.chunks.get(chunkKey);
    const p = c?.byIndex.get(index);
    if (!c || !p) return;
    p.brush.contents = 0;
    applyPatch(c.data, p, true);
    if (!announce) return;
    const b = p.brush;
    const pos = vec3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    this.sim.events.push({ type: 'piece_break', chunkKey, index, kind: p.kind, pos });
    if (p.kind === PieceKind.Glass) this.sim.events.push({ type: 'sound', pos, radius: 30, kind: 'glass', sourceId: -1 });
  }

  /** Destroyed pieces, for saves and the host's world state. */
  list(): PieceRef[] {
    return [...this.broken].map((k) => k.split(':').map(Number) as PieceRef);
  }

  /** Add to the destroyed set (loading a save, or a client applying the host's state). */
  restore(list: readonly PieceRef[]): void {
    for (const [k, i] of list) this.breakPiece(k, i, false);
  }

  /** Remember nothing (a new game): resident pieces stand again. */
  reset(): void {
    for (const c of this.chunks.values()) {
      for (const p of c.byIndex.values()) {
        if (!this.broken.has(keyOf(p.chunkKey, p.index))) continue;
        p.brush.contents = wordContents(c.data.brushes[p.index * BRUSH_STRIDE + 6]);
        applyPatch(c.data, p, false);
      }
    }
    this.broken.clear();
    this.version++;
  }

  private get authoritative(): boolean {
    return !this.sim.predicting && !this.sim.replica;
  }
}

/** Write a piece's nav patch into the chunk's nav arrays: `open` = the piece is gone. */
function applyPatch(d: ChunkData, p: Piece, open: boolean): void {
  const flagAt = open ? 3 : 1;
  for (let r = p.patchLo; r < p.patchHi; r++) {
    const o = r * NAV_PATCH_STRIDE;
    const span = d.navPatch[o];
    d.navFlags[span] = d.navPatch[o + flagAt];
    d.navCover[span] = d.navPatch[o + flagAt + 1];
  }
}
