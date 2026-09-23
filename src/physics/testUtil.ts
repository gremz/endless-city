import { makeBrush, Ramp, SOLID, type RampDir } from './brush';
import { CollisionWorld } from './CollisionWorld';

/** Build a CollisionWorld from simple box/ramp descriptions (meters). Test helper. */
export function worldFrom(
  boxes: { min: [number, number, number]; max: [number, number, number]; ramp?: RampDir; contents?: number }[],
): CollisionWorld {
  const w = new CollisionWorld();
  const brushes = boxes.map((b) =>
    makeBrush(b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], b.contents ?? SOLID, 0, b.ramp ?? Ramp.None),
  );
  w.addChunk(1, brushes);
  return w;
}

/** A big flat floor whose top is at y = 0. */
export const FLOOR = { min: [-200, -1, -200] as [number, number, number], max: [200, 0, 200] as [number, number, number] };
