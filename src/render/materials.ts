import * as THREE from 'three';
import { Material, MATERIAL_COUNT } from '../world/gen/ChunkData';
import { makeMaterialMaps } from './textures';

/** Normal map strength per material (default 1). */
const NORMAL_SCALE: Partial<Record<number, number>> = {
  [Material.Asphalt]: 0.6,
  [Material.Plaster]: 0.8,
  [Material.Metal]: 1.2,
};

/** One shared Lambert material per world material id (textures are generated once). */
export class MaterialLibrary {
  readonly materials: THREE.MeshLambertMaterial[] = [];

  constructor(anisotropy: number) {
    const allMaps = makeMaterialMaps(anisotropy, (id, maps) => {
      // Same set of maps as the placeholders: no shader recompiles.
      const m = this.materials[id];
      for (const key of ['map', 'normalMap', 'emissiveMap'] as const) {
        const tex = maps[key];
        if (!tex || !m[key]) continue;
        m[key].dispose();
        m[key] = tex;
      }
    });
    for (let i = 0; i < MATERIAL_COUNT; i++) {
      const maps = allMaps[i];
      const m = new THREE.MeshLambertMaterial({ map: maps.map, vertexColors: true });
      if (maps.normalMap) {
        m.normalMap = maps.normalMap;
        m.normalScale.setScalar(NORMAL_SCALE[i] ?? 1);
      }
      if (maps.emissiveMap) {
        // Glow is driven at night by Atmosphere (see setNightGlow).
        m.emissiveMap = maps.emissiveMap;
        m.emissive.set('#ffffff');
        m.emissiveIntensity = 0;
      }
      this.materials.push(m);
    }
    // Water: see-through, and it doesn't hide what's under it from the depth buffer.
    const water = this.materials[Material.Water];
    water.transparent = true;
    water.opacity = 0.72;
    water.depthWrite = false;
  }

  /** Let the water drift (call every frame with the time in seconds). */
  animate(t: number): void {
    const map = this.materials[Material.Water].map;
    if (map) map.offset.set(t * 0.018, t * 0.007);
  }

  /** Lit windows, shopfronts and signs: `level` 0 (day) .. 1 (night), like the street lamps. */
  setNightGlow(level: number): void {
    this.materials[Material.Facade].emissiveIntensity = 0.04 + level * 1.1;
    this.materials[Material.CurtainWall].emissiveIntensity = 0.02 + level * 0.6;
  }

  get(id: number): THREE.MeshLambertMaterial {
    return this.materials[id] ?? this.materials[0];
  }

  dispose(): void {
    for (const m of this.materials) {
      m.map?.dispose();
      m.normalMap?.dispose();
      m.emissiveMap?.dispose();
      m.dispose();
    }
  }
}
