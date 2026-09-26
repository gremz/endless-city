import { CHUNK } from '../core/config';
import { vec3, type Vec3 } from '../core/math';
import { MASK_PLAYER, MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { STAND_MAXS, STAND_MINS } from '../player/movementConfig';
import type { Simulation } from '../sim/Simulation';
import { NAV_CELL, NAV_RES, NavFlag, type ChunkData } from '../world/gen/ChunkData';
import { spanColumns } from '../world/gen/navBake';

const MIN_DIST = 25;
const MAX_DIST = 58;
const BEST_DIST = 45;
/** Straight ahead is the plaza's fountain: prefer a little off to one side. */
const OFF_CENTER = (8 * Math.PI) / 180;
/** Half-angle of the cone ahead of the drop-in point, then the wider fallback. */
const CONES = [35, 60].map((d) => (d * Math.PI) / 180);
/** Squad-mates stand this far from each other, and at most GROUP from the first one. */
const SPACING = 2.5;
const GROUP = 6;
/** Ground-level spots only: a floor within this of the drop-in floor. */
const MAX_RISE = 3;
const MAX_TRACES = 600;

interface Candidate {
  pos: Vec3;
  score: number;
}

/**
 * Spots for the opening ambush in chunk `d`: outdoors, 25–58 m ahead of `eye` (the drop-in
 * point, facing +Z) but off the centre line, in plain view of it, off the road, near cover and
 * close together. Falls back to a wider cone, then to the chunk's ordinary spawn slots.
 * Returns up to `count` floor positions.
 */
export function pickAmbushSlots(sim: Simulation, d: ChunkData, eye: Vec3, count: number): Vec3[] {
  for (const cone of CONES) {
    const slots = pickInCone(sim, d, eye, count, cone);
    if (slots.length >= Math.min(count, 2)) return slots;
  }
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < d.spawns.length && out.length < count; i += 3) out.push(vec3(d.spawns[i], d.spawns[i + 1], d.spawns[i + 2]));
  return out;
}

function pickInCone(sim: Simulation, d: ChunkData, eye: Vec3, count: number, cone: number): Vec3[] {
  const N = NAV_RES;
  const ox = d.cx * CHUNK;
  const oz = d.cz * CHUNK;
  const spanCol = spanColumns(d.navCol);
  const floorY = eye.y - 1.6;
  const cands: Candidate[] = [];
  for (let s = 0; s < d.navFloor.length; s++) {
    const f = d.navFlags[s];
    if (!(f & NavFlag.Walkable) || !(f & NavFlag.Reachable) || f & (NavFlag.Water | NavFlag.Indoor)) continue;
    const c = spanCol[s];
    const i = c % N;
    const j = (c - i) / N;
    // Every other cell is plenty, and keeps the trace budget for the good ones.
    if ((i | j) & 1) continue;
    const x = ox + (i + 0.5) * NAV_CELL;
    const z = oz + (j + 0.5) * NAV_CELL;
    const y = d.navFloor[s] / 100;
    if (Math.abs(y - floorY) > MAX_RISE) continue;
    const dx = x - eye.x;
    const dz = z - eye.z;
    const dist = Math.hypot(dx, dz);
    if (dist < MIN_DIST || dist > MAX_DIST) continue;
    const ang = Math.abs(Math.atan2(dx, dz));
    if (ang > cone) continue;
    let score = 1 - Math.abs(dist - BEST_DIST) / 15 - ang / cone - Math.max(0, OFF_CENTER - ang) / OFF_CENTER;
    if (f & (NavFlag.CoverHalf | NavFlag.CoverFull)) score += 0.5;
    // Loitering on the sidewalk or in a lot reads better than standing in the road.
    if (f & NavFlag.Street) score -= 0.4;
    cands.push({ pos: vec3(x, y + 0.02, z), score });
  }
  cands.sort((a, b) => b.score - a.score);

  const tr = makeTrace();
  let traces = 0;
  const target = vec3();
  // Head, chest and both shoulders: the whole figure in view, not a sliver past a post.
  const probes = [
    [0, 1.65],
    [0, 1.2],
    [-0.35, 1.3],
    [0.35, 1.3],
  ];
  const visible = (p: Vec3): boolean => {
    const dx = p.x - eye.x;
    const dz = p.z - eye.z;
    const l = Math.hypot(dx, dz) || 1;
    for (const [side, h] of probes) {
      traces++;
      target.x = p.x + (dz / l) * side;
      target.y = p.y + h;
      target.z = p.z - (dx / l) * side;
      sim.world.traceRay(tr, eye, target, MASK_SHOT);
      if (tr.fraction < 0.999) return false;
    }
    return true;
  };

  // Best visible spot first, then mates around it; if it has none, try the next spot.
  let best: Vec3[] = [];
  for (const first of cands) {
    if (traces >= MAX_TRACES) break;
    if (!visible(first.pos)) continue;
    const group = [first.pos];
    for (const c of cands) {
      if (group.length >= count || traces >= MAX_TRACES) break;
      if (Math.hypot(c.pos.x - first.pos.x, c.pos.z - first.pos.z) > GROUP) continue;
      if (group.some((p) => Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < SPACING)) continue;
      if (visible(c.pos)) group.push(c.pos);
    }
    if (group.length > best.length) best = group;
    if (best.length >= count) break;
  }
  return best;
}

/** The hostage kneels this far beyond the gunman, and at least this far from anyone else. */
const HOSTAGE_DIST = 1.5;
const HOSTAGE_CLEAR = 1.2;
/** Turns off the straight-out line to try, in order: never so far the gunman faces the plaza. */
const HOSTAGE_TURNS = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100].map((d) => (d * Math.PI) / 180);

/**
 * Where the opening's hostage kneels: just beyond `gunman` on the line out from `eye` (so the
 * gunman has his back to the drop-in point) or else beside him, on the same floor, with room to stand up, in view
 * of `eye` and with a clear line from the gunman's gun. Null if there's nowhere like that.
 */
export function pickHostageSpot(sim: Simulation, eye: Vec3, gunman: Vec3, others: readonly Vec3[]): Vec3 | null {
  const out = Math.atan2(gunman.x - eye.x, gunman.z - eye.z);
  const tr = makeTrace();
  const pos = vec3();
  const from = vec3();
  for (const turn of HOSTAGE_TURNS) {
    const x = gunman.x + Math.sin(out + turn) * HOSTAGE_DIST;
    const z = gunman.z + Math.cos(out + turn) * HOSTAGE_DIST;
    if (others.some((o) => Math.hypot(o.x - x, o.z - z) < HOSTAGE_CLEAR)) continue;
    const y = sim.findFloor(x, z, gunman.y + 1);
    if (Math.abs(y - gunman.y) > 0.4) continue;
    pos.x = x;
    pos.y = y + 0.02;
    pos.z = z;
    if (sim.world.testBox(tr, pos, STAND_MINS, STAND_MAXS, MASK_PLAYER)) continue;
    // Chest and head, kneeling, from the drop-in point (not just a head over a low wall)...
    sim.world.traceRay(tr, eye, vec3(x, y + 0.6, z), MASK_SHOT);
    if (tr.fraction < 0.999) continue;
    const head = vec3(x, y + 1.0, z);
    sim.world.traceRay(tr, eye, head, MASK_SHOT);
    if (tr.fraction < 0.999) continue;
    // ...and from the gunman's gun.
    from.x = gunman.x;
    from.y = gunman.y + 1.5;
    from.z = gunman.z;
    sim.world.traceRay(tr, from, head, MASK_SHOT);
    if (tr.fraction < 0.999) continue;
    return vec3(x, pos.y, z);
  }
  return null;
}
