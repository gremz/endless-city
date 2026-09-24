import { CHUNK, HU } from '../../core/config';
import { hash3, randRange, Salt, sfc32 } from '../../core/rng';
import { Contents, Ramp, SOLID } from '../../physics/brush';
import { chunkKey } from '../chunkMath';
import { BrushWriter } from './BrushWriter';
import { District, Material, type ChunkData } from './ChunkData';
import { vehicleSpawns } from './generateChunk';
import { bakeMeshes } from './meshBake';

const FLOOR = SOLID | Contents.FLOOR;

/** Movement test course (chunk 0,0) plus scattered crates everywhere else, for M1/M2. */
export function generateGymChunk(seed: number, cx: number, cz: number): ChunkData {
  const t0 = performance.now();
  const w = new BrushWriter();
  // Ground slab.
  w.box(0, -1, 0, CHUNK, 0, CHUNK, Material.Dev, FLOOR, 128);

  const glass: number[] = [];
  if (cx === 0 && cz === 0) buildCourse(w);
  else if (cx === 1 && cz === 0) buildRange(w, glass);
  else {
    const r = sfc32(hash3(seed, cx, cz, Salt.Layout));
    const n = 6 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      const size = r() < 0.5 ? 64 * HU : 32 * HU;
      const x = Math.round(randRange(r, 4, CHUNK - 6) * 4) / 4;
      const z = Math.round(randRange(r, 4, CHUNK - 6) * 4) / 4;
      const stack = r() < 0.3 ? 2 : 1;
      for (let s = 0; s < stack; s++) {
        w.box(x, s * size, z, x + size, (s + 1) * size, z + size, Material.Crate, SOLID | Contents.PENETRABLE, 100 + s * 40);
      }
    }
    if (r() < 0.5) {
      const x = Math.round(randRange(r, 8, 40));
      const z = Math.round(randRange(r, 8, 40));
      w.box(x, 0, z, x + 12, 3, z + 0.3, Material.Concrete, SOLID, 128);
    }
  }

  const brushes = w.finish();
  return {
    cx,
    cz,
    key: chunkKey(cx, cz),
    seed,
    brushes,
    meshes: bakeMeshes(brushes),
    district: District.Gym,
    level: 0,
    navCol: new Uint16Array(0),
    navFloor: new Int16Array(0),
    navFlags: new Uint8Array(0),
    navCover: new Uint8Array(0),
    navLinks: new Float32Array(0),
    spawns: new Float32Array(0),
    perches: new Float32Array(0),
    patrol: new Float32Array(0),
    // Two health packs beside the course start, for trying medkits out.
    pickups: cx === 0 && cz === 0 ? new Float32Array([26, 0.02, 26, 38, 0.02, 26]) : new Float32Array(0),
    // A car to try driving in, beside the course start.
    vehicles: cx === 0 && cz === 0 ? vehicleSpawns([{ style: { paint: 5, hatch: false, flip: false, look: 'intact' }, alongX: false, lane: 46, at: 12, y: 0 }], cx, cz) : new Float32Array(0),
    // The range's doorway gets a door (open it, kick it, shoot through it).
    doors: cx === 1 && cz === 0 ? new Float32Array([CHUNK + 30.15, 0, 54.8, 0, 1.6, 2.4, 0, 1]) : new Float32Array(0),
    glass: new Int32Array(glass),
    hasEncounter: false,
    genMs: performance.now() - t0,
  };
}

function buildCourse(w: BrushWriter): void {
  const C = Material.Concrete;
  // Row of step tests along z = 40..44: heights 0.25, 0.45 (stepable), 0.5 (not).
  const steps = [0.25, 0.45, 0.5];
  steps.forEach((h, i) => w.box(4 + i * 5, 0, 40, 7 + i * 5, h, 44, C, FLOOR, 90 + i * 40));

  // Mantle walls: 1.9 m and 2.2 m (hold jump into them), 2.6 m (too high).
  [1.9, 2.2, 2.6].forEach((h, i) => w.box(4 + i * 5, 0, 14, 7 + i * 5, h, 22, C, FLOOR, 100 + i * 30));
  // Ladder tower: an 8 m block with a ladder on its -X face and a plank bridge to a second block.
  w.box(48, 0, 14, 54, 8, 22, Material.Brick, FLOOR, 128);
  w.ladder(2, 48, 18, 0, 8);
  w.box(54, 7.85, 17, 57, 8, 19, Material.Wood, FLOOR, 120);
  w.box(57, 0, 14, 61, 8, 22, Material.Brick, FLOOR, 160);

  // Jump boxes: 54 HU (jump), 64 HU (crouch-jump), 72 HU (too high).
  [54, 64, 72].forEach((hu, i) => w.box(22 + i * 5, 0, 40, 25 + i * 5, hu * HU, 43, Material.Crate, SOLID | Contents.PENETRABLE, 120));

  // Ramps: 30° walkable and 50° slide.
  const r30 = 6;
  w.ramp(40, 0, 36, 40 + r30, r30 * Math.tan((30 * Math.PI) / 180), 42, Ramp.PosX, C);
  w.box(46, 0, 36, 50, r30 * Math.tan((30 * Math.PI) / 180), 42, C, FLOOR);
  const r50 = 2.5;
  w.ramp(52, 0, 36, 52 + r50, r50 * Math.tan((50 * Math.PI) / 180), 42, Ramp.PosX, Material.Metal, FLOOR, 4);

  // Stairs with clip ramp up to a platform.
  w.stairs(6, 0, 50, 12, 2, 54, Ramp.PosX, C);
  w.box(12, 0, 48, 20, 2, 58, C, FLOOR, 150);

  // Low tunnel: crouch-only (1.5 m clearance).
  w.box(24, 1.5, 50, 34, 2.1, 54, C, SOLID, 110);
  w.box(24, 0, 49.7, 34, 2.1, 50, C, SOLID, 110);
  w.box(24, 0, 54, 34, 2.1, 54.3, C, SOLID, 110);

  // Long wall for strafing / spray tests.
  w.box(4, 0, 62, 60, 4, 62.5, Material.Brick, SOLID, 128);

  // Crate stack with a 32 HU step crate.
  const s64 = 64 * HU;
  const s32 = 32 * HU;
  w.box(40, 0, 48, 40 + s64, s64, 48 + s64, Material.Crate, SOLID | Contents.PENETRABLE, 130);
  w.box(40 + s64, 0, 48, 40 + s64 + s32, s32, 48 + s32, Material.Crate, SOLID | Contents.PENETRABLE, 90);
  w.box(40, s64, 48, 40 + s64, 2 * s64, 48 + s64, Material.Crate, SOLID | Contents.PENETRABLE, 170);

  // A shipping container with a ramp onto its roof.
  w.box(46, 0, 48, 52.1, 2.6, 50.4, Material.Metal, SOLID, 1);
  w.ramp(52.1, 0, 48, 56, 2.6, 50.4, Ramp.NegX, Material.Metal, FLOOR, 4);
}

function buildRange(w: BrushWriter, glass: number[]): void {
  // Shooting range: back wall, lane dividers, a doorway wall to test through-door shots.
  w.box(60, 0, 4, 60.5, 5, 60, Material.Concrete, SOLID, 128);
  for (let i = 0; i < 4; i++) w.box(10, 0, 12 + i * 12, 60, 1, 12.3 + i * 12, Material.Concrete, SOLID, 110);
  w.box(30, 0, 50, 30.3, 3, 54, Material.Plaster, SOLID, 140);
  w.box(30, 0, 55.6, 30.3, 3, 60, Material.Plaster, SOLID, 140);
  w.box(30, 2.4, 54, 30.3, 3, 55.6, Material.Plaster, SOLID, 140);
  w.box(20, 0, 30, 20.3, 1.2, 34, Material.Wood, SOLID | Contents.PENETRABLE, 140);
  // A row of window panes on low sills, to shoot out.
  for (let i = 0; i < 4; i++) {
    const z = 38 + i * 2.5;
    w.box(24, 0, z, 24.3, 1, z + 2, Material.Plaster, SOLID, 140);
    w.box(24.13, 1, z, 24.17, 2.4, z + 2, Material.Glass, Contents.GLASS);
    glass.push(w.count - 1);
  }
}
