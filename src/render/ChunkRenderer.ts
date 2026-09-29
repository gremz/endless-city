import * as THREE from 'three';
import { CHUNK } from '../core/config';
import type { ChunkData, MeshData } from '../world/gen/ChunkData';
import type { StreamerListener } from '../world/WorldStreamer';
import type { MaterialLibrary } from './materials';

/** GPU geometry for a baked brush mesh. */
export function meshGeometry(m: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3, true));
  geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** A chunk's piece mesh: all of its pieces, and each one's index range. */
interface PieceMesh {
  mesh: THREE.Mesh;
  indices: Uint32Array;
  /** Brush index, first index, index count per piece. */
  ranges: Int32Array;
}

/** What the renderer needs to know about destroyed pieces (sim/Pieces.ts). */
export interface PieceState {
  version: number;
  isBroken(chunkKey: number, index: number): boolean;
}

/**
 * Turns streamed ChunkData into meshes (one per material), positioned at the chunk origin.
 * Pieces that can vanish (breachable plugs) get meshes of their own, which leave out the
 * destroyed ones.
 */
export class ChunkRenderer implements StreamerListener {
  private groups = new Map<number, THREE.Group>();
  private pieces = new Map<number, PieceMesh[]>();
  private piecesVersion = -1;
  readonly root = new THREE.Group();

  constructor(
    private materials: MaterialLibrary,
    private shadows: boolean,
  ) {
    this.root.name = 'chunks';
  }

  get count(): number {
    return this.groups.size;
  }

  get visibleCount(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.visible) n++;
    return n;
  }

  onChunkLoaded(data: ChunkData, visible: boolean): void {
    this.onChunkUnloaded(data.key);
    const group = new THREE.Group();
    group.position.set(data.cx * CHUNK, 0, data.cz * CHUNK);
    group.visible = visible;
    for (const m of data.meshes) {
      const mesh = new THREE.Mesh(meshGeometry(m), this.materials.get(m.material));
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    const pieces: PieceMesh[] = [];
    for (const m of data.pieceMeshes ?? []) {
      const mesh = new THREE.Mesh(meshGeometry(m), this.materials.get(m.material));
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      pieces.push({ mesh, indices: m.indices, ranges: m.pieces ?? new Int32Array(0) });
    }
    if (pieces.length) {
      this.pieces.set(data.key, pieces);
      this.piecesVersion = -1;
    }
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    this.groups.set(data.key, group);
    this.root.add(group);
  }

  onChunkUnloaded(key: number): void {
    const g = this.groups.get(key);
    if (!g) return;
    for (const child of g.children) (child as THREE.Mesh).geometry.dispose();
    this.root.remove(g);
    this.groups.delete(key);
    this.pieces.delete(key);
  }

  /** Drop destroyed pieces from their meshes (cheap when nothing changed). */
  syncPieces(state: PieceState): void {
    if (state.version === this.piecesVersion) return;
    this.piecesVersion = state.version;
    for (const [key, list] of this.pieces) {
      for (const p of list) {
        const keep: number[] = [];
        let total = 0;
        for (let o = 0; o < p.ranges.length; o += 3) {
          if (state.isBroken(key, p.ranges[o])) continue;
          keep.push(o);
          total += p.ranges[o + 2];
        }
        const geo = p.mesh.geometry;
        if (total === geo.index?.count) continue;
        const out = new Uint32Array(total);
        let at = 0;
        for (const o of keep) {
          out.set(p.indices.subarray(p.ranges[o + 1], p.ranges[o + 1] + p.ranges[o + 2]), at);
          at += p.ranges[o + 2];
        }
        geo.setIndex(new THREE.BufferAttribute(out, 1));
        p.mesh.visible = total > 0;
      }
    }
  }

  onChunkVisibility(key: number, visible: boolean): void {
    const g = this.groups.get(key);
    if (g) g.visible = visible;
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const g of this.groups.values()) {
      for (const c of g.children) {
        c.castShadow = on;
        c.receiveShadow = on;
      }
    }
  }

  dispose(): void {
    for (const key of [...this.groups.keys()]) this.onChunkUnloaded(key);
  }
}
