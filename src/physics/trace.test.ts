import { describe, expect, it } from 'vitest';
import { vec3 } from '../core/math';
import { Contents, makeBrush, MASK_PLAYER, MASK_SHOT, Ramp, SOLID } from './brush';
import { CollisionWorld } from './CollisionWorld';
import { worldFrom } from './testUtil';
import { makeTrace, rayExitFraction } from './trace';

const ZERO = vec3();

describe('trace', () => {
  const w = worldFrom([{ min: [-1, 0, -1], max: [1, 2, 1] }]);

  it('ray hits each face of a box with the right normal', () => {
    const tr = makeTrace();
    const cases: [number[], number[], number[]][] = [
      [[-5, 1, 0], [5, 1, 0], [-1, 0, 0]],
      [[5, 1, 0], [-5, 1, 0], [1, 0, 0]],
      [[0, 5, 0], [0, -5, 0], [0, 1, 0]],
      [[0, 1, -5], [0, 1, 5], [0, 0, -1]],
      [[0, 1, 5], [0, 1, -5], [0, 0, 1]],
    ];
    for (const [s, e, n] of cases) {
      w.traceRay(tr, vec3(s[0], s[1], s[2]), vec3(e[0], e[1], e[2]), MASK_SHOT);
      expect(tr.fraction).toBeLessThan(1);
      expect(tr.normal.x).toBe(n[0]);
      expect(tr.normal.y).toBe(n[1]);
      expect(tr.normal.z).toBe(n[2]);
    }
    w.traceRay(tr, vec3(-5, 1, 0), vec3(5, 1, 0), MASK_SHOT);
    expect(tr.endX).toBeCloseTo(-1, 2);
  });

  it('misses when passing beside the box', () => {
    const tr = makeTrace();
    w.traceRay(tr, vec3(-5, 1, 1.5), vec3(5, 1, 1.5), MASK_SHOT);
    expect(tr.fraction).toBe(1);
    w.traceRay(tr, vec3(-5, 2.01, 0), vec3(5, 2.01, 0), MASK_SHOT);
    expect(tr.fraction).toBe(1);
  });

  it('box hull stops at the Minkowski-expanded face', () => {
    const tr = makeTrace();
    const mins = vec3(-0.25, 0, -0.25);
    const maxs = vec3(0.25, 1, 0.25);
    w.traceBox(tr, vec3(-5, 0.5, 0), vec3(5, 0.5, 0), mins, maxs, MASK_PLAYER);
    expect(tr.endX).toBeCloseTo(-1.25, 2);
    // A hull resting just above the top (as pmove leaves it) slides over freely.
    w.traceBox(tr, vec3(-5, 2.001, 0), vec3(5, 2.001, 0), mins, maxs, MASK_PLAYER);
    expect(tr.fraction).toBe(1);
  });

  it('detects start solid and all solid', () => {
    const tr = makeTrace();
    w.traceRay(tr, vec3(0, 1, 0), vec3(0, 1, 0.5), MASK_SHOT);
    expect(tr.startSolid).toBe(true);
    expect(tr.allSolid).toBe(true);
    w.traceRay(tr, vec3(0, 1, 0), vec3(0, 1, 5), MASK_SHOT);
    expect(tr.startSolid).toBe(true);
    expect(tr.allSolid).toBe(false);
    expect(w.testBox(tr, vec3(0, 1, 0), ZERO, ZERO, MASK_SHOT)).toBe(true);
    expect(w.testBox(tr, vec3(3, 1, 0), ZERO, ZERO, MASK_SHOT)).toBe(false);
  });

  it('respects contents masks', () => {
    const cw = new CollisionWorld();
    cw.addChunk(1, [makeBrush(-1, 0, -1, 1, 2, 1, Contents.SOLID_PLAYER)]);
    const tr = makeTrace();
    cw.traceRay(tr, vec3(-5, 1, 0), vec3(5, 1, 0), MASK_SHOT);
    expect(tr.fraction).toBe(1);
    cw.traceRay(tr, vec3(-5, 1, 0), vec3(5, 1, 0), MASK_PLAYER);
    expect(tr.fraction).toBeLessThan(1);
  });

  it('ramps: a vertical ray lands on the slope', () => {
    for (const [ramp, x, z, expected] of [
      [Ramp.PosX, 1, 0.5, 0.5],
      [Ramp.PosX, 1.5, 0.5, 0.75],
      [Ramp.NegX, 0.5, 0.5, 0.75],
      [Ramp.PosZ, 0.5, 1.5, 0.75],
      [Ramp.NegZ, 0.5, 0.5, 0.75],
    ] as const) {
      const rw = worldFrom([{ min: [0, 0, 0], max: [2, 1, 2], ramp }]);
      const tr = makeTrace();
      rw.traceRay(tr, vec3(x, 5, z), vec3(x, -5, z), MASK_SHOT);
      expect(tr.endY).toBeCloseTo(expected, 2);
      expect(tr.normal.y).toBeCloseTo(Math.cos(Math.atan(0.5)), 3);
    }
  });

  it('long rays find distant brushes and stop at the nearest', () => {
    const lw = worldFrom([
      { min: [100, 0, -1], max: [101, 2, 1] },
      { min: [150, 0, -1], max: [151, 2, 1] },
    ]);
    const tr = makeTrace();
    lw.traceRay(tr, vec3(0, 1, 0), vec3(200, 1, 0), MASK_SHOT);
    expect(tr.endX).toBeCloseTo(100, 2);
  });

  it('removeChunk drops its brushes', () => {
    const cw = new CollisionWorld();
    cw.addChunk(7, [makeBrush(-1, 0, -1, 1, 2, 1, SOLID)]);
    const tr = makeTrace();
    cw.traceRay(tr, vec3(-5, 1, 0), vec3(5, 1, 0), MASK_SHOT);
    expect(tr.fraction).toBeLessThan(1);
    cw.removeChunk(7);
    cw.traceRay(tr, vec3(-5, 1, 0), vec3(5, 1, 0), MASK_SHOT);
    expect(tr.fraction).toBe(1);
    expect(cw.chunkCount).toBe(0);
  });

  it('rayExitFraction measures thickness', () => {
    const b = makeBrush(-1, 0, -1, 1, 2, 1, SOLID);
    expect(rayExitFraction(b, -5, 1, 0, 5, 1, 0)).toBeCloseTo(0.6, 5);
    expect(rayExitFraction(b, -5, 1, 3, 5, 1, 3)).toBe(-1);
  });
});
