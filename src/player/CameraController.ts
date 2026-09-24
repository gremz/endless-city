import type * as THREE from 'three';
import { lerp, vec3, wrapAngle } from '../core/math';
import { MASK_PLAYER, MASK_SHOT } from '../physics/brush';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { makeTrace } from '../physics/trace';
import type { Actor } from '../sim/Actor';
import type { Vehicle } from '../sim/vehicle/Vehicle';
import { eyeHeight } from './pmove';

/** Chase camera: distance behind the car, height of the point it orbits, and its pitch limits. */
const CHASE_DIST = 6.5;
const CHASE_PIVOT = 1.6;
export const CHASE_PITCH_MIN = -0.62;
export const CHASE_PITCH_MAX = 0.2;
/** Default downward tilt of the chase view (added to the mouse pitch). */
const CHASE_TILT = -0.14;
const CAM_HULL = 0.2;
const CAM_MINS = vec3(-CAM_HULL, -CAM_HULL, -CAM_HULL);
const CAM_MAXS = vec3(CAM_HULL, CAM_HULL, CAM_HULL);

/**
 * Places the camera at the interpolated eye position. View angles come straight from input
 * (not interpolated) so aiming has no added latency.
 */
export class CameraController {
  /** Extra view punch (radians), e.g. from recoil. */
  punchPitch = 0;
  punchYaw = 0;
  /** Extra vertical offset (landing dip), meters. */
  bobY = 0;
  readonly position = { x: 0, y: 0, z: 0 };
  private tr = makeTrace();
  private from = vec3();
  private to = vec3();

  update(camera: THREE.PerspectiveCamera, a: Actor, alpha: number, yaw: number, pitch: number): void {
    const m = a.move;
    this.position.x = lerp(a.prevPos.x, m.pos.x, alpha);
    this.position.y = lerp(a.prevPos.y, m.pos.y, alpha) + lerp(a.prevEye, eyeHeight(m), alpha) + this.bobY;
    this.position.z = lerp(a.prevPos.z, m.pos.z, alpha);
    camera.position.set(this.position.x, this.position.y, this.position.z);
    camera.rotation.set(pitch + this.punchPitch, yaw + this.punchYaw, 0, 'YXZ');
  }

  /**
   * Third-person view of a car: orbit the (interpolated) car at the mouse's yaw and pitch, pulled
   * in wherever a wall would come between the camera and the car.
   */
  chase(camera: THREE.PerspectiveCamera, v: Vehicle, alpha: number, yaw: number, pitch: number, world: CollisionWorld): void {
    const c = v.car;
    const from = this.from;
    from.x = lerp(v.prevPos.x, c.pos.x, alpha);
    from.y = lerp(v.prevPos.y, c.pos.y, alpha) + CHASE_PIVOT;
    from.z = lerp(v.prevPos.z, c.pos.z, alpha);
    const p = Math.max(CHASE_PITCH_MIN, Math.min(CHASE_PITCH_MAX, pitch)) + CHASE_TILT;
    const cp = Math.cos(p);
    // Behind = minus the view direction.
    const to = this.to;
    to.x = from.x + Math.sin(yaw) * cp * CHASE_DIST;
    to.y = from.y - Math.sin(p) * CHASE_DIST;
    to.z = from.z + Math.cos(yaw) * cp * CHASE_DIST;
    const ignore = world.ignoreOwner;
    world.ignoreOwner = v.id;
    world.traceBox(this.tr, from, to, CAM_MINS, CAM_MAXS, MASK_PLAYER | MASK_SHOT);
    world.ignoreOwner = ignore;
    const k = this.tr.startSolid ? 0 : this.tr.fraction;
    this.position.x = lerp(from.x, to.x, k);
    this.position.y = lerp(from.y, to.y, k);
    this.position.z = lerp(from.z, to.z, k);
    camera.position.set(this.position.x, this.position.y, this.position.z);
    camera.rotation.set(p, yaw, 0, 'YXZ');
  }

  /**
   * Ease the view yaw back behind a car that's driving forward (while the mouse is left alone).
   * Returns the new yaw.
   */
  static recenter(viewYaw: number, carYaw: number, forwardSpeed: number, dt: number): number {
    if (forwardSpeed < 3) return viewYaw;
    const rate = Math.min(1, dt * 2.2 * Math.min(1, (forwardSpeed - 3) / 6));
    return wrapAngle(viewYaw + wrapAngle(carYaw - viewYaw) * rate);
  }
}
