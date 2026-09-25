import * as THREE from 'three';
import { MATERIAL_COUNT } from '../world/gen/ChunkData';
import { EMISSIVE_MAPPED, NORMAL_MAPPED, PAINT_ORDER, paintMaterial, type PaintedMaps, type Pixels } from './texturePaint';

export interface MaterialMaps {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

function texture(p: Pixels, anisotropy: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(p.data, p.width, p.height);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  if (p.width > 1) {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }
  tex.needsUpdate = true;
  return tex;
}

const flat = (r: number, g: number, b: number): Pixels => ({ width: 1, height: 1, data: new Uint8Array([r, g, b, 255]) });

function toMaps(p: PaintedMaps, anisotropy: number): MaterialMaps {
  return {
    map: texture(p.map, anisotropy, true),
    normalMap: p.normalMap && texture(p.normalMap, anisotropy, false),
    emissiveMap: p.emissiveMap && texture(p.emissiveMap, anisotropy, true),
  };
}

/**
 * Every material's maps: 1x1 placeholders now (flat normal, no glow), then the painted maps
 * through `onPainted` as background workers finish them (the full set is a few seconds of CPU).
 * Which maps a material has is fixed up front, so swapping them never recompiles a shader.
 */
export function makeMaterialMaps(anisotropy: number, onPainted: (material: number, maps: MaterialMaps) => void): MaterialMaps[] {
  const all: MaterialMaps[] = [];
  for (let i = 0; i < MATERIAL_COUNT; i++) {
    all.push({
      map: texture(flat(170, 168, 162), anisotropy, true),
      normalMap: NORMAL_MAPPED.has(i) ? texture(flat(128, 128, 255), anisotropy, false) : undefined,
      emissiveMap: EMISSIVE_MAPPED.has(i) ? texture(flat(0, 0, 0), anisotropy, true) : undefined,
    });
  }
  const apply = (p: PaintedMaps) => onPainted(p.material, toMaps(p, anisotropy));
  // Main-thread fallback: one material per task, after the caller has its materials set up.
  const paintHere = (ids: readonly number[]) => {
    for (const id of ids) setTimeout(() => apply(paintMaterial(id)), 0);
  };
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    paintHere(PAINT_ORDER);
    return all;
  }
  // Two workers, interleaved so both start on the most visible materials.
  const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1));
  for (let k = 0; k < n; k++) {
    const ids = PAINT_ORDER.filter((_, i) => i % n === k);
    const done = new Set<number>();
    try {
      const w = new Worker(new URL('./texture.worker.ts', import.meta.url), { type: 'module', name: `textures-${k}` });
      w.onmessage = (e: MessageEvent<PaintedMaps | { material: number; error: string }>) => {
        const id = e.data.material;
        done.add(id);
        if ('error' in e.data) {
          console.error('texture paint failed', id, e.data.error);
          paintHere([id]);
        } else apply(e.data);
        if (done.size === ids.length) w.terminate();
      };
      w.onerror = () => {
        w.terminate();
        paintHere(ids.filter((id) => !done.has(id)));
      };
      w.postMessage(ids);
    } catch {
      paintHere(ids);
    }
  }
  return all;
}
