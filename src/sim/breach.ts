import type { SimEvent } from '../core/events';
import { anglesToForward, vec3, type Vec3 } from '../core/math';
import { Buttons, type UserCmd } from '../input/UserCmd';
import { MASK_SHOT } from '../physics/brush';
import { makeTrace } from '../physics/trace';
import { BREACH_HIT } from '../weapons/weaponDefs';
import { PieceKind } from '../world/gen/ChunkData';
import { eyePos, type Actor } from './Actor';
import { USE_RANGE } from './Doors';
import { isHealing } from './medkit';
import type { Piece } from './Pieces';
import type { Simulation } from './Simulation';

/** Most breaching charges an actor can carry. */
export const BREACH_MAX = 2;
/** Seconds of holding E to plant a charge. */
export const PLANT_TIME = 1.5;
/** Seconds from a charge going live to the blast. */
export const BREACH_FUSE = 3;
/** Blast radius (damage falls off to nothing at the edge), and damage to a car at the center. */
export const BREACH_RADIUS = 3.5;
const BREACH_CAR_DAMAGE = 150;
/** Panes near the blast shatter. */
const BREACH_GLASS_RADIUS = 4;
/** How far off the wall the charge sits (and the blast starts). */
const STANDOFF = 0.12;

export interface BreachTarget {
  piece: Piece;
  /** Where the look ray meets the plug, and the plug face's normal there. */
  pos: Vec3;
  normal: Vec3;
}

const tr = makeTrace();
const eye = vec3();
const fwd = vec3();
const end = vec3();

/** The standing breachable plug `a` is looking at within reach, or null. */
export function breachTarget(sim: Simulation, a: Actor): BreachTarget | null {
  eyePos(a, eye);
  anglesToForward(fwd, a.yaw, a.pitch);
  end.x = eye.x + fwd.x * USE_RANGE;
  end.y = eye.y + fwd.y * USE_RANGE;
  end.z = eye.z + fwd.z * USE_RANGE;
  sim.world.traceRay(tr, eye, end, MASK_SHOT);
  if (tr.fraction >= 1 || !tr.brush || !tr.brush.contents) return null;
  const piece = sim.pieces.pieceOf(tr.brush);
  if (!piece || piece.kind !== PieceKind.Breach) return null;
  return { piece, pos: vec3(tr.endX, tr.endY, tr.endZ), normal: vec3(tr.normal.x, tr.normal.y, tr.normal.z) };
}

/** 0..1 progress of the charge being planted (0 when not planting). */
export function plantProgress(a: Actor, time: number): number {
  if (a.plantEnd < 0) return 0;
  return Math.min(1, Math.max(0, 1 - (a.plantEnd - time) / PLANT_TIME));
}

const authoritative = (sim: Simulation) => !sim.predicting && !sim.replica;

/**
 * E pressed: start planting a charge on the plug in front of `a`. Returns true if E went to a
 * plug (so it doesn't also pick things up), even when there was nothing to plant.
 */
export function tryPlant(a: Actor, sim: Simulation): boolean {
  const t = breachTarget(sim, a);
  if (!t) return false;
  if (!authoritative(sim) || a.plantEnd >= 0 || isHealing(a)) return true;
  if (a.breachCharges <= 0) {
    sim.events.push({ type: 'message', actorId: a.id, text: 'No breaching charges: buy one' });
    return true;
  }
  if (sim.charges.on(t.piece.chunkKey, t.piece.index)) return true;
  a.plantEnd = sim.time + PLANT_TIME;
  a.plantChunk = t.piece.chunkKey;
  a.plantIndex = t.piece.index;
  // The gun goes down while your hands are busy.
  const w = a.wpn;
  w.nextAttack = Math.max(w.nextAttack, a.plantEnd);
  w.reloadEnd = -1;
  w.scope = 0;
  w.rescopeAt = -1;
  sim.events.push({ type: 'plant', actorId: a.id, phase: 'start' });
  return true;
}

function cancelPlant(a: Actor, sim: Simulation): void {
  a.plantEnd = -1;
  a.wpn.nextAttack = Math.max(sim.time, a.wpn.deployEnd);
  sim.events.push({ type: 'plant', actorId: a.id, phase: 'cancel' });
}

/**
 * Planting, run before the weapon each tick (host): letting go of E, firing, or looking away
 * from the plug cancels it (the charge is kept); holding on for PLANT_TIME puts it on the wall.
 */
export function updatePlant(a: Actor, cmd: UserCmd, sim: Simulation): void {
  if (a.plantEnd < 0) return;
  if (!a.alive || !(cmd.buttons & Buttons.USE) || cmd.pressed & Buttons.ATTACK) {
    cancelPlant(a, sim);
    return;
  }
  const t = breachTarget(sim, a);
  if (!t || t.piece.chunkKey !== a.plantChunk || t.piece.index !== a.plantIndex) {
    cancelPlant(a, sim);
    return;
  }
  if (sim.time < a.plantEnd) return;
  // Someone else finished planting on this plug first: keep the charge.
  if (sim.charges.on(t.piece.chunkKey, t.piece.index)) {
    cancelPlant(a, sim);
    return;
  }
  a.plantEnd = -1;
  a.breachCharges--;
  sim.events.push({ type: 'plant', actorId: a.id, phase: 'done' });
  sim.charges.plant(a, t);
}

export interface Charge {
  id: number;
  /** Who planted it (null for a charge the host told us about). */
  owner: Actor | null;
  pos: Vec3;
  normal: Vec3;
  chunkKey: number;
  index: number;
  detonateAt: number;
  nextBeep: number;
}

/**
 * Live breaching charges. The host (or solo game) counts them down, beeping faster and faster,
 * then blows the plug out and damages everything around; online clients only keep the ones the
 * host announced, to draw them.
 */
export class ChargeSystem {
  readonly active: Charge[] = [];
  private nextId = 1;

  constructor(private sim: Simulation) {}

  /** Whether a live charge is already on this plug. */
  on(chunkKey: number, index: number): boolean {
    return this.active.some((c) => c.chunkKey === chunkKey && c.index === index);
  }

  plant(owner: Actor, t: BreachTarget): void {
    const sim = this.sim;
    const pos = vec3(t.pos.x + t.normal.x * STANDOFF, t.pos.y + t.normal.y * STANDOFF, t.pos.z + t.normal.z * STANDOFF);
    const c: Charge = {
      id: this.nextId++,
      owner,
      pos,
      normal: t.normal,
      chunkKey: t.piece.chunkKey,
      index: t.piece.index,
      detonateAt: sim.time + BREACH_FUSE,
      nextBeep: sim.time,
    };
    this.active.push(c);
    sim.events.push({ type: 'breach_plant', id: c.id, actorId: owner.id, pos, normal: c.normal, chunkKey: c.chunkKey, index: c.index, detonateAt: c.detonateAt });
  }

  /** Online client: show a charge the host planted. */
  addRemote(e: Extract<SimEvent, { type: 'breach_plant' }>): void {
    if (this.active.some((c) => c.id === e.id)) return;
    this.active.push({ id: e.id, owner: null, pos: e.pos, normal: e.normal, chunkKey: e.chunkKey, index: e.index, detonateAt: e.detonateAt, nextBeep: Infinity });
  }

  remove(id: number): void {
    const i = this.active.findIndex((c) => c.id === id);
    if (i >= 0) this.active.splice(i, 1);
  }

  update(): void {
    const sim = this.sim;
    if (!authoritative(sim)) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (sim.time >= c.detonateAt) {
        this.active.splice(i, 1);
        this.detonate(c);
        continue;
      }
      if (sim.time >= c.nextBeep) {
        // Beeps speed up from every half second to a rapid trill.
        const left = (c.detonateAt - sim.time) / BREACH_FUSE;
        c.nextBeep = sim.time + 0.1 + 0.4 * left;
        sim.events.push({ type: 'breach_beep', id: c.id, pos: c.pos });
        sim.events.push({ type: 'sound', pos: c.pos, radius: 10, kind: 'grenade', sourceId: c.owner?.id ?? -1 });
      }
    }
  }

  private detonate(c: Charge): void {
    const sim = this.sim;
    sim.pieces.breakPiece(c.chunkKey, c.index, true);
    if (c.owner) sim.grenades.blast(c.pos, c.owner, BREACH_HIT, BREACH_RADIUS, BREACH_CAR_DAMAGE, BREACH_GLASS_RADIUS);
    sim.events.push({ type: 'breach_detonate', id: c.id, pos: c.pos, normal: c.normal, chunkKey: c.chunkKey });
    sim.events.push({ type: 'sound', pos: c.pos, radius: 60, kind: 'grenade', sourceId: c.owner?.id ?? -1 });
  }

  /** Forget every charge (a new game). */
  reset(): void {
    this.active.length = 0;
  }
}
