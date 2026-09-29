import { CHUNK } from '../../core/config';
import { vec3, type Vec3 } from '../../core/math';
import type { CollisionWorld } from '../../physics/CollisionWorld';
import { MASK_PLAYER } from '../../physics/brush';
import { makeTrace } from '../../physics/trace';
import { worldToChunk } from '../../world/chunkMath';

/**
 * The pedestrians' walking graph. Every city chunk has the same sidewalk ring (streets.ts: road
 * 0–4 m in from the chunk edge, sidewalk 4–6 m), so the graph is a lattice of sidewalk corners:
 * corner (ix, iz) is at world (cornerCoord(ix), cornerCoord(iz)). Two corners of the same chunk
 * are joined along its sidewalk (53 m); two corners of neighbouring chunks by a crossing over the
 * road between them (11 m). Nothing is baked: an edge is probed against the collision world the
 * first time someone wants to walk it (probeEdge), which leaves out rivers, highway ramps and
 * anything else that isn't plain sidewalk.
 */

/** The walking line, in from each chunk edge: between the lamp posts (5 m) and the lots (6 m), clear of curb-parked cars (4.6 m). */
export const WALK_INSET = 5.5;
/** Ring edge and crossing lengths. */
export const RING_LEN = CHUNK - 2 * WALK_INSET;
export const CROSS_LEN = 2 * WALK_INSET;
/** Floor samples along an edge (m apart). */
const SAMPLE = 0.5;
/** A walkable floor is street level: road (0) or sidewalk (curb height). */
const FLOOR_LO = -0.4;
const FLOOR_HI = 0.6;
/** Largest height change between samples (a curb, not a drop). */
const MAX_STEP = 0.45;
/** Body box for clearance checks: above anything a pedestrian could step over. */
export const BODY_MINS = vec3(-0.2, 0.65, -0.2);
export const BODY_MAXS = vec3(0.2, 1.75, 0.2);

export const Axis = { X: 0, Z: 1 } as const;
export type AxisId = (typeof Axis)[keyof typeof Axis];

/** World coordinate of lattice index i (even: a chunk's low corner, odd: its high corner). */
export function cornerCoord(i: number): number {
  const c = Math.floor(i / 2);
  return c * CHUNK + (i - 2 * c === 0 ? WALK_INSET : CHUNK - WALK_INSET);
}

/** Whether the edge from lattice index i to i + 1 is a crossing (over a road) rather than a sidewalk. */
export const isCrossing = (i: number) => (i & 1) === 1;

/** A probed edge from corner (ix, iz) to the next corner along `axis`. */
export interface Edge {
  ix: number;
  iz: number;
  axis: AxisId;
  len: number;
  /** Floor height every SAMPLE m from the low end. */
  heights: Float32Array;
}

const BIAS = 1 << 15;
/** Map key of the edge leaving corner (ix, iz) towards +axis. */
export const edgeKey = (ix: number, iz: number, axis: AxisId) => (((ix + BIAS) * 65536 + (iz + BIAS)) * 2 + axis);

/** Low and high end of an edge (world x, z). */
export function edgeEnds(ix: number, iz: number, axis: AxisId): [number, number, number, number] {
  const ax = cornerCoord(ix);
  const az = cornerCoord(iz);
  return axis === Axis.X ? [ax, az, cornerCoord(ix + 1), az] : [ax, az, ax, cornerCoord(iz + 1)];
}

/** The chunks an edge runs through (one for a sidewalk, two for a crossing). */
export function edgeChunks(ix: number, iz: number, axis: AxisId): [number, number, number, number] {
  const [ax, az, bx, bz] = edgeEnds(ix, iz, axis);
  return [worldToChunk(ax), worldToChunk(az), worldToChunk(bx), worldToChunk(bz)];
}

/** Floor height at distance t from the edge's low end. */
export function heightAt(e: Edge, t: number): number {
  const h = e.heights;
  const f = Math.max(0, Math.min(h.length - 1, t / SAMPLE));
  const i = Math.floor(f);
  const j = Math.min(h.length - 1, i + 1);
  return h[i] + (h[j] - h[i]) * (f - i);
}

const tr = makeTrace();
const from = vec3(0, 0, 0);
const to = vec3(0, 0, 0);

/**
 * Probe an edge against the collision world: street-level floor all along it, no step bigger
 * than a curb, and nothing body-high in the way. Undefined when its chunks aren't loaded (ask
 * again later), null when it can't be walked.
 */
export function probeEdge(world: CollisionWorld, loaded: (cx: number, cz: number) => boolean, ix: number, iz: number, axis: AxisId): Edge | null | undefined {
  const [ax, az, bx, bz] = edgeEnds(ix, iz, axis);
  if (!loaded(worldToChunk(ax), worldToChunk(az)) || !loaded(worldToChunk(bx), worldToChunk(bz))) return undefined;
  const len = Math.abs(bx - ax) + Math.abs(bz - az);
  const n = Math.ceil(len / SAMPLE) + 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(len, i * SAMPLE) / len;
    from.x = to.x = ax + (bx - ax) * t;
    from.z = to.z = az + (bz - az) * t;
    from.y = 1.2;
    to.y = -1.5;
    world.traceRay(tr, from, to, MASK_PLAYER);
    if (tr.startSolid || tr.fraction >= 1) return null;
    const y = tr.endY;
    if (y < FLOOR_LO || y > FLOOR_HI) return null;
    if (i > 0 && Math.abs(y - heights[i - 1]) > MAX_STEP) return null;
    heights[i] = y;
  }
  if (!clearPath(world, ax, az, bx, bz)) return null;
  return { ix, iz, axis, len, heights };
}

/** Nothing body-high between two street-level points. */
export function clearPath(world: CollisionWorld, ax: number, az: number, bx: number, bz: number): boolean {
  from.x = ax;
  from.y = 0;
  from.z = az;
  to.x = bx;
  to.y = 0;
  to.z = bz;
  world.traceBox(tr, from, to, BODY_MINS, BODY_MAXS, MASK_PLAYER);
  return !tr.startSolid && tr.fraction >= 1;
}

/** World position of corner (ix, iz). */
export function cornerPos(ix: number, iz: number, y = 0): Vec3 {
  return vec3(cornerCoord(ix), y, cornerCoord(iz));
}
