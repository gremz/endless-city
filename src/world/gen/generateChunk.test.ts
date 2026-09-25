import { describe, expect, it } from 'vitest';
import { CHUNK } from '../../core/config';
import { fnv1a } from '../../core/rng';
import { vec3 } from '../../core/math';
import { Contents, MASK_PLAYER } from '../../physics/brush';
import { CollisionWorld } from '../../physics/CollisionWorld';
import { makeTrace } from '../../physics/trace';
import { brushesFromPacked } from '../chunkBrushes';
import { worldToChunk } from '../chunkMath';
import { BRUSH_STRIDE, DOOR_STRIDE, DoorFlag, Landmark, Material, NAV_CELL, NAV_RES, NavFlag, VEHICLE_STRIDE, wordContents, wordMaterial, type ChunkData } from './ChunkData';
import { CAR_L, CAR_W } from './streets';
import { generateChunk } from './generateChunk';
import { chunkPlan } from './cityPlan';
import { CAR } from '../../sim/vehicle/carPhysics';

function digest(d: ChunkData): number {
  let h = 0x811c9dc5;
  const mix = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i++) {
      h ^= arr[i] & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(d.brushes);
  mix(d.navCol);
  mix(d.navFlags);
  mix(d.navFloor);
  mix(new Int32Array(d.spawns.buffer.slice(0)));
  return h >>> 0;
}

/** Flags of the nav span in local cell (i, j) whose floor is within 0.3 m of y (0 if none). */
function spanFlags(d: ChunkData, i: number, j: number, y: number): number {
  const c = j * NAV_RES + i;
  for (let s = d.navCol[c]; s < d.navCol[c + 1]; s++) {
    if (Math.abs(d.navFloor[s] / 100 - y) <= 0.3) return d.navFlags[s];
  }
  return 0;
}

/** Whether local cell (i, j) has any walkable span. */
const columnWalkable = (d: ChunkData, i: number, j: number) => d.navCol[j * NAV_RES + i + 1] > d.navCol[j * NAV_RES + i];

/** Whether some column has two reachable floors at least 2.5 m apart (one above the other). */
function hasReachableStorey(d: ChunkData): boolean {
  for (let c = 0; c < NAV_RES * NAV_RES; c++) {
    let low = Infinity;
    for (let s = d.navCol[c]; s < d.navCol[c + 1]; s++) {
      if (!(d.navFlags[s] & NavFlag.Reachable)) continue;
      const y = d.navFloor[s] / 100;
      if (y - low >= 2.5) return true;
      low = Math.min(low, y);
    }
  }
  return false;
}

describe('generateChunk', () => {
  it('is deterministic for the same (seed, cx, cz)', () => {
    for (const [cx, cz] of [
      [0, 0],
      [3, -2],
      [-7, 11],
    ]) {
      const a = generateChunk(1337, cx, cz);
      const b = generateChunk(1337, cx, cz);
      expect(digest(a)).toBe(digest(b));
      expect(a.brushes).toEqual(b.brushes);
    }
  });

  it('bakes identical meshes for the same (seed, cx, cz)', () => {
    const a = generateChunk(1337, 4, -3);
    const b = generateChunk(1337, 4, -3);
    expect(a.meshes.length).toBe(b.meshes.length);
    a.meshes.forEach((m, i) => {
      expect(m.material).toBe(b.meshes[i].material);
      expect(m.positions).toEqual(b.meshes[i].positions);
      expect(m.uvs).toEqual(b.meshes[i].uvs);
    });
  });

  it('only appends cosmetic dressing: the layout underneath is unchanged', () => {
    for (const [cx, cz] of [
      [1, 1],
      [-4, 2],
      [5, -5],
      [8, 3],
    ]) {
      const bare = generateChunk(1337, cx, cz, { dress: false }).brushes;
      const full = generateChunk(1337, cx, cz).brushes;
      expect(full.length).toBeGreaterThanOrEqual(bare.length);
      expect(full.subarray(0, bare.length)).toEqual(bare);
    }
  });

  it('keeps facade dressing out of collision (only roof clutter is solid)', () => {
    let facade = 0;
    for (let cx = -4; cx <= 4; cx += 2) {
      for (let cz = -4; cz <= 4; cz += 2) {
        const d = generateChunk(7, cx, cz);
        for (let o = 0; o < d.brushes.length; o += BRUSH_STRIDE) {
          const m = wordMaterial(d.brushes[o + 6]);
          if (m !== Material.Facade && m !== Material.Stone && m !== Material.RoofTar) continue;
          facade++;
          expect(wordContents(d.brushes[o + 6]) & (Contents.SOLID_PLAYER | Contents.SOLID_BULLET)).toBe(0);
        }
      }
    }
    expect(facade).toBeGreaterThan(100);
  });

  it('differs between chunks and seeds', () => {
    expect(digest(generateChunk(1337, 2, 3))).not.toBe(digest(generateChunk(1337, 3, 2)));
    expect(digest(generateChunk(1337, 2, 3))).not.toBe(digest(generateChunk(42, 2, 3)));
  });

  it('keeps every brush inside its own chunk', () => {
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const d = generateChunk(99, cx, cz);
        for (let i = 0; i < d.brushes.length; i += BRUSH_STRIDE) {
          expect(d.brushes[i]).toBeGreaterThanOrEqual(0);
          expect(d.brushes[i + 2]).toBeGreaterThanOrEqual(0);
          expect(d.brushes[i + 3]).toBeLessThanOrEqual(CHUNK * 100);
          expect(d.brushes[i + 5]).toBeLessThanOrEqual(CHUNK * 100);
        }
      }
    }
  }, 15000);

  it('streets are walkable and connect across chunk seams', () => {
    const a = generateChunk(5, 0, 0);
    const b = generateChunk(5, 1, 0);
    // Road cells along the shared edge: a's last column and b's first column.
    let aOpen = 0;
    let bOpen = 0;
    for (let j = 10; j < NAV_RES - 10; j++) {
      if (columnWalkable(a, NAV_RES - 1, j)) aOpen++;
      if (columnWalkable(b, 0, j)) bOpen++;
    }
    expect(aOpen).toBeGreaterThan(40);
    expect(bOpen).toBeGreaterThan(40);
  });

  it('places health packs deterministically, inside the chunk, spaced apart', () => {
    let total = 0;
    for (let k = 0; k < 40; k++) {
      const cx = (k % 8) - 4;
      const cz = Math.floor(k / 8) - 2;
      const a = generateChunk(31, cx, cz);
      expect(a.pickups).toEqual(generateChunk(31, cx, cz).pickups);
      for (let s = 0; s < a.pickups.length; s += 3) {
        expect(a.pickups[s]).toBeGreaterThanOrEqual(cx * CHUNK);
        expect(a.pickups[s]).toBeLessThan((cx + 1) * CHUNK);
        expect(a.pickups[s + 2]).toBeGreaterThanOrEqual(cz * CHUNK);
        expect(a.pickups[s + 2]).toBeLessThan((cz + 1) * CHUNK);
        for (let t = s + 3; t < a.pickups.length; t += 3) {
          expect(Math.hypot(a.pickups[s] - a.pickups[t], a.pickups[s + 2] - a.pickups[t + 2])).toBeGreaterThanOrEqual(11.9);
        }
      }
      expect(a.pickups.length / 3).toBeLessThanOrEqual(2);
      total += a.pickups.length / 3;
    }
    expect(total).toBeGreaterThan(15);
  });

  it('the spawn plaza always has a health pack near the drop-in point', () => {
    for (const seed of [1, 1337, 2024]) {
      const d = generateChunk(seed, 0, 0);
      expect(d.pickups.length).toBe(3);
      expect(Math.hypot(d.pickups[0] - 32, d.pickups[2] - 22)).toBeLessThan(15);
    }
  });

  it('parks driveable cars on clear road, one always by the spawn plaza', () => {
    let cars = 0;
    for (let cx = -5; cx <= 5; cx++) {
      for (let cz = -5; cz <= 5; cz++) {
        const d = generateChunk(99, cx, cz);
        const world = new CollisionWorld();
        world.addChunk(d.key, brushesFromPacked(d.brushes, cx, cz, d.key));
        const tr = makeTrace();
        for (let i = 0; i < d.vehicles.length; i += VEHICLE_STRIDE) {
          cars++;
          const [x, y, z, yaw] = [d.vehicles[i], d.vehicles[i + 1], d.vehicles[i + 2], d.vehicles[i + 3]];
          expect(worldToChunk(x)).toBe(cx);
          expect(worldToChunk(z)).toBe(cz);
          // Parked along the road: heading is a multiple of 90°.
          const alongX = Math.abs(Math.sin(yaw)) > 0.5;
          // Above the hull's clearance: a car parked against the curb has two wheels up on it.
          const half = alongX ? vec3(CAR_L / 2, 0.55, CAR_W / 2) : vec3(CAR_W / 2, 0.55, CAR_L / 2);
          const center = vec3(x, y + CAR.clearance + 0.05 + half.y, z);
          expect(world.testBox(tr, center, vec3(-half.x, -half.y, -half.z), half, MASK_PLAYER)).toBe(false);
          // Standing on the asphalt.
          world.traceRay(tr, vec3(x, y + 1, z), vec3(x, y - 1, z), MASK_PLAYER);
          expect(tr.endY).toBeCloseTo(y, 1);
        }
      }
    }
    expect(cars).toBeGreaterThan(10);
    for (const seed of [1, 1337, 2024]) {
      const d = generateChunk(seed, 0, 0);
      expect(d.vehicles.length).toBeGreaterThanOrEqual(VEHICLE_STRIDE);
    }
  });

  it('every spawn slot and patrol point is on a reachable walkable cell (200 chunks)', () => {
    let totalSpawns = 0;
    let encounters = 0;
    let multiStorey = 0;
    for (let k = 0; k < 200; k++) {
      const cx = (k % 20) - 10;
      const cz = Math.floor(k / 20) - 5;
      const d = generateChunk(2024, cx, cz);
      const check = (arr: Float32Array) => {
        for (let s = 0; s < arr.length; s += 3) {
          const i = Math.floor((arr[s] - cx * CHUNK) / NAV_CELL);
          const j = Math.floor((arr[s + 2] - cz * CHUNK) / NAV_CELL);
          const f = spanFlags(d, i, j, arr[s + 1] - 0.02);
          expect(f & NavFlag.Walkable).toBeTruthy();
          expect(f & NavFlag.Reachable).toBeTruthy();
        }
      };
      check(d.spawns);
      check(d.patrol);
      check(d.pickups);
      totalSpawns += d.spawns.length / 3;
      if (d.hasEncounter) encounters++;
      // A good share of the lot should be reachable from the street.
      let lotWalk = 0;
      let lotReach = 0;
      for (let idx = 0; idx < d.navFlags.length; idx++) {
        const f = d.navFlags[idx];
        if (f & NavFlag.Walkable && !(f & NavFlag.Street)) {
          lotWalk++;
          if (f & NavFlag.Reachable) lotReach++;
        }
      }
      expect(lotReach / Math.max(1, lotWalk)).toBeGreaterThan(0.6);
      if (hasReachableStorey(d)) multiStorey++;
    }
    // Upstairs rooms (two-storey houses, catwalks) are part of the walkable city.
    expect(multiStorey).toBeGreaterThan(50);
    expect(totalSpawns / 200).toBeGreaterThan(8);
    expect(encounters).toBeGreaterThan(60);
  }, 60000);

  it('hangs doors in doorways and glazes windows', () => {
    const tr = makeTrace();
    const small = vec3(-0.1, 0, -0.1);
    const smallMax = vec3(0.1, 0.2, 0.1);
    let doors = 0;
    let locked = 0;
    let panes = 0;
    for (let k = 0; k < 40; k++) {
      const cx = (k % 8) - 4;
      const cz = Math.floor(k / 8) - 2;
      const d = generateChunk(99, cx, cz);
      const world = new CollisionWorld();
      world.addChunk(d.key, brushesFromPacked(d.brushes, cx, cz, d.key));
      for (let o = 0; o < d.doors.length; o += DOOR_STRIDE) {
        doors++;
        if (d.doors[o + 6] & DoorFlag.Locked) locked++;
        const [x, y, z, alongX, width] = d.doors.subarray(o, o + 5);
        // The doorway itself is open (the door is a separate moving brush)...
        expect(world.testBox(tr, vec3(x, y + 1, z), small, smallMax, MASK_PLAYER)).toBe(false);
        // ...between two wall jambs.
        const hw = width / 2 + 0.2;
        const jamb = (s: number) => (alongX ? vec3(x + s * hw, y + 1, z) : vec3(x, y + 1, z + s * hw));
        expect(world.testBox(tr, jamb(-1), small, smallMax, MASK_PLAYER)).toBe(true);
        expect(world.testBox(tr, jamb(1), small, smallMax, MASK_PLAYER)).toBe(true);
      }
      for (const i of d.glass) {
        panes++;
        const w = d.brushes[i * BRUSH_STRIDE + 6];
        expect(wordMaterial(w)).toBe(Material.Glass);
        expect(wordContents(w)).toBe(Contents.GLASS);
      }
    }
    expect(doors).toBeGreaterThan(20);
    expect(locked).toBeGreaterThan(0);
    expect(panes).toBeGreaterThan(100);
  });

  it('builds landmark buildings whose every floor can be reached', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 144; k++) {
      const cx = (k % 12) - 6;
      const cz = Math.floor(k / 12) - 6;
      const d = generateChunk(2024, cx, cz);
      if (!d.landmark) continue;
      seen.add(d.landmark);
      // Group the walkable floor above street level by height: each is (nearly) all reachable.
      const floors = new Map<number, [number, number]>();
      for (let s = 0; s < d.navFloor.length; s++) {
        const y = Math.round(d.navFloor[s] / 50);
        if (y < 6) continue;
        const e = floors.get(y) ?? [0, 0];
        e[0]++;
        if (d.navFlags[s] & NavFlag.Reachable) e[1]++;
        floors.set(y, e);
      }
      // (Landmark floors are big; small groups are other roofs that happen to share the height.)
      for (const [, [n, r]] of floors) if (n > 500) expect(r / n).toBeGreaterThan(0.95);
    }
    expect([...seen].filter((l) => l <= Landmark.Garage).sort()).toEqual([Landmark.Apartment, Landmark.Office, Landmark.Garage]);
  }, 60000);

  it('lays out the river, highways, parks and plazas consistently across chunks', () => {
    const seed = 7;
    let river = 0;
    let parks = 0;
    let plazas = 0;
    for (let cz = -14; cz <= 14; cz++) {
      for (let cx = -14; cx <= 14; cx++) {
        const p = chunkPlan(seed, cx, cz);
        // Neighbors agree about the seams they share.
        const e = chunkPlan(seed, cx + 1, cz);
        expect(p.riverSides[3]).toBe(e.riverSides[2]);
        expect(p.bridges[3]).toBe(e.bridges[2]);
        expect(p.highwayEast).toBe(e.highwayWest);
        const s = chunkPlan(seed, cx, cz + 1);
        expect(p.riverSides[1]).toBe(s.riverSides[0]);
        expect(p.bridges[1]).toBe(s.bridges[0]);
        if (p.river) {
          river++;
          // The river keeps its distance from spawn, and runs on as a connected chain.
          expect(Math.max(Math.abs(cx), Math.abs(cz))).toBeGreaterThanOrEqual(3);
          expect(p.riverSides.filter(Boolean).length).toBeGreaterThanOrEqual(1);
        }
        if (p.feature === 'park') parks++;
        if (p.feature === 'plaza') plazas++;
        if (p.feature || p.river) expect(p.onRamp).toBeNull();
      }
    }
    expect(river).toBeGreaterThan(20);
    expect(parks).toBeGreaterThan(5);
    expect(plazas).toBeGreaterThan(3);
    expect(chunkPlan(seed, 0, 0)).toMatchObject({ river: false, feature: null, highwayWest: false, highwayEast: false });
  });

  it('bridges, highway decks and ramps are walkable and reachable', () => {
    const seed = 7;
    let bridges = 0;
    let decks = 0;
    let ramps = 0;
    for (let cz = -12; cz <= 12; cz++) {
      for (let cx = -12; cx <= 12; cx++) {
        const p = chunkPlan(seed, cx, cz);
        const wantBridge = p.bridges.some(Boolean);
        if (!wantBridge && !p.onRamp) continue;
        const d = generateChunk(seed, cx, cz);
        // Bridge decks: mid-span, a reachable street-level floor with the river bed under it.
        for (let side = 0; side < 4; side++) {
          if (!p.bridges[side]) continue;
          const [x, z] = [
            [32, 2],
            [32, 62],
            [2, 32],
            [62, 32],
          ][side];
          const c = Math.floor(z / NAV_CELL) * NAV_RES + Math.floor(x / NAV_CELL);
          let deck = false;
          let bed = false;
          for (let s = d.navCol[c]; s < d.navCol[c + 1]; s++) {
            if (Math.abs(d.navFloor[s]) < 5 && d.navFlags[s] & NavFlag.Reachable) deck = true;
            if (d.navFlags[s] & NavFlag.Water) bed = true;
          }
          expect(deck).toBe(true);
          expect(bed).toBe(true);
          // Nothing stands on the deck along its whole length, not even a curb at its ends.
          const world = new CollisionWorld();
          world.addChunk(d.key, brushesFromPacked(d.brushes, cx, cz, d.key));
          const tr = makeTrace();
          const half = vec3(0.4, 0.5, 0.4);
          for (let a = 0.5; a < CHUNK; a += 0.5) {
            const lx = side < 2 ? a : x;
            const lz = side < 2 ? z : a;
            const center = vec3(cx * CHUNK + lx, 0.02 + half.y, cz * CHUNK + lz);
            expect(world.testBox(tr, center, vec3(-half.x, -half.y, -half.z), half, MASK_PLAYER), `bridge ${cx},${cz} side ${side} at ${a}`).toBe(false);
          }
          bridges++;
        }
        if (p.onRamp) {
          // The deck (9 m up) is reachable from the street by the ramp.
          let deck = 0;
          let reach = 0;
          for (let s = 0; s < d.navFloor.length; s++) {
            if (d.navFloor[s] > 850 && d.navFloor[s] < 950) {
              deck++;
              if (d.navFlags[s] & NavFlag.Reachable) reach++;
            }
          }
          expect(reach / Math.max(1, deck)).toBeGreaterThan(0.9);
          ramps++;
        }
        if (p.highwayEast || p.highwayWest) decks++;
      }
    }
    expect(bridges).toBeGreaterThan(3);
    expect(ramps).toBeGreaterThan(2);
    expect(decks).toBeGreaterThan(2);
  }, 60000);

  it('generates fast enough', () => {
    const t0 = performance.now();
    for (let k = 0; k < 30; k++) generateChunk(77, k, -k);
    const avg = (performance.now() - t0) / 30;
    expect(avg).toBeLessThan(40);
  });
});
