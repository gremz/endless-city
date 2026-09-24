import { vec3, type Vec3 } from '../../core/math';
import { MASK_SHOT } from '../../physics/brush';
import type { CollisionWorld } from '../../physics/CollisionWorld';
import { makeTrace } from '../../physics/trace';
import { NavFlag } from '../../world/gen/ChunkData';
import { cellCenter, toCell, type NavGrid } from './NavGrid';

export interface CoverSpot {
  x: number;
  y: number;
  z: number;
  /** Half cover: crouch behind it; full cover: stand. */
  crouch: boolean;
}

const tr = makeTrace();
const a = vec3();
const b = vec3();

/**
 * Find a walkable cell within `radius` meters of (x, z) whose cover faces the threat and from
 * which the threat's eye cannot see the bot's head (verified with a ray).
 */
export function findCover(
  nav: NavGrid,
  world: CollisionWorld,
  x: number,
  z: number,
  threatEye: Vec3,
  radius = 15,
  avoidNear?: Vec3,
  opts: {
    /** Spots to skip (on fire). */
    reject?: (x: number, z: number) => boolean;
    /** Extra sight blockers (smoke) that also count as cover. */
    blocksSight?: (a: Vec3, b: Vec3) => boolean;
  } = {},
): CoverSpot | null {
  const gx0 = toCell(x);
  const gz0 = toCell(z);
  const rc = Math.ceil(radius / 0.5);
  const cands: { gx: number; gz: number; d: number; crouch: boolean }[] = [];
  for (let dz = -rc; dz <= rc; dz += 1) {
    for (let dx = -rc; dx <= rc; dx += 1) {
      const d2 = dx * dx + dz * dz;
      if (d2 > rc * rc) continue;
      const gx = gx0 + dx;
      const gz = gz0 + dz;
      const f = nav.flags(gx, gz);
      if (!(f & NavFlag.Walkable) || !(f & NavFlag.Reachable) || !(f & (NavFlag.CoverFull | NavFlag.CoverHalf))) continue;
      const cx = cellCenter(gx);
      const cz = cellCenter(gz);
      // Cover must face the threat: the direction towards it should be in the cover mask.
      const ang = Math.atan2(threatEye.z - cz, threatEye.x - cx);
      const dirIdx = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      const mask = nav.cover(gx, gz);
      if (!(mask & (1 << dirIdx)) && !(mask & (1 << ((dirIdx + 1) % 8))) && !(mask & (1 << ((dirIdx + 7) % 8)))) continue;
      const tdist = Math.hypot(threatEye.x - cx, threatEye.z - cz);
      if (tdist < 6) continue;
      if (avoidNear && Math.hypot(avoidNear.x - cx, avoidNear.z - cz) < 1.5) continue;
      if (opts.reject?.(cx, cz)) continue;
      cands.push({ gx, gz, d: Math.sqrt(d2) * 0.5, crouch: !(f & NavFlag.CoverFull) });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  let tests = 0;
  for (const c of cands) {
    if (tests++ > 14) break;
    const y = nav.floor(c.gx, c.gz);
    a.x = threatEye.x;
    a.y = threatEye.y;
    a.z = threatEye.z;
    b.x = cellCenter(c.gx);
    b.y = y + (c.crouch ? 1.05 : 1.6);
    b.z = cellCenter(c.gz);
    world.traceRay(tr, a, b, MASK_SHOT);
    if (tr.fraction < 0.98 || opts.blocksSight?.(a, b)) return { x: b.x, y, z: b.z, crouch: c.crouch };
  }
  return null;
}
