import { describe, expect, it } from 'vitest';
import { Intro, INTRO_CUES, INTRO_LENGTH, lookAt, SKIP_BLEND, titleOrbit, type IntroAnchors } from './Intro';

const anchors: IntroAnchors = { eye: { x: 32, y: 1.7, z: 22 }, scene: { x: 30, y: 0, z: 70 } };
const start = titleOrbit(12, { x: 32, y: 0, z: 22 }, anchors.scene);

function run(intro: Intro, seconds: number, dt = 1 / 60) {
  const cues: string[] = [];
  let f = intro.update(0, anchors);
  for (let t = 0; t < seconds && !f.done; t += dt) {
    f = intro.update(dt, anchors);
    cues.push(...f.cues);
  }
  return { f, cues };
}

describe('intro', () => {
  it('starts where the title camera was', () => {
    const f = new Intro(start).update(0, anchors);
    expect(f.pose.x).toBeCloseTo(start.x);
    expect(f.pose.y).toBeCloseTo(start.y);
    expect(f.pose.yaw).toBeCloseTo(start.yaw);
  });

  it("ends at the player's eyes, looking at the officer, with every line said once", () => {
    const intro = new Intro(start);
    const { f, cues } = run(intro, INTRO_LENGTH + 1);
    expect(f.done).toBe(true);
    const end = intro.endPose(anchors);
    expect(f.pose).toEqual(end);
    expect(end.yaw).toBeCloseTo(lookAt(anchors.eye, { ...anchors.scene, y: 1 }).yaw);
    expect(cues).toEqual(INTRO_CUES.map((c) => c.line));
  });

  it('moves smoothly (no jumps between frames)', () => {
    const intro = new Intro(start);
    let prev = intro.update(0, anchors).pose;
    for (let t = 0; t < INTRO_LENGTH; t += 1 / 60) {
      const p = intro.update(1 / 60, anchors).pose;
      expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThan(1.2);
      prev = p;
    }
  });

  it('skips home quickly and still gives the order', () => {
    const intro = new Intro(start);
    run(intro, 3);
    intro.skip();
    const { f, cues } = run(intro, SKIP_BLEND + 0.1);
    expect(f.done).toBe(true);
    expect(f.pose.x).toBeCloseTo(anchors.eye.x);
    expect(f.pose.z).toBeCloseTo(anchors.eye.z);
    expect(cues).toEqual([INTRO_CUES[INTRO_CUES.length - 1].line]);
  });

  it('keeps the camera out of walls', () => {
    const intro = new Intro(start, (from, to) => ({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }));
    const k = intro.keys(anchors);
    // The spots round the scene got pulled in; the ends didn't.
    expect(Math.hypot(k[2].x - anchors.scene.x, k[2].z - anchors.scene.z)).toBeLessThan(7);
    expect(k[4]).toEqual(anchors.eye);
  });
});
