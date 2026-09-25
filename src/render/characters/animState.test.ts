import { describe, expect, it } from 'vitest';
import { choosePose, type PoseInput } from './animState';
import { CLIPS, CROUCH_WALK_SPEED, RUN_SPEED, WALK_SPEED } from './characterSpec';

const REQUIRED = new Map(CLIPS.filter((c) => c.required).map((c) => [c.name, 1]));
const ALL = new Map(CLIPS.map((c) => [c.name, 1]));
const still: PoseInput = { speed: 0, moveAngle: 0, crouch: 0, airTime: 0 };

const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);

describe('choosePose', () => {
  it('idles when standing still', () => {
    const p = choosePose(still, REQUIRED);
    expect(p.weights).toEqual({ Idle: 1 });
    expect(p.cycleRate).toBe(0);
  });

  it('walks at walking speed with the cycle matched to the ground', () => {
    const p = choosePose({ ...still, speed: WALK_SPEED }, REQUIRED);
    expect(p.weights.Walk).toBeCloseTo(1);
    expect(p.weights.Run ?? 0).toBe(0);
    // Clip lasts 1 s and covers WALK_SPEED metres, so one cycle per second.
    expect(p.cycleRate).toBeCloseTo(1);
  });

  it('blends walk into run as speed rises, weights always summing to 1', () => {
    let lastRun = -1;
    for (let v = 0; v <= RUN_SPEED + 1; v += 0.25) {
      const p = choosePose({ ...still, speed: v }, REQUIRED);
      expect(sum(p.weights)).toBeCloseTo(1);
      const run = p.weights.Run ?? 0;
      expect(run).toBeGreaterThanOrEqual(lastRun);
      lastRun = run;
    }
    expect(choosePose({ ...still, speed: RUN_SPEED }, REQUIRED).weights.Run).toBeCloseTo(1);
  });

  it('clamps playback speed', () => {
    const fast = choosePose({ ...still, speed: RUN_SPEED * 5 }, REQUIRED);
    expect(fast.cycleRate).toBeCloseTo(2);
    const creep = choosePose({ ...still, speed: 0.4 }, REQUIRED);
    expect(creep.cycleRate).toBeCloseTo(0.4);
  });

  it('crouches in proportion to the crouch amount', () => {
    expect(choosePose({ ...still, crouch: 1 }, REQUIRED).weights).toEqual({ Crouch_Idle: 1 });
    const half = choosePose({ ...still, crouch: 0.5 }, REQUIRED).weights;
    expect(half.Idle).toBeCloseTo(0.5);
    expect(half.Crouch_Idle).toBeCloseTo(0.5);
    const sneak = choosePose({ ...still, crouch: 1, speed: CROUCH_WALK_SPEED }, REQUIRED);
    expect(sneak.weights).toEqual({ Crouch_Walk: 1 });
    expect(sneak.cycleRate).toBeCloseTo(1);
  });

  it('uses strafe and back clips when the model has them', () => {
    const right = choosePose({ ...still, speed: WALK_SPEED, moveAngle: Math.PI / 2 }, ALL);
    expect(right.weights.Walk_Right).toBeCloseTo(1);
    const diag = choosePose({ ...still, speed: WALK_SPEED, moveAngle: -Math.PI / 4 }, ALL);
    expect(diag.weights.Walk).toBeCloseTo(0.5);
    expect(diag.weights.Walk_Left).toBeCloseTo(0.5);
    const back = choosePose({ ...still, speed: RUN_SPEED, moveAngle: Math.PI }, ALL);
    expect(back.weights.Run_Back).toBeCloseTo(1);
    expect(back.cycleRate).toBeGreaterThan(0);
  });

  it('falls back to the forward cycle, reversed when walking backwards', () => {
    const right = choosePose({ ...still, speed: WALK_SPEED, moveAngle: Math.PI / 2 }, REQUIRED);
    expect(right.weights).toEqual({ Walk: expect.closeTo(1) });
    expect(right.cycleRate).toBeGreaterThan(0);
    const back = choosePose({ ...still, speed: WALK_SPEED, moveAngle: Math.PI }, REQUIRED);
    expect(back.weights.Walk).toBeCloseTo(1);
    expect(back.cycleRate).toBeLessThan(0);
  });

  it('only jumps after a moment in the air, and only with a Jump clip', () => {
    expect(choosePose({ ...still, airTime: 0.05 }, ALL).weights).toEqual({ Idle: 1 });
    expect(choosePose({ ...still, airTime: 0.5 }, ALL).weights).toEqual({ Jump: 1 });
    expect(choosePose({ ...still, airTime: 0.5 }, REQUIRED).weights).toEqual({ Idle: 1 });
  });

  it('never names a clip the model lacks', () => {
    for (const clips of [REQUIRED, ALL]) {
      for (let a = -Math.PI; a <= Math.PI; a += 0.3) {
        for (const crouch of [0, 0.4, 1]) {
          for (const speed of [0, 1, 3, 6]) {
            const p = choosePose({ speed, moveAngle: a, crouch, airTime: 0 }, clips);
            for (const name of Object.keys(p.weights)) expect(clips.has(name), name).toBe(true);
            expect(sum(p.weights)).toBeCloseTo(1);
          }
        }
      }
    }
  });
});
