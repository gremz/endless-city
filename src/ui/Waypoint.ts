import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { el } from './dom';

/** Keep the marker this far inside the screen edge (NDC). */
const EDGE_X = 0.92;
const EDGE_Y = 0.85;

/**
 * The objective's waypoint: a diamond with the distance over the target, or an arrow on the
 * screen edge pointing the way when it's off screen or behind you.
 */
export class Waypoint {
  private root: HTMLDivElement;
  private mark: HTMLDivElement;
  private label: HTMLDivElement;
  private view = new THREE.Vector3();
  private ndc = new THREE.Vector3();
  private text = '';

  constructor(parent: HTMLElement) {
    this.mark = el('div.waypoint-mark');
    this.label = el('div.waypoint-dist');
    this.root = el('div.waypoint', {}, [this.mark, this.label]);
    this.root.hidden = true;
    parent.append(this.root);
  }

  update(camera: THREE.PerspectiveCamera, target: Vec3 | null): void {
    if (!target) {
      this.root.hidden = true;
      return;
    }
    const parent = this.root.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    this.view.set(target.x, target.y, target.z).applyMatrix4(camera.matrixWorldInverse);
    const behind = this.view.z > 0;
    this.ndc.copy(this.view).applyMatrix4(camera.projectionMatrix);
    let x = this.ndc.x;
    let y = this.ndc.y;
    if (behind) {
      // Projection mirrors points behind the camera; point along the view-space direction instead.
      x = this.view.x;
      y = Math.min(this.view.y, -Math.abs(this.view.x) * 0.2);
      if (!x && !y) y = -1;
    }
    const over = Math.max(Math.abs(x) / EDGE_X, Math.abs(y) / EDGE_Y);
    const edge = behind || over > 1;
    if (edge) {
      x /= over;
      y /= over;
    }
    const sx = (x * 0.5 + 0.5) * w;
    const sy = (-y * 0.5 + 0.5) * h;
    this.root.classList.toggle('edge', edge);
    if (edge) this.mark.style.setProperty('--edge-angle', `${Math.atan2(x, y).toFixed(3)}rad`);
    const dist = camera.position.distanceTo(this.view.set(target.x, target.y, target.z));
    const text = dist < 3 ? '' : `${Math.round(dist)} m`;
    if (text !== this.text) {
      this.text = text;
      this.label.textContent = text;
    }
    this.root.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
