import * as THREE from 'three';
import { eyeHeight } from '../player/pmove';
import type { Actor } from '../sim/Actor';
import { el } from './dom';

interface Tag {
  root: HTMLDivElement;
  name: HTMLDivElement;
  fill: HTMLDivElement;
  text: string;
}

/** Tags stop shrinking past this distance, and fade out beyond the second. */
const NEAR = 6;
const FAR = 120;

/**
 * Names and health bars over teammates' heads (co-op). Shown through walls: knowing where your
 * friends are is the point.
 */
export class NameTags {
  private root: HTMLDivElement;
  private tags: Tag[] = [];
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root = el('div.nametags');
    parent.append(this.root);
  }

  update(camera: THREE.PerspectiveCamera, allies: readonly Actor[]): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    let n = 0;
    for (const a of allies) {
      const m = a.move.pos;
      this.v.set(m.x, m.y + eyeHeight(a.move) + 0.45, m.z);
      const dist = this.v.distanceTo(camera.position);
      this.v.project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2 || dist > FAR) continue;
      const tag = this.tags[n] ?? this.make();
      n++;
      const text = a.alive ? a.name : `${a.name} ✝`;
      if (tag.text !== text) {
        tag.text = text;
        tag.name.textContent = text;
      }
      tag.fill.style.width = `${Math.max(0, Math.min(100, a.health))}%`;
      tag.fill.classList.toggle('low', a.health <= 30);
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      const scale = Math.max(0.6, Math.min(1, NEAR / Math.max(NEAR, dist) + 0.4));
      tag.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(2)})`;
      tag.root.style.opacity = String(a.alive ? Math.min(1, 1.4 - dist / FAR) : 0.6);
      tag.root.hidden = false;
    }
    for (let i = n; i < this.tags.length; i++) this.tags[i].root.hidden = true;
  }

  private make(): Tag {
    const name = el('div.nametag-name');
    const fill = el('div.nametag-fill');
    const root = el('div.nametag', {}, [name, el('div.nametag-bar', {}, [fill])]);
    this.root.append(root);
    const tag = { root, name, fill, text: '' };
    this.tags.push(tag);
    return tag;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }
}
