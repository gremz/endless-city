import type * as THREE from 'three';
import { lerp } from '../core/math';
import type { Actor } from '../sim/Actor';
import { eyeHeight } from './pmove';

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

  update(camera: THREE.PerspectiveCamera, a: Actor, alpha: number, yaw: number, pitch: number): void {
    const m = a.move;
    this.position.x = lerp(a.prevPos.x, m.pos.x, alpha);
    this.position.y = lerp(a.prevPos.y, m.pos.y, alpha) + lerp(a.prevEye, eyeHeight(m), alpha) + this.bobY;
    this.position.z = lerp(a.prevPos.z, m.pos.z, alpha);
    camera.position.set(this.position.x, this.position.y, this.position.z);
    camera.rotation.set(pitch + this.punchPitch, yaw + this.punchYaw, 0, 'YXZ');
  }
}
