import { HITGROUP_NAMES, STAND_BOXES } from '../ai/hitboxes';
import { MOVE } from '../player/movementConfig';

/**
 * A Wavefront OBJ to model around in Blender: the standing hitboxes as solid boxes, the crouched
 * hitboxes and the collision hull as wireframes, an eye-height cross and an arrow pointing
 * forward. OBJ is Y-up with the front along +Z, which Blender's default OBJ import turns into Z-up
 * facing -Y (the Front view), the same way the glTF export maps back.
 */
export function hitboxReferenceObj(): string {
  const out: string[] = ['# Character hitbox reference (metres). Standing boxes solid, crouched boxes and collision hull as wires.'];
  let base = 1;
  const corners = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => {
    for (const [x, y, z] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) {
      out.push(`v ${(cx + x * hx).toFixed(4)} ${(cy + y * hy).toFixed(4)} ${(cz + z * hz).toFixed(4)}`);
    }
  };
  const solid = (name: string, cy: number, hx: number, hy: number, hz: number) => {
    out.push(`o ${name}`);
    corners(0, cy, 0, hx, hy, hz);
    for (const f of [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]) out.push(`f ${f.map((i) => i + base - 1).join(' ')}`);
    base += 8;
  };
  const wire = (name: string, cy: number, hx: number, hy: number, hz: number) => {
    out.push(`o ${name}`);
    corners(0, cy, 0, hx, hy, hz);
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 1], [5, 6], [6, 7], [7, 8], [8, 5], [1, 5], [2, 6], [3, 7], [4, 8]]) out.push(`l ${a + base - 1} ${b + base - 1}`);
    base += 8;
  };
  const lines = (name: string, pts: [number, number, number][], segs: [number, number][]) => {
    out.push(`o ${name}`);
    for (const [x, y, z] of pts) out.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
    for (const [a, b] of segs) out.push(`l ${a + base} ${b + base}`);
    base += pts.length;
  };

  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  for (const b of STAND_BOXES) solid(`Hitbox_${cap(HITGROUP_NAMES[b.group])}`, b.cy, b.hx, b.hy, b.hz);
  const k = MOVE.duckEye / MOVE.standEye;
  for (const b of STAND_BOXES) wire(`Crouched_${cap(HITGROUP_NAMES[b.group])}`, b.cy * k, b.hx, b.hy * k, b.hz);
  const hw = MOVE.halfWidth;
  wire('Collision_Standing', MOVE.standHeight / 2, hw, MOVE.standHeight / 2, hw);
  wire('Collision_Crouched', MOVE.duckHeight / 2, hw, MOVE.duckHeight / 2, hw);
  const eye = MOVE.standEye;
  lines('Eye_Height', [[-0.1, eye, 0], [0.1, eye, 0], [0, eye, -0.1], [0, eye, 0.1]], [[0, 1], [2, 3]]);
  lines('Forward', [[0, 0.01, 0], [0, 0.01, 0.6], [-0.08, 0.01, 0.48], [0.08, 0.01, 0.48]], [[0, 1], [1, 2], [1, 3]]);
  return `${out.join('\n')}\n`;
}
